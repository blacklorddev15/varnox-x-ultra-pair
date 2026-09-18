// POST /api/admin  { action, password?, ... }  or GET /api/admin?action=...
// Actions: login | stats | sessions | keys | generate_key | set_notice | set_premium
//          | current_db | switch_db | servers | reset_heartbeats | redeploy
// Protected by ADMIN_PASSWORD env var (sent as X-Admin-Password header or body.password).
const {
  query,
  getSetting,
  setSetting,
  switchActiveDatabase,
  activeUrl,
  ensureActiveSchema,
} = require('./_db');

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

// Never hand back a usable credential: the password is replaced with dots. This endpoint
// used to return the whole connection string, which gave a working database credential to
// anyone who could reach the admin. The sibling portals already mask it; this brings this
// one into line. The password is not needed to identify a database.
function maskUrl(url) {
  const m = String(url || '').match(/^(postgres(?:ql)?:\/\/[^:]+:)[^@]+@(.*)$/i);
  return m ? `${m[1]}\u2022\u2022\u2022\u2022@${m[2]}` : '';
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
    await ensureActiveSchema();
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

      // Removes ONE paired user. This only clears the database row: revoking the WhatsApp
      // link itself is the bot's job (/delpair), which also deletes ./sessions/<id>.
      case 'delete_session': {
        const id = String(body.id == null ? '' : body.id).trim().slice(0, 200);
        if (!id) return json(res, 400, { error: 'Missing session id.' });
        const { rows } = await query(
          'DELETE FROM varnox_sessions WHERE id = $1 RETURNING id', [id]
        );
        if (!rows.length) return json(res, 404, { error: 'No such session.' });
        return json(res, 200, { success: true, deleted: rows[0].id });
      }

      // Bulk path for rows the bot has already logged out. The predicate is exactly
      // "disconnected", so a session that is still linked can never be deleted here.
      // Pass { dryRun: true } to get the count without deleting anything.
      case 'clear_sessions': {
        if (body.dryRun) {
          const { rows } = await query(
            "SELECT count(*)::int AS n FROM varnox_sessions WHERE LOWER(status) = 'disconnected'"
          );
          return json(res, 200, { success: true, dryRun: true, wouldClear: rows[0].n });
        }
        const { rows } = await query(
          "DELETE FROM varnox_sessions WHERE LOWER(status) = 'disconnected' RETURNING id"
        );
        return json(res, 200, { success: true, cleared: rows.length });
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
        let host = '';
        let database = '';
        try {
          const parsed = new URL(url);
          host = parsed.host;
          database = parsed.pathname.replace(/^\//, '');
        } catch (_) { /* ignore */ }
        // Host, database name and a masked string only -- never the raw connection string.
        //
        // controlHost is the CONTROL database (process.env.DATABASE_URL): what every cold
        // start bootstraps from, and what the site falls back to when the stored pointer
        // cannot be read. When it differs from the active database, or when it is the
        // suspended one, that is the first fact worth seeing.
        let controlHost = '';
        try { controlHost = new URL(String(process.env.DATABASE_URL || '')).host; }
        catch (_) { /* ignore */ }
        return json(res, 200, { success: true, host, database, urlMasked: maskUrl(url), controlHost });
      }

      case 'switch_db': {
        const url = await switchActiveDatabase(String(body.url || '').trim());
        let host = '';
        try { host = new URL(url).host; } catch (_) { /* ignore */ }
        return json(res, 200, { success: true, host, urlMasked: maskUrl(url) });
      }

      case 'servers': {
        const { rows } = await query(
          'SELECT server_id, name, last_seen FROM varnox_server_heartbeats ORDER BY server_id'
        );
        return json(res, 200, { servers: rows });
      }

      // Clear every server heartbeat so the dashboard starts from a clean slate.
      case 'reset_heartbeats': {
        await query(`UPDATE varnox_server_heartbeats SET last_seen = now() - interval '1 hour'`);
        return json(res, 200, { success: true });
      }

      // Rebuild the current production deployment.
      //
      // Vercel only applies environment variables on a NEW build, so changing DATABASE_URL
      // does nothing until something rebuilds. That rebuild is the one step that otherwise
      // forces a trip to the dashboard, which is exactly what this button exists to avoid.
      //
      // Redeploying by deploymentId inherits every setting from that build - environment
      // variables included - which is what is wanted here. See:
      // https://vercel.com/docs/rest-api/deployments/create-a-new-deployment
      case 'redeploy': {
        if (typeof fetch !== 'function') {
          return json(res, 200, {
            success: false,
            message: 'This deployment is running a Node runtime without fetch; needs Node 18+.',
          });
        }
        const token = String(process.env.VERCEL_API_TOKEN || '').trim();
        const project = String(process.env.PROJECT_ID || process.env.VERCEL_PROJECT_ID || '').trim();
        const team = String(process.env.TEAM_ID || process.env.VERCEL_TEAM_ID || '').trim();
        if (!token || !project) {
          return json(res, 200, {
            success: false,
            message: 'Redeploy needs VERCEL_API_TOKEN and PROJECT_ID set on this deployment.',
          });
        }
        const auth = { Authorization: `Bearer ${token}` };
        const teamQ = team ? `&teamId=${encodeURIComponent(team)}` : '';

        const listRes = await fetch(
          `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(project)}`
          + `&target=production&limit=1${teamQ}`,
          { headers: auth }
        );
        const list = await listRes.json();
        if (!listRes.ok) {
          return json(res, 200, {
            success: false,
            message: 'Vercel: ' + ((list.error && list.error.message) || listRes.status),
          });
        }
        const latest = (list.deployments || [])[0];
        if (!latest) {
          return json(res, 200, { success: false, message: 'No production deployment found to rebuild.' });
        }

        const createRes = await fetch(
          `https://api.vercel.com/v13/deployments${team ? `?teamId=${encodeURIComponent(team)}` : ''}`,
          {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
            body: JSON.stringify({
              name: latest.name,
              deploymentId: latest.uid,
              target: 'production',
            }),
          }
        );
        const created = await createRes.json();
        if (!createRes.ok) {
          return json(res, 200, {
            success: false,
            message: 'Vercel: ' + ((created.error && created.error.message) || createRes.status),
          });
        }
        return json(res, 200, {
          success: true,
          message: 'Rebuild started — the site stays up while it builds.',
          url: created.url ? `https://${created.url}` : '',
        });
      }

      default:
        return json(res, 400, { error: 'Unknown action.' });
    }
  } catch (e) {
    console.error('[admin]', e.message);
    return json(res, 500, { error: e.message });
  }
};
