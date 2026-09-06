// POST /api/admin  { action, password?, ... }  or GET /api/admin?action=...
// Actions: login | stats | sessions | keys | generate_key | set_notice | set_premium
// Protected by ADMIN_PASSWORD env var (sent as X-Admin-Password header or body.password).
const { query, getSetting, setSetting, switchActiveDatabase, activeUrl } = require('./_db');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (Buffer.isBuffer(b)) { try { return JSON.parse(b.toString('utf8') || '{}'); } catch { return {}; } }
  if (typeof b === 'string') { try { return JSON.parse(b || '{}'); } catch { return {}; } }
  if (typeof b === 'object') return b;
  return {};
}

function authOK(req, body) {
  const adminPw = process.env.ADMIN_PASSWORD || '';
  if (!adminPw) return false;
  const supplied = String(req.headers['x-admin-password'] || body.password || '');
  return supplied === adminPw;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
  if (req.method === 'OPTIONS') return res.end();

  const body = req.method === 'POST'
    ? Object.assign({}, readBody(req), req.query || {})
    : (req.query || {});
  const action = String(body.action || '');

  // login is the only action allowed without a header
  if (action === 'login') {
    if (!authOK(req, body)) return json(res, 401, { error: 'Incorrect admin password.' });
    return json(res, 200, { success: true });
  }

  if (!authOK(req, body)) return json(res, 401, { error: 'Unauthorized. Login first.' });

  try {
    switch (action) {
      case 'stats': {
        const [sess, keys] = await Promise.all([
          query('SELECT count(*)::int AS total, count(*) FILTER (WHERE status = \'connected\')::int AS online FROM varnox_sessions'),
          query('SELECT count(*)::int AS n FROM varnox_premium_keys WHERE status = \'unused\''),
        ]);
        return json(res, 200, {
          totalSessions: sess.rows[0].total,
          onlineNow: sess.rows[0].online,
          keysLeft: keys.rows[0].n,
          premiumMode: (await getSetting('premiumMode')) === 'true',
          notice: (await getSetting('notice')) || '',
        });
      }

      case 'sessions': {
        const { rows } = await query(
          'SELECT id, phone, status, updated_at FROM varnox_sessions ORDER BY updated_at DESC LIMIT 100'
        );
        return json(res, 200, { sessions: rows });
      }

      case 'keys': {
        const { rows } = await query(
          'SELECT id, key, status, used_phone, used_at, created_at FROM varnox_premium_keys ORDER BY id DESC LIMIT 100'
        );
        return json(res, 200, { keys: rows });
      }

      case 'generate_key': {
        const rand = (n) => Array.from({ length: n }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');
        const newKey = `VN-${rand(4)}-${rand(4)}`;
        await query('INSERT INTO varnox_premium_keys (key, status) VALUES ($1, $2)', [newKey, 'unused']);
        return json(res, 200, { key: newKey });
      }

      case 'set_notice': {
        await setSetting('notice', String(body.notice || ''));
        return json(res, 200, { success: true, notice: String(body.notice || '') });
      }

      case 'set_premium': {
        await setSetting('premiumMode', body.enabled ? 'true' : 'false');
        return json(res, 200, { success: true, premiumMode: !!body.enabled });
      }

      case 'current_db': {
        const url = await activeUrl();
        let host = url;
        try { host = new URL(url).host; } catch (_) { /* ignore */ }
        return json(res, 200, { success: true, url, host });
      }

      case 'switch_db': {
        const url = await switchActiveDatabase(String(body.url || '').trim());
        return json(res, 200, { success: true, url });
      }

      default:
        return json(res, 400, { error: 'Unknown action.' });
    }
  } catch (e) {
    console.error('[admin]', e.message);
    return json(res, 500, { error: e.message });
  }
};
