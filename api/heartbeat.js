// POST /api/heartbeat  { server: 1|2|3, name?: 'Server 1' }
// Each Varnox bot host pings this endpoint every ~30-60s to mark itself ONLINE.
// If a server stops pinging for 2 minutes the dashboard shows it OFFLINE.
const { query } = require('./_db');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();

  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed. Use POST.' });

  let body = {};
  try { body = JSON.parse(req.body || '{}'); } catch (_) { body = {}; }

  const server = Number(body.server);
  if (!Number.isInteger(server) || server < 1 || server > 3) {
    return json(res, 400, { error: 'server must be 1, 2 or 3' });
  }
  const name = String(body.name || '').trim() || 'Server ' + server;

  try {
    await query(
      `INSERT INTO varnox_server_heartbeats (server_id, name, last_seen)
       VALUES ($1, $2, now())
       ON CONFLICT (server_id) DO UPDATE SET last_seen = now(), name = EXCLUDED.name`,
      [server, name]
    );
    return json(res, 200, { ok: true, server, at: new Date().toISOString() });
  } catch (e) {
    console.error('[heartbeat]', e.message);
    return json(res, 500, { error: e.message });
  }
};
