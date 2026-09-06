// Dynamic database layer for the VARNOX pairing portal.
// The site always keeps a CONTROL pool on the original DATABASE_URL env DB;
// the ACTIVE database can be switched at runtime from the admin panel by
// storing the desired connection string in the control DB settings row
// (key: active_database_url). No Vercel redeploy needed.
const { Pool } = require('pg');

const PREFIX = 'varnox_';
const CONTROL_URL = String(process.env.DATABASE_URL || '');

function makePool(url) {
  return new Pool({
    connectionString: String(url).split('?')[0],
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    max: 3,
  });
}

const controlPool = CONTROL_URL ? makePool(CONTROL_URL) : null;
const poolCache = new Map(); // activeUrl -> Pool

function poolFor(url) {
  if (!poolCache.has(url)) poolCache.set(url, makePool(url));
  return poolCache.get(url);
}

// Minimal schema to auto-create when switching to an empty database.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${PREFIX}pairing_requests (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  pairing_code TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes')
);
CREATE TABLE IF NOT EXISTS ${PREFIX}sessions (
  id TEXT PRIMARY KEY,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${PREFIX}premium_keys (
  id BIGSERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused',
  used_phone TEXT,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${PREFIX}settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

async function readControl() {
  if (!controlPool) throw new Error('DATABASE_URL is not set on this deployment.');
  return controlPool;
}

// Ensure a database has the portal schema + control row, returns pool.
async function ensureTarget(url) {
  const pool = poolFor(url);
  await pool.query(SCHEMA_SQL);
  await pool.query(
    `INSERT INTO ${PREFIX}settings (key, value) VALUES ('active_database_url', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [url]
  );
  return pool;
}

// Resolve the ACTIVE database URL (control DB settings row, fallback env).
async function activeUrl() {
  const control = await readControl();
  try {
    const { rows } = await control.query(
      `SELECT value FROM ${PREFIX}settings WHERE key = 'active_database_url'`
    );
    if (rows[0] && rows[0].value) return rows[0].value;
  } catch (e) {
    // control table missing -> try to self-heal on env DB
    try { await ensureTarget(CONTROL_URL); return CONTROL_URL; } catch (_) { /* ignore */ }
  }
  return CONTROL_URL;
}

async function query(text, params) {
  const pool = poolFor(await activeUrl());
  return pool.query(text, params);
}

async function getSetting(key) {
  const { rows } = await query(`SELECT value FROM ${PREFIX}settings WHERE key = $1`, [key]);
  return rows[0] ? rows[0].value : null;
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO ${PREFIX}settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}

async function switchActiveDatabase(newUrl) {
  if (!/^postgres(ql)?:\/\//i.test(String(newUrl || ''))) {
    throw new Error('Invalid connection string.');
  }
  const url = String(newUrl).trim();
  await ensureTarget(url); // validate + create schema if empty
  const control = await readControl();
  await control.query(
    `INSERT INTO ${PREFIX}settings (key, value) VALUES ('active_database_url', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [url]
  );
  return url;
}

module.exports = { pool: null, controlPool, query, getSetting, setSetting, switchActiveDatabase, activeUrl, ensureTarget };
