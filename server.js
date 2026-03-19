// PollSpace - server.js
// Serves BOTH the frontend (index.html) and the API from the same origin.
// This eliminates all CORS issues since there is no cross-origin request.
//
// File structure expected on Render:
//   server.js
//   package.json
//   public/
//     index.html
//
// Environment variables to set in Render dashboard:
//   DATABASE_URL  -> your Render Internal Database URL (auto-linked)
//   PORT          -> set automatically by Render, do not touch

const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Serve static frontend files from the /public folder
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Auto-create tables on first boot
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

// Helper: fetch one poll with options + vote counts
async function queryPollById(id) {
  const { rows } = await pool.query(`
    SELECT
      p.id, p.question, p.description, p.created_at,
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

// ── API ROUTES ────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (e) {
    res.status(503).json({ status: 'error', message: e.message });
  }
});

app.get('/api/polls', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.id, p.question, p.description, p.created_at,
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
    console.error('GET /polls:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/polls/:id', async (req, res) => {
  try {
    const poll = await queryPollById(req.params.id);
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    res.json(poll);
  } catch (e) {
    console.error('GET /polls/:id:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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
      `INSERT INTO polls (question, description) VALUES ($1, $2)
       RETURNING id, question, description, created_at`,
      [question.trim(), description.trim()]
    );
    const insertedOptions = [];
    for (const text of options) {
      const { rows: [opt] } = await client.query(
        `INSERT INTO poll_options (poll_id, option_text) VALUES ($1, $2)
         RETURNING id, option_text`,
        [poll.id, text.trim()]
      );
      insertedOptions.push({ ...opt, vote_count: 0 });
    }
    await client.query('COMMIT');
    res.status(201).json({ ...poll, options: insertedOptions });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /polls:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/api/polls/:id/vote', async (req, res) => {
  const { option_id } = req.body;
  const voter_ip = (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress || 'unknown'
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
    console.error('POST /vote:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/polls/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM polls WHERE id = $1 RETURNING id`, [req.params.id]
    );
    if (!result.rows.length)
      return res.status(404).json({ error: 'Poll not found' });
    res.json({ success: true, deleted: req.params.id });
  } catch (e) {
    console.error('DELETE /polls:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Catch-all: serve index.html for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start
initSchema()
  .then(() => {
    app.listen(PORT, () => console.log('PollSpace running on port ' + PORT));
  })
  .catch(err => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });
