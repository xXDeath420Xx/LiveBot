/*
 * Grow a Tree — data + game rules.
 *
 * Two gates make the game social rather than a solo clicker:
 *   1. you may not water twice in a row — someone else has to go between;
 *   2. a growth cooldown that lengthens as the tree gets taller.
 *
 * The water itself is a single conditional UPDATE, so two people pressing 💧 at the same
 * instant can't both grow the tree.
 */
import pool from '../../utils/db.js';
import { newTree, grow } from './tiles.js';
import {
  getWateringInterval, getTreeXp, applyXp, canBeWateredAt, backgroundForSize,
} from './formulas.js';

export const NAME_RE = /^[a-zA-Z0-9\-' ]{1,36}$/;
const nowSec = () => Math.floor(Date.now() / 1000);

function hydrate(row) {
  if (!row) return null;
  return {
    guildId: row.guild_id,
    name: row.name,
    size: Number(row.size),
    pieces: typeof row.pieces === 'string' ? JSON.parse(row.pieces) : row.pieces,
    background: row.background,
    lastWateredBy: row.last_watered_by,
    lastWateredAt: Number(row.last_watered_at),
    plantedBy: row.planted_by,
  };
}

export async function getTree(guildId) {
  const [[row]] = await pool.execute('SELECT * FROM gat_trees WHERE guild_id = ?', [guildId]);
  return hydrate(row);
}

export const MAX_PLANT_HEIGHT = 10_000;

/**
 * Plant this server's tree.
 *
 * `height` carries a tree over from elsewhere instead of starting from a sapling. It cannot just
 * set `size`: every growth and cooldown calculation reads `pieces.length`, and the next water
 * writes `size = pieces.length`, so a tree with `size = 190` and three pieces would silently
 * collapse back to 3ft the first time somebody watered it. So we generate a real trunk of that
 * many segments, and the tree simply continues.
 *
 * `lastWateredBy` preserves whose turn it is — the no-self-water rule means that person still has
 * to wait for someone else, exactly as they would have on the tree we are replacing.
 */
export async function plantTree(guildId, userId, name, rng = Math.random, opts = {}) {
  if (!NAME_RE.test(name)) return { ok: false, reason: 'name' };
  const existing = await getTree(guildId);
  if (existing) return { ok: false, reason: 'exists', tree: existing };

  const height = Math.trunc(Number(opts.height) || 0);
  if (height && (height < 3 || height > MAX_PLANT_HEIGHT)) return { ok: false, reason: 'height' };

  let pieces = newTree(rng);
  while (height && pieces.length < height) pieces = grow(pieces, rng);

  const background = backgroundForSize(pieces.length, 'Ground');
  const lastWateredBy = opts.lastWateredBy ?? null;

  // `last_watered_at = 0` leaves the tree READY, which is the honest handover state: it really is
  // 190ft and it really is somebody else's turn. Stamping "watered just now" instead would put it
  // mid-cooldown, and since the displayed height interpolates UP toward `size`, a 190ft tree would
  // greet everyone as 189ft until the cooldown ran out.
  const lastWateredAt = 0;

  const [r] = await pool.execute(
    `INSERT IGNORE INTO gat_trees
       (guild_id, name, size, pieces, background, planted_by, last_watered_by, last_watered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [guildId, name, pieces.length, JSON.stringify(pieces), background, userId, lastWateredBy, lastWateredAt]);
  if (r.affectedRows !== 1) return { ok: false, reason: 'exists' };
  return { ok: true, tree: await getTree(guildId) };
}

export async function renameTree(guildId, name) {
  if (!NAME_RE.test(name)) return { ok: false, reason: 'name' };
  const [r] = await pool.execute('UPDATE gat_trees SET name = ? WHERE guild_id = ?', [name, guildId]);
  return { ok: r.affectedRows === 1 };
}

export async function removeTree(guildId) {
  await pool.execute('DELETE FROM gat_contributors WHERE guild_id = ?', [guildId]);
  const [r] = await pool.execute('DELETE FROM gat_trees WHERE guild_id = ?', [guildId]);
  return r.affectedRows > 0;
}

/**
 * Water the tree.
 * @returns {Promise<{ok:boolean, reason?:string, tree?:object, gainedXp?:number,
 *                    level?:number, levelsGained?:number, nextWaterAt?:number}>}
 *   reason: 'none' (no tree) | 'self' (you watered last) | 'cooldown'
 */
export async function waterTree(guildId, userId, rng = Math.random) {
  const tree = await getTree(guildId);
  if (!tree) return { ok: false, reason: 'none' };

  if (tree.lastWateredBy === userId) {
    return { ok: false, reason: 'self', tree };
  }
  const ready = canBeWateredAt(tree);
  if (ready > nowSec()) {
    return { ok: false, reason: 'cooldown', tree, nextWaterAt: ready };
  }

  const pieces = grow(tree.pieces, rng);
  const size = pieces.length;
  const background = backgroundForSize(size, tree.background);
  const at = nowSec();

  // Guard on the state we read: whoever's UPDATE lands first wins the water.
  const [r] = await pool.execute(
    `UPDATE gat_trees
        SET pieces = ?, size = ?, background = ?, last_watered_by = ?, last_watered_at = ?
      WHERE guild_id = ? AND size = ? AND last_watered_at = ?`,
    [JSON.stringify(pieces), size, background, userId, at, guildId, tree.size, tree.lastWateredAt]);
  if (r.affectedRows !== 1) return { ok: false, reason: 'cooldown', tree, nextWaterAt: canBeWateredAt(tree) };

  await pool.execute(
    `INSERT INTO gat_contributors (guild_id, user_id, count) VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE count = count + 1`, [guildId, userId]);

  const gainedXp = getTreeXp(size);
  const player = await getPlayer(userId);
  const next = applyXp(player.level, player.xp, gainedXp);
  await pool.execute(
    `INSERT INTO gat_players (user_id, level, xp, waters) VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE level = VALUES(level), xp = VALUES(xp), waters = waters + 1`,
    [userId, next.level, next.xp]);

  const grown = { ...tree, pieces, size, background, lastWateredBy: userId, lastWateredAt: at };
  return {
    ok: true, tree: grown, gainedXp,
    level: next.level, levelsGained: next.levelsGained,
    nextWaterAt: at + getWateringInterval(size - 1),
  };
}

export async function getPlayer(userId) {
  const [[row]] = await pool.execute(
    'SELECT level, xp, notify_xp, waters FROM gat_players WHERE user_id = ?', [userId]);
  return row
    ? { level: Number(row.level), xp: Number(row.xp), notifyXp: !!row.notify_xp, waters: Number(row.waters) }
    : { level: 1, xp: 0, notifyXp: false, waters: 0 };
}

export async function setNotifyXp(userId, on) {
  await pool.execute(
    `INSERT INTO gat_players (user_id, notify_xp) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE notify_xp = VALUES(notify_xp)`, [userId, on ? 1 : 0]);
}

/** This guild's waterers, most waters first. */
export async function getGardeners(guildId, limit = 10, offset = 0) {
  const [rows] = await pool.execute(
    `SELECT user_id, count FROM gat_contributors WHERE guild_id = ?
      ORDER BY count DESC, user_id ASC LIMIT ? OFFSET ?`,
    [guildId, String(limit), String(offset)]);
  return rows.map(r => ({ userId: r.user_id, count: Number(r.count) }));
}

export async function getContribution(guildId, userId) {
  const [[row]] = await pool.execute(
    'SELECT count FROM gat_contributors WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  if (!row) return { count: 0, rank: null };
  const [[rank]] = await pool.execute(
    'SELECT COUNT(*) + 1 AS r FROM gat_contributors WHERE guild_id = ? AND count > ?',
    [guildId, row.count]);
  return { count: Number(row.count), rank: Number(rank.r) };
}

/** Tallest trees across every server. */
export async function getForest(limit = 10, offset = 0) {
  const [rows] = await pool.execute(
    `SELECT guild_id, name, size, background FROM gat_trees
      ORDER BY size DESC, guild_id ASC LIMIT ? OFFSET ?`, [String(limit), String(offset)]);
  return rows.map(r => ({ guildId: r.guild_id, name: r.name, size: Number(r.size), background: r.background }));
}

export async function getForestRank(guildId) {
  const [[row]] = await pool.execute('SELECT size FROM gat_trees WHERE guild_id = ?', [guildId]);
  if (!row) return null;
  const [[rank]] = await pool.execute('SELECT COUNT(*) + 1 AS r FROM gat_trees WHERE size > ?', [row.size]);
  return Number(rank.r);
}

/** Global player levels. */
export async function getTopPlayers(limit = 10, offset = 0) {
  const [rows] = await pool.execute(
    `SELECT user_id, level, xp FROM gat_players ORDER BY level DESC, xp DESC, user_id ASC LIMIT ? OFFSET ?`,
    [String(limit), String(offset)]);
  return rows.map(r => ({ userId: r.user_id, level: Number(r.level), xp: Number(r.xp) }));
}
