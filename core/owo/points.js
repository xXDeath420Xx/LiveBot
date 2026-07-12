// The OwO "points" counter: saying owo/uwu anywhere in a message earns one point.
// Mirrors upstream OwO's hidden `points` command — silent, 10s cooldown per user,
// incrementing a global user count and a per-guild count.
import pool from '../../utils/db.js';

export const POINT_COOLDOWN_MS = 10_000;

// userId -> last credited timestamp. Bounded by a sweep so a busy shard can't grow it forever.
const lastPoint = new Map();

function sweep() {
  const cutoff = Date.now() - POINT_COOLDOWN_MS;
  for (const [id, at] of lastPoint) if (at < cutoff) lastPoint.delete(id);
}

/** True when this user is off cooldown (and marks them as credited). */
export function claimPointSlot(userId, now = Date.now()) {
  const prev = lastPoint.get(userId);
  if (prev != null && now - prev < POINT_COOLDOWN_MS) return false;
  lastPoint.set(userId, now);
  if (lastPoint.size > 5000) sweep();
  return true;
}

/** Credit one point to the user (global), the guild, and the guild-member pair. */
export async function addPoint(guildId, userId, now = Date.now()) {
  await pool.execute(
    `INSERT INTO owo_points_user (user_id, count, last_at) VALUES (?, 1, ?)
     ON DUPLICATE KEY UPDATE count = count + 1, last_at = VALUES(last_at)`, [userId, now]);
  await pool.execute(
    `INSERT INTO owo_points_guild (guild_id, count) VALUES (?, 1)
     ON DUPLICATE KEY UPDATE count = count + 1`, [guildId]);
  await pool.execute(
    `INSERT INTO owo_points_member (guild_id, user_id, count) VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE count = count + 1`, [guildId, userId]);
}

export async function getCounts(guildId, userId) {
  const [[user]] = await pool.execute('SELECT count FROM owo_points_user WHERE user_id = ?', [userId]);
  const [[member]] = await pool.execute(
    'SELECT count FROM owo_points_member WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  const [[guild]] = await pool.execute('SELECT count FROM owo_points_guild WHERE guild_id = ?', [guildId]);
  const [[rank]] = await pool.execute(
    `SELECT COUNT(*) + 1 AS rank FROM owo_points_member
     WHERE guild_id = ? AND count > COALESCE((SELECT count FROM owo_points_member WHERE guild_id = ? AND user_id = ?), 0)`,
    [guildId, guildId, userId]);
  return {
    global: Number(user?.count || 0),
    server: Number(member?.count || 0),
    guildTotal: Number(guild?.count || 0),
    rank: Number(rank?.rank || 1),
  };
}

export async function getTop(guildId, limit = 10) {
  const [rows] = await pool.execute(
    'SELECT user_id, count FROM owo_points_member WHERE guild_id = ? ORDER BY count DESC LIMIT ?',
    [guildId, String(limit)]);
  return rows.map(r => ({ userId: r.user_id, count: Number(r.count) }));
}
