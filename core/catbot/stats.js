/* Cat Bot — inventory, catalogue and leaderboard queries. Clean-room. */
import pool from '../../utils/db.js';
import { CAT_TYPES, TYPE_WEIGHTS, valueOf, probabilityOf } from './constants.js';

// Rarity -> score, expressed as SQL so the Value board is one aggregate.
// Types come from our own constant list, never user input.
const VALUE_CASE = 'CASE cat_type ' +
  CAT_TYPES.map(t => `WHEN ${pool.escape(t)} THEN ${valueOf(t)}`).join(' ') + ' ELSE 0 END';

export async function getInventory(guildId, userId) {
  const [rows] = await pool.execute(
    'SELECT cat_type, count FROM catbot_catches WHERE guild_id = ? AND user_id = ? AND count > 0',
    [guildId, userId]);
  const byType = new Map(rows.map(r => [r.cat_type, Number(r.count)]));
  const cats = CAT_TYPES.map(t => ({ type: t, count: byType.get(t) || 0 }));
  const total = cats.reduce((s, c) => s + c.count, 0);
  const value = cats.reduce((s, c) => s + c.count * valueOf(c.type), 0);
  return { cats, total, value, distinct: cats.filter(c => c.count > 0).length };
}

export async function getProfile(guildId, userId) {
  const [[row]] = await pool.execute(
    'SELECT total_catches, fastest_ms, slowest_ms, last_catch_at FROM catbot_profiles WHERE guild_id = ? AND user_id = ?',
    [guildId, userId]);
  return row || null;
}

/** kind: 'cats' | 'value' | 'fast' | 'slow' */
export async function getLeaderboard(guildId, kind = 'cats', limit = 10) {
  if (kind === 'cats' || kind === 'value') {
    const order = kind === 'value' ? 'value' : 'cats';
    const [rows] = await pool.execute(
      `SELECT user_id, SUM(count) AS cats, SUM(count * (${VALUE_CASE})) AS value
         FROM catbot_catches WHERE guild_id = ?
        GROUP BY user_id HAVING cats > 0
        ORDER BY ${order} DESC, user_id ASC LIMIT ?`,
      [guildId, String(limit)]);
    return rows.map(r => ({ userId: r.user_id, cats: Number(r.cats), value: Number(r.value) }));
  }

  const col = kind === 'fast' ? 'fastest_ms' : 'slowest_ms';
  const dir = kind === 'fast' ? 'ASC' : 'DESC';
  const [rows] = await pool.execute(
    `SELECT user_id, ${col} AS ms FROM catbot_profiles
      WHERE guild_id = ? AND ${col} IS NOT NULL
      ORDER BY ${col} ${dir} LIMIT ?`,
    [guildId, String(limit)]);
  return rows.map(r => ({ userId: r.user_id, ms: Number(r.ms) }));
}

export function getCatalogue() {
  return CAT_TYPES.map(t => ({
    type: t,
    weight: TYPE_WEIGHTS[t],
    chance: probabilityOf(t) * 100,
    value: valueOf(t),
  }));
}

/** Does this user hold at least one of every type? (prism craft requirement) */
export async function canCraftPrism(guildId, userId) {
  const { cats } = await getInventory(guildId, userId);
  const missing = cats.filter(c => c.count < 1).map(c => c.type);
  return { ok: missing.length === 0, missing };
}

export async function craftPrism(guildId, userId, name) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Spend one of every type; the WHERE count>0 guard makes this safe under concurrency.
    for (const type of CAT_TYPES) {
      const [r] = await conn.execute(
        'UPDATE catbot_catches SET count = count - 1 WHERE guild_id = ? AND user_id = ? AND cat_type = ? AND count > 0',
        [guildId, userId, type]);
      if (r.affectedRows !== 1) { await conn.rollback(); return { ok: false, missing: type }; }
    }
    await conn.execute(
      'INSERT INTO catbot_prisms (guild_id, creator_id, name, created_at) VALUES (?, ?, ?, ?)',
      [guildId, userId, name, Date.now()]);
    await conn.commit();
    return { ok: true };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function getPrisms(guildId) {
  const [rows] = await pool.execute(
    'SELECT id, creator_id, name, created_at, catches_boosted FROM catbot_prisms WHERE guild_id = ? ORDER BY created_at',
    [guildId]);
  return rows;
}
