// PollSpace - server.js
// Serves frontend from /public and API from /api
// Same-origin setup eliminates all CORS issues

const express = require('express');
const { Pool } = require('pg');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Database ──────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ── Schema init ───────────────────────────────────────────────
// Each table created in its own query so errors are isolated
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
    console.log('polls table ready');

    await client.query(`
      CREATE TABLE IF NOT EXISTS poll_options (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        poll_id     UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        option_text TEXT NOT NULL
      )
    `);
    console.log('poll_options table ready');

    await client.query(`
      CREATE TABLE IF NOT EXISTS poll_votes (
        id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        poll_id   UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        option_id UUID NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
        voter_ip  TEXT,
        voted_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('poll_votes table ready');

  } catch (err) {
    console.error('Schema init error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ── Helpers ───────────────────────────────────────────────────

// Build poll object from separate queries — avoids json_agg complexity
async function buildPoll(pollRow) {
  const { rows: options } = await pool.query(
    `SELECT
       po.id,
       po.option_text,
       COUNT(pv.id)::int AS vote_count
     FROM poll_options po
     LEFT JOIN poll_votes pv ON pv.option_id = po.id
     WHERE po.poll_id = $1
     GROUP BY po.id
     ORDER BY po.id`,
    [pollRow.id]
  );
  return {
    id:          pollRow.id,
    question:    pollRow.question,
    description: pollRow.description,
    created_at:  pollRow.created_at,
    options,
  };
}

// ── Routes ────────────────────────────────────────────────────

// Health check — ping from UptimeRobot every 5 min to prevent sleep
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (e) {
    console.error('Health check failed:', e.message);
    res.status(503).json({ status: 'error', message: e.message });
  }
});

// GET /api/polls
app.get('/api/polls', async (req, res) => {
  try {
    const { rows: pollRows } = await pool.query(
      `SELECT id, question, description, created_at
       FROM polls
       ORDER BY created_at DESC`
    );
    const polls = await Promise.all(pollRows.map(buildPoll));
    res.json(polls);
  } catch (e) {
    console.error('GET /api/polls error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/polls/:id
app.get('/api/polls/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, question, description, created_at
       FROM polls WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Poll not found' });
    const poll = await buildPoll(rows[0]);
    res.json(poll);
  } catch (e) {
    console.error('GET /api/polls/:id error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/polls
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
    console.error('POST /api/polls error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /api/polls/:id/vote
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
    console.error('POST /api/vote error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/polls/:id
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
    console.error('DELETE /api/polls error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Catch-all: serve index.html for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────
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
