const express = require('express')
const cors    = require('cors')
const path    = require('path')
const { Pool } = require('pg')

const app  = express()
const PORT = process.env.PORT || 3001

// ── Database ────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
})

// ── Middleware ───────────────────────────────────────────────────────
app.use(cors())
app.use(express.json())

// ── DB Init ──────────────────────────────────────────────────────────
// Creates tables if they don't exist yet
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL,
      plan       TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS team_goals (
      id      SERIAL PRIMARY KEY,
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      month   TEXT NOT NULL,
      goal    NUMERIC DEFAULT 0,
      stretch NUMERIC DEFAULT 0,
      UNIQUE(team_id, month)
    );

    CREATE TABLE IF NOT EXISTS reps (
      id      SERIAL PRIMARY KEY,
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      name    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rep_data (
      id     SERIAL PRIMARY KEY,
      rep_id INTEGER REFERENCES reps(id) ON DELETE CASCADE,
      month  TEXT NOT NULL,
      actual NUMERIC DEFAULT 0,
      goal   NUMERIC,
      stretch NUMERIC,
      UNIQUE(rep_id, month)
    );

    CREATE TABLE IF NOT EXISTS rep_crm (
      id          SERIAL PRIMARY KEY,
      rep_id      INTEGER REFERENCES reps(id) ON DELETE CASCADE,
      month       TEXT NOT NULL,
      plan        TEXT DEFAULT '',
      next_action TEXT DEFAULT '',
      notes       TEXT DEFAULT '',
      UNIQUE(rep_id, month)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id       SERIAL PRIMARY KEY,
      rep_id   INTEGER REFERENCES reps(id) ON DELETE CASCADE,
      month    TEXT NOT NULL,
      week_id  TEXT NOT NULL,
      text     TEXT NOT NULL,
      done     BOOLEAN DEFAULT FALSE,
      rep_note TEXT DEFAULT ''
    );
  `)
  console.log('Database ready')
}

// ── Routes ───────────────────────────────────────────────────────────

// GET all data for the app
app.get('/api/data', async (req, res) => {
  try {
    const teams      = await pool.query('SELECT * FROM teams ORDER BY id')
    const teamGoals  = await pool.query('SELECT * FROM team_goals')
    const reps       = await pool.query('SELECT * FROM reps ORDER BY id')
    const repData    = await pool.query('SELECT * FROM rep_data')
    const repCrm     = await pool.query('SELECT * FROM rep_crm')
    const tasks      = await pool.query('SELECT * FROM tasks ORDER BY id')
    res.json({ teams: teams.rows, teamGoals: teamGoals.rows, reps: reps.rows, repData: repData.rows, repCrm: repCrm.rows, tasks: tasks.rows })
  } catch (e) {
    console.error(e); res.status(500).json({ error: e.message })
  }
})

// SAVE entire app state (full upsert)
app.post('/api/save', async (req, res) => {
  const { teams } = req.body
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const t of teams) {
      // Upsert team
      await client.query(
        `INSERT INTO teams (id, name, color, plan) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET name=$2, color=$3, plan=$4`,
        [t.id, t.name, t.color, t.plan || '']
      )
      // Upsert team goals per month
      for (const [month, goal] of Object.entries(t.teamGoals || {})) {
        const stretch = t.teamStretch?.[month] || 0
        await client.query(
          `INSERT INTO team_goals (team_id, month, goal, stretch) VALUES ($1,$2,$3,$4)
           ON CONFLICT (team_id, month) DO UPDATE SET goal=$3, stretch=$4`,
          [t.id, month, goal, stretch]
        )
      }
      // Upsert reps
      for (const r of t.reps || []) {
        await client.query(
          `INSERT INTO reps (id, team_id, name) VALUES ($1,$2,$3)
           ON CONFLICT (id) DO UPDATE SET name=$3, team_id=$2`,
          [r.id, t.id, r.name]
        )
        // Upsert rep data per month
        for (const [month, actual] of Object.entries(r.data || {})) {
          const goal    = r.goals?.[month]   ?? null
          const stretch = r.stretch?.[month] ?? null
          await client.query(
            `INSERT INTO rep_data (rep_id, month, actual, goal, stretch) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (rep_id, month) DO UPDATE SET actual=$3, goal=$4, stretch=$5`,
            [r.id, month, actual, goal, stretch]
          )
        }
        // Upsert CRM per month
        for (const [month, crm] of Object.entries(r.crm || {})) {
          await client.query(
            `INSERT INTO rep_crm (rep_id, month, plan, next_action, notes) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (rep_id, month) DO UPDATE SET plan=$3, next_action=$4, notes=$5`,
            [r.id, month, crm.plan||'', crm.nextAction||'', crm.notes||'']
          )
          // Delete old tasks for this rep+month then reinsert
          await client.query('DELETE FROM tasks WHERE rep_id=$1 AND month=$2', [r.id, month])
          for (const task of crm.tasks || []) {
            await client.query(
              `INSERT INTO tasks (rep_id, month, week_id, text, done, rep_note) VALUES ($1,$2,$3,$4,$5,$6)`,
              [r.id, month, task.week, task.text, task.done, task.repNote||'']
            )
          }
        }
      }
    }
    await client.query('COMMIT')
    res.json({ ok: true })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e); res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

// Team CRUD
app.delete('/api/teams/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM teams WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Rep CRUD
app.delete('/api/reps/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM reps WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Serve React build in production ──────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dist')))
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'))
  })
}

// ── Start ─────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
})
