// GET /api/stats  – status dashboard numbers (same shape the old site used).
const { query, getSetting } = require('./_db');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();

  try {
    const [sess, keys, today] = await Promise.all([
      query('SELECT count(*)::int AS total, count(*) FILTER (WHERE status = \'connected\')::int AS online FROM varnox_sessions'),
      query('SELECT count(*)::int AS n FROM varnox_premium_keys WHERE status = \'unused\''),
      query("SELECT count(*)::int AS n FROM varnox_pairing_requests WHERE created_at::date = current_date"),
    ]);
    const onlineNow = sess.rows[0].online;
    // Server 1..3 heartbeat status (offline when last ping > 2 minutes ago).
    let servers = [];
    try {
      const hb = await query(
        'SELECT server_id, name, last_seen FROM varnox_server_heartbeats ORDER BY server_id'
      );
      const now = Date.now();
      const seen = new Map(hb.rows.map((r) => [Number(r.server_id), r]));
      servers = [1, 2, 3].map((i) => {
        const r = seen.get(i);
        const last = r && r.last_seen ? new Date(r.last_seen).getTime() : 0;
        return { id: i, name: (r && r.name) || 'Server ' + i, online: now - last < 120000 };
      });
    } catch (e) {
      // heartbeat table not ready yet -> treat all as offline
    }
    return json(res, 200, {
      totalPairs: sess.rows[0].total,
      onlineNow,
      today: today.rows[0].n,
      botOnline: onlineNow > 0,
      servers,
      premiumMode: (await getSetting('premiumMode')) === 'true',
      keysLeft: keys.rows[0].n,
      notice: (await getSetting('notice')) || '',
    });
  } catch (e) {
    console.error('[stats]', e.message);
    return json(res, 500, { error: e.message });
  }
};
