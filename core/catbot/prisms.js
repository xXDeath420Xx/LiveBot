/*
 * Cat Bot prisms — the prestige loop. Clean-room; see /LICENSE-CATBOT-NOTICE.md.
 *
 * A prism costs one of every cat type. Owning them gives a per-guild chance that a caught
 * cat is upgraded to the next rarity tier, so a server's collective grind slowly makes
 * everyone's catches better. Rolling an upgrade past the rarest tier triggers a cat rain.
 */
import pool from '../../utils/db.js';
import { upgradeType, prismGlobalBoost, prismUserBoost, CAT_TYPES } from './constants.js';

/** @returns {{total:number, own:number}} prism counts for a guild / user. */
export async function prismCounts(guildId, userId) {
  const [[row]] = await pool.execute(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN creator_id = ? THEN 1 ELSE 0 END) AS own
       FROM catbot_prisms WHERE guild_id = ?`, [userId, guildId]);
  return { total: Number(row?.total || 0), own: Number(row?.own || 0) };
}

/**
 * The chance a catch is upgraded. Grows with the guild's prisms, and faster with the
 * ones you made yourself. A value above 1 means a guaranteed upgrade plus a chance at a
 * second tier.
 */
export function boostFor({ total, own }) {
  if (!total) return 0;
  return prismUserBoost(total, own);
}

/**
 * Apply the prism boost to a freshly caught cat.
 * @returns {{type: string, tiers: number, overflow: boolean}}
 *   tiers    — how many rarity steps it climbed (0 = untouched)
 *   overflow — an upgrade rolled past the rarest tier; the caller should start a rain
 */
export function applyBoost(type, boost, rng = Math.random) {
  let tiers = 0, overflow = false, current = type;

  // Whole part = guaranteed upgrades; fractional part = one extra chance.
  let budget = boost;
  while (budget > 0) {
    const guaranteed = budget >= 1;
    if (!guaranteed && rng() >= budget) break;
    budget -= 1;

    const next = upgradeType(current);
    if (!next) { overflow = true; break; } // already the rarest cat there is
    current = next;
    tiers++;
  }
  return { type: current, tiers, overflow };
}

/**
 * Roll the boost for this catch, using the guild's live prism count.
 * `extraBoost` folds in catnip perks (prism_focus, night_vision), which upgrade a tier the
 * same way a prism does — so someone with no prisms can still get one from catnip alone.
 */
export async function boostCatch(guildId, userId, type, rng = Math.random, extraBoost = 0) {
  const counts = await prismCounts(guildId, userId);
  const boost = boostFor(counts) + Math.max(0, extraBoost);
  if (boost <= 0) return { type, tiers: 0, overflow: false, boost: 0, prisms: counts.total };
  const result = applyBoost(type, boost, rng);
  if (counts.total && (result.tiers > 0 || result.overflow)) await creditBoost(guildId);
  return { ...result, boost, prisms: counts.total };
}

/** Attribute the boost to a random prism in the guild, for flavour on `/cat prism`. */
async function creditBoost(guildId) {
  await pool.execute(
    `UPDATE catbot_prisms SET catches_boosted = catches_boosted + 1
      WHERE guild_id = ? ORDER BY RAND() LIMIT 1`, [guildId]).catch(() => {});
}

export async function listPrisms(guildId) {
  const [rows] = await pool.execute(
    `SELECT id, creator_id, name, created_at, catches_boosted
       FROM catbot_prisms WHERE guild_id = ? ORDER BY created_at`, [guildId]);
  return rows;
}

/** For `/cat prism` when the user has none: what are they missing? */
export async function prismProgress(guildId, userId) {
  const [rows] = await pool.execute(
    'SELECT cat_type FROM catbot_catches WHERE guild_id = ? AND user_id = ? AND count > 0',
    [guildId, userId]);
  const have = new Set(rows.map(r => r.cat_type));
  const missing = CAT_TYPES.filter(t => !have.has(t));
  return { have: have.size, need: CAT_TYPES.length, missing };
}

export { prismGlobalBoost };
