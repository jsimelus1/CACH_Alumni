// PollSpace - server.js
// Render-ready: PostgreSQL + Web Service on one platform
//
// Environment variables to set in Render dashboard:
//   DATABASE_URL  -> paste your Render Internal Database URL
//                    (Render sets this automatically if you link a DB)
//   PORT          -> set automatically by Render, do not touch
//
// Deploy steps:
//   1. Push server.js + package.json to GitHub
//   2. Create a Render PostgreSQL database (free tier)
//   3. Create a Render Web Service pointing to your repo
//   4. Add DATABASE_URL env var (Internal Database URL from step 2)
//   5. Build command: npm install   |   Start command: node server.js

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// -----------------------------------------------------------------
// CORS - open to all origins so any frontend can call this API.
// This is the fix for "Failed to fetch" errors from Netlify.
// Once you go to production, replace '*' with your exact domain:
//   app.use(cors({ origin: 'https://mypollapp.netlify.app' }));
// -----------------------------------------------------------------
app.use(cors({ origin: '*' }));

// Handle preflight OPTIONS requests sent by browsers before POST/DELETE
app.options('*', cors({ origin: '*' }));

app.use(express.json());

// -----------------------------------------------------------------
// DATABASE - Render Postgres requires SSL with rejectUnauthorized false
// -----------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// -----------------------------------------------------------------
// AUTO SCHEMA - creates tables on first boot, safe to run repeatedly
// -----------------------------------------------------------------
async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS polls (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        question    TEXT NOT NULL,
        description TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS poll_options (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        poll_id     UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        option_text TEXT NOT NULL
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS poll_votes (
        id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        poll_id   UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        option_id UUID NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
        voter_ip  TEXT,
        voted_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('Database schema ready');
  } catch (err) {
    console.error('Schema init failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// -----------------------------------------------------------------
// HELPER - fetch one poll with all options and vote counts
// -----------------------------------------------------------------
async function queryPollById(id) {
  const { rows } = await pool.query(`
    SELECT
      p.id,
      p.question,
      p.description,
      p.created_at,
      COALESCE(
        json_agg(
          json_build_object(
            'id',          po.id,
            'option_text', po.option_text,
            'vote_count',  COUNT(pv.id)
          ) ORDER BY po.id
        ) FILTER (WHERE po.id IS NOT NULL),
        '[]'::json
      ) AS options
    FROM polls p
    LEFT JOIN poll_options po ON po.poll_id = p.id
    LEFT JOIN poll_votes   pv ON pv.option_id = po.id
    WHERE p.id = $1
    GROUP BY p.id
  `, [id]);
  return rows[0] || null;
}

// -----------------------------------------------------------------
// ROUTES
// -----------------------------------------------------------------

// Root route - fixes "Cannot GET /" error when opening Render URL
app.get('/', (req, res) => {
  res.json({
    name: 'PollSpace API',
    status: 'running',
    endpoints: {
      health:     'GET  /api/health',
      listPolls:  'GET  /api/polls',
      getPoll:    'GET  /api/polls/:id',
      createPoll: 'POST /api/polls',
      vote:       'POST /api/polls/:id/vote',
      deletePoll: 'DELETE /api/polls/:id',
    }
  });
});

// Health check - ping this from UptimeRobot every 5 min to prevent sleep
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (e) {
    res.status(503).json({ status: 'error', message: e.message });
  }
});

// GET /api/polls - list all polls with options and vote counts
app.get('/api/polls', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.id,
        p.question,
        p.description,
        p.created_at,
        COALESCE(
          json_agg(
            json_build_object(
              'id',          po.id,
              'option_text', po.option_text,
              'vote_count',  COUNT(pv.id)
            ) ORDER BY po.id
          ) FILTER (WHERE po.id IS NOT NULL),
          '[]'::json
        ) AS options
      FROM polls p
      LEFT JOIN poll_options po ON po.poll_id = p.id
      LEFT JOIN poll_votes   pv ON pv.option_id = po.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error('GET /polls error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/polls/:id - single poll (refreshed after voting)
app.get('/api/polls/:id', async (req, res) => {
  try {
    const poll = await queryPollById(req.params.id);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    res.json(poll);
  } catch (e) {
    console.error('GET /polls/:id error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/polls - create a new poll
// Body: { question: string, description?: string, options: string[] }
app.post('/api/polls', async (req, res) => {
  const { question, description = '', options } = req.body;

  if (!question || !question.trim())
    return res.status(400).json({ error: 'Question is required' });
  if (!Array.isArray(options) || options.length < 2)
    return res.status(400).json({ error: 'At least 2 options are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [poll] } = await client.query(
      `INSERT INTO polls (question, description)
       VALUES ($1, $2)
       RETURNING id, question, description, created_at`,
      [question.trim(), description.trim()]
    );

    const insertedOptions = [];
    for (const text of options) {
      const { rows: [opt] } = await client.query(
        `INSERT INTO poll_options (poll_id, option_text)
         VALUES ($1, $2)
         RETURNING id, option_text`,
        [poll.id, text.trim()]
      );
      insertedOptions.push({ ...opt, vote_count: 0 });
    }

    await client.query('COMMIT');
    res.status(201).json({ ...poll, options: insertedOptions });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /polls error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /api/polls/:id/vote - cast a vote (one per IP per poll)
// Body: { option_id: string }
app.post('/api/polls/:id/vote', async (req, res) => {
  const { option_id } = req.body;
  const voter_ip = (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );

  if (!option_id)
    return res.status(400).json({ error: 'option_id is required' });

  try {
    const dup = await pool.query(
      `SELECT id FROM poll_votes WHERE poll_id = $1 AND voter_ip = $2`,
      [req.params.id, voter_ip]
    );
    if (dup.rows.length)
      return res.status(409).json({ error: 'You have already voted on this poll' });

    await pool.query(
      `INSERT INTO poll_votes (poll_id, option_id, voter_ip) VALUES ($1, $2, $3)`,
      [req.params.id, option_id, voter_ip]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('POST /vote error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/polls/:id - remove a poll and all its data
app.delete('/api/polls/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM polls WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length)
      return res.status(404).json({ error: 'Poll not found' });
    res.json({ success: true, deleted: req.params.id });
  } catch (e) {
    console.error('DELETE /polls error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------------------------------------------
// START
// -----------------------------------------------------------------
initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log('PollSpace running on port ' + PORT);
    });
  })
  .catch(err => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });
