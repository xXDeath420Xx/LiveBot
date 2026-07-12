/*
 * Cat Bot packs. Clean-room; see /LICENSE-CATBOT-NOTICE.md.
 *
 * Packs drop occasionally on a catch and hold a bundle of cats. Better packs roll from a
 * narrower, rarer slice of the tier list — so a Cosmic pack can't hand you a Fine cat.
 */
import pool from '../../utils/db.js';
import { CAT_TYPES, TYPE_WEIGHTS, rollCatType } from './constants.js';

/**
 * `minTier` is an index into CAT_TYPES: the pack only rolls that tier or better.
 * `drop` is the per-catch chance of receiving one.
 */
export const PACKS = Object.freeze([
  { id: 'paper', name: 'Paper Pack', emoji: '📄', cats: 3, minTier: 0, drop: 0.040 },
  { id: 'cloth', name: 'Cloth Pack', emoji: '🧵', cats: 4, minTier: 2, drop: 0.020 },
  { id: 'wooden', name: 'Wooden Pack', emoji: '🪵', cats: 5, minTier: 4, drop: 0.010 },
  { id: 'silver', name: 'Silver Pack', emoji: '🥈', cats: 5, minTier: 7, drop: 0.005 },
  { id: 'golden', name: 'Golden Pack', emoji: '🥇', cats: 6, minTier: 10, drop: 0.002 },
  { id: 'cosmic', name: 'Cosmic Pack', emoji: '🌌', cats: 6, minTier: 13, drop: 0.0005 },
]);

export const PACK_IDS = PACKS.map(p => p.id);
export function getPack(id) { return PACKS.find(p => p.id === id) || null; }

/** Weighted pick restricted to `minTier` and above. */
export function rollFromPack(pack, rng = Math.random) {
  const pool_ = CAT_TYPES.slice(pack.minTier);
  const total = pool_.reduce((s, t) => s + TYPE_WEIGHTS[t], 0);
  let r = rng() * total;
  for (const type of pool_) {
    r -= TYPE_WEIGHTS[type];
    if (r < 0) return type;
  }
  return pool_[pool_.length - 1];
}

/**
 * Roll for a pack drop after a catch. At most one pack per catch — richest tier first,
 * so a lucky roll gives the Cosmic pack rather than stacking every pack it qualified for.
 * `luck` is the Lucky Paws catnip value: 0.5 means +50% on every pack's drop rate.
 */
export function rollPackDrop(rng = Math.random, luck = 0) {
  const scale = 1 + Math.max(0, luck);
  for (const pack of [...PACKS].reverse()) {
    if (rng() < pack.drop * scale) return pack;
  }
  return null;
}

export async function grantPack(guildId, userId, packId, n = 1) {
  await pool.execute(
    `INSERT INTO catbot_packs (guild_id, user_id, pack_type, count) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE count = count + VALUES(count)`, [guildId, userId, packId, n]);
}

export async function getPacks(guildId, userId) {
  const [rows] = await pool.execute(
    'SELECT pack_type, count FROM catbot_packs WHERE guild_id = ? AND user_id = ? AND count > 0',
    [guildId, userId]);
  const owned = new Map(rows.map(r => [r.pack_type, Number(r.count)]));
  return PACKS.map(p => ({ ...p, count: owned.get(p.id) || 0 }));
}

/**
 * Open one pack. The `count > 0` guard makes the spend atomic, so two concurrent opens
 * can't both consume the last pack.
 * @returns {Promise<{ok:boolean, cats?:string[], reason?:string}>}
 */
export async function openPack(guildId, userId, packId, rng = Math.random) {
  const pack = getPack(packId);
  if (!pack) return { ok: false, reason: 'unknown' };

  const [spend] = await pool.execute(
    'UPDATE catbot_packs SET count = count - 1 WHERE guild_id = ? AND user_id = ? AND pack_type = ? AND count > 0',
    [guildId, userId, packId]);
  if (spend.affectedRows !== 1) return { ok: false, reason: 'none' };

  const cats = Array.from({ length: pack.cats }, () => rollFromPack(pack, rng));
  for (const type of cats) {
    await pool.execute(
      `INSERT INTO catbot_catches (guild_id, user_id, cat_type, count) VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE count = count + 1`, [guildId, userId, type]);
  }
  await pool.execute(
    `INSERT INTO catbot_profiles (guild_id, user_id, total_catches, packs_opened)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE total_catches = total_catches + VALUES(total_catches),
                             packs_opened = packs_opened + 1`,
    [guildId, userId, cats.length]);

  return { ok: true, cats, pack };
}

export { rollCatType };
