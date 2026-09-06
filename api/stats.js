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
    return json(res, 200, {
      totalPairs: sess.rows[0].total,
      onlineNow,
      today: today.rows[0].n,
      botOnline: onlineNow > 0,
      premiumMode: (await getSetting('premiumMode')) === 'true',
      keysLeft: keys.rows[0].n,
      notice: (await getSetting('notice')) || '',
    });
  } catch (e) {
    console.error('[stats]', e.message);
    return json(res, 500, { error: e.message });
  }
};
