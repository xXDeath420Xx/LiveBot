/*
 * Catnip perks — a loadout that rolls on every catch. Clean-room; our own perks and
 * numbers. See /LICENSE-CATBOT-NOTICE.md.
 *
 * Perks are bought once with Cat Coins and levelled up. Only ACTIVE_SLOTS of them apply
 * at a time, so choosing a loadout is the interesting decision.
 */
import pool from '../../utils/db.js';
import { addCoins, spendCoins, getWallet } from './economy.js';

export const MAX_LEVEL = 5;
export const ACTIVE_SLOTS = 3;

/**
 * `value(level)` is the perk's effect at that level.
 * `cost(level)` is what it costs to buy level `level` (so cost(1) buys it outright).
 */
export const PERKS = Object.freeze([
  {
    id: 'twin_cats', name: 'Twin Cats', emoji: '👯',
    description: 'Chance to catch a second cat of the same type.',
    value: lvl => 0.04 * lvl,           // 4% → 20%
    cost: lvl => 250 * lvl,
    format: v => `${(v * 100).toFixed(0)}% chance of a bonus cat`,
  },
  {
    id: 'lucky_paws', name: 'Lucky Paws', emoji: '🍀',
    description: 'Improves your chance of finding a pack.',
    value: lvl => 0.5 * lvl,            // multiplies pack drop rates
    cost: lvl => 300 * lvl,
    format: v => `+${(v * 100).toFixed(0)}% pack drop rate`,
  },
  {
    id: 'prism_focus', name: 'Prism Focus', emoji: '🔮',
    description: 'Adds to the prism upgrade chance on your catches.',
    value: lvl => 0.03 * lvl,
    cost: lvl => 400 * lvl,
    format: v => `+${(v * 100).toFixed(0)}% upgrade chance`,
  },
  {
    id: 'coin_purse', name: 'Coin Purse', emoji: '💰',
    description: 'Earn more Cat Coins from every catch.',
    value: lvl => 0.15 * lvl,
    cost: lvl => 200 * lvl,
    format: v => `+${(v * 100).toFixed(0)}% coins`,
  },
  {
    id: 'rainmaker', name: 'Rainmaker', emoji: '🌧️',
    description: 'Small chance a catch starts a cat rain.',
    value: lvl => 0.002 * lvl,
    cost: lvl => 600 * lvl,
    format: v => `${(v * 100).toFixed(1)}% chance of rain`,
  },
  {
    id: 'night_vision', name: 'Night Vision', emoji: '🌙',
    description: 'Chance to upgrade a caught cat a rarity tier, without a prism.',
    value: lvl => 0.015 * lvl,
    cost: lvl => 500 * lvl,
    format: v => `${(v * 100).toFixed(1)}% tier upgrade`,
  },
]);

export const PERK_IDS = PERKS.map(p => p.id);
export function getPerk(id) { return PERKS.find(p => p.id === id) || null; }
export function perkCost(perk, nextLevel) { return perk.cost(nextLevel); }

// ── Storage ──────────────────────────────────────────────────────────────────

export async function getLoadout(guildId, userId) {
  const [rows] = await pool.execute(
    'SELECT perk_id, level, active FROM catbot_catnip WHERE guild_id = ? AND user_id = ?',
    [guildId, userId]);
  const owned = new Map(rows.map(r => [r.perk_id, { level: r.level, active: !!r.active }]));
  return PERKS.map(p => ({
    ...p,
    level: owned.get(p.id)?.level ?? 0,
    active: owned.get(p.id)?.active ?? false,
  }));
}

/** Only the active perks, as { id -> value } at their level. */
export async function activeEffects(guildId, userId) {
  const [rows] = await pool.execute(
    'SELECT perk_id, level FROM catbot_catnip WHERE guild_id = ? AND user_id = ? AND active = 1',
    [guildId, userId]);
  const effects = {};
  for (const r of rows) {
    const perk = getPerk(r.perk_id);
    if (perk) effects[perk.id] = perk.value(r.level);
  }
  return effects;
}

/** Buy a perk, or level it up. Spends coins atomically. */
export async function buyPerk(guildId, userId, perkId) {
  const perk = getPerk(perkId);
  if (!perk) return { ok: false, reason: 'unknown' };

  const [[row]] = await pool.execute(
    'SELECT level FROM catbot_catnip WHERE guild_id = ? AND user_id = ? AND perk_id = ?',
    [guildId, userId, perkId]);
  const current = row?.level ?? 0;
  if (current >= MAX_LEVEL) return { ok: false, reason: 'maxed' };

  const nextLevel = current + 1;
  const cost = perkCost(perk, nextLevel);
  const wallet = await getWallet(guildId, userId);
  if (wallet.coins < cost) return { ok: false, reason: 'poor', cost, coins: wallet.coins };
  if (!await spendCoins(guildId, userId, cost)) return { ok: false, reason: 'poor', cost, coins: wallet.coins };

  await pool.execute(
    `INSERT INTO catbot_catnip (guild_id, user_id, perk_id, level, active) VALUES (?, ?, ?, 1, 0)
     ON DUPLICATE KEY UPDATE level = level + 1`,
    [guildId, userId, perkId]);

  return { ok: true, perk, level: nextLevel, cost };
}

export async function setActive(guildId, userId, perkId, active) {
  const perk = getPerk(perkId);
  if (!perk) return { ok: false, reason: 'unknown' };

  const [[row]] = await pool.execute(
    'SELECT level FROM catbot_catnip WHERE guild_id = ? AND user_id = ? AND perk_id = ?',
    [guildId, userId, perkId]);
  if (!row) return { ok: false, reason: 'unowned' };

  if (active) {
    const [[{ n }]] = await pool.execute(
      'SELECT COUNT(*) AS n FROM catbot_catnip WHERE guild_id = ? AND user_id = ? AND active = 1 AND perk_id <> ?',
      [guildId, userId, perkId]);
    if (n >= ACTIVE_SLOTS) return { ok: false, reason: 'full', slots: ACTIVE_SLOTS };
  }

  await pool.execute(
    'UPDATE catbot_catnip SET active = ? WHERE guild_id = ? AND user_id = ? AND perk_id = ?',
    [active ? 1 : 0, guildId, userId, perkId]);
  return { ok: true, perk, active };
}

/** Refund a perk for half of everything paid into it. */
export async function refundPerk(guildId, userId, perkId) {
  const perk = getPerk(perkId);
  if (!perk) return { ok: false, reason: 'unknown' };
  const [[row]] = await pool.execute(
    'SELECT level FROM catbot_catnip WHERE guild_id = ? AND user_id = ? AND perk_id = ?',
    [guildId, userId, perkId]);
  if (!row) return { ok: false, reason: 'unowned' };

  let paid = 0;
  for (let l = 1; l <= row.level; l++) paid += perkCost(perk, l);
  const refund = Math.floor(paid / 2);

  await pool.execute(
    'DELETE FROM catbot_catnip WHERE guild_id = ? AND user_id = ? AND perk_id = ?', [guildId, userId, perkId]);
  await addCoins(guildId, userId, refund);
  return { ok: true, refund, perk };
}
