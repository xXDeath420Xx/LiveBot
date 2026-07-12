/*
 * OwO daily drops — CC-BY-NC-SA-4.0 derivative. See /LICENSE-OWO-NOTICE.md.
 *
 * The `[n/3] RESETS IN: 6H 7M 39S` mechanic behind both the lootbox (dropped by `owo hunt`) and
 * the weapon crate (dropped by `owo battle`). Upstream's rules, kept exactly:
 *
 *   • The window resets at MIDNIGHT, not 24h after the last drop. The counter shown is how many
 *     you have taken since the last midnight, and the timer counts down to the next one.
 *   • The FIRST eligible action after a reset always drops (upstream forces the roll to 0).
 *     After that it is a flat 5% per action.
 *   • Three per day, hard cap.
 *
 * That "first one is free" rule is not incidental — it is why someone who hunts once a day still
 * reliably gets a lootbox, and dropping it would quietly make the game much stingier.
 */
import pool from '../../utils/db.js';

export const DROP_CHANCE = 0.05;
export const DAILY_MAX = 3;

/**
 * Time left until midnight, and whether `since` falls before the most recent one.
 * @param {Date|string|null} since  the stored `claim` timestamp, if any
 */
export function afterMidnight(since) {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const nextMidnight = new Date(midnight.getTime() + 86_400_000);

  let left = Math.trunc((nextMidnight - now) / 1000);
  const seconds = left % 60;
  left = Math.trunc(left / 60);
  const minutes = left % 60;
  const hours = Math.trunc(left / 60);

  // No record at all, or the record predates today's midnight -> the window has rolled over.
  const after = !since || new Date(since) < midnight;
  return { after, hours, minutes, seconds, midnight };
}

export const resetsIn = ({ hours, minutes, seconds }) => `${hours}H ${minutes}M ${seconds}S`;

/**
 * Decide whether this hunt/battle drops something, and book it if so.
 *
 * @param {'lootbox'|'crate'} kind
 * @returns {Promise<{dropped: boolean, count?: number, resets?: string}>}
 */
export async function rollDailyDrop(kind, guildId, userId) {
  const isBox = kind === 'lootbox';
  const [[row]] = isBox
    ? await pool.execute(
      'SELECT claimcount, claim FROM owo_lootbox WHERE guild_id = ? AND id = ?', [guildId, userId])
    : await pool.execute(
      'SELECT claimcount, claim FROM owo_crate WHERE guild_id = ? AND uid = ? AND cratetype = 0', [guildId, userId]);

  const reset = afterMidnight(row?.claim);
  const fresh = !row || reset.after;

  // Already had today's three.
  if (!fresh && Number(row.claimcount) >= DAILY_MAX) return { dropped: false };

  // First one after a reset is guaranteed; everything after it is a 5% roll.
  if (!fresh && Math.random() > DROP_CHANCE) return { dropped: false };

  const count = fresh ? 1 : Number(row.claimcount) + 1;

  if (isBox) {
    await pool.execute(
      `INSERT INTO owo_lootbox (guild_id, id, boxcount, claimcount, claim)
       VALUES (?, ?, 1, 1, NOW())
       ON DUPLICATE KEY UPDATE
         boxcount   = boxcount + 1,
         claimcount = IF(?, 1, claimcount + 1),
         claim      = IF(?, NOW(), claim)`,
      [guildId, userId, fresh ? 1 : 0, fresh ? 1 : 0]);
  } else {
    await pool.execute(
      `INSERT INTO owo_crate (guild_id, uid, cratetype, boxcount, claimcount, claim)
       VALUES (?, ?, 0, 1, 1, NOW())
       ON DUPLICATE KEY UPDATE
         boxcount   = boxcount + 1,
         claimcount = IF(?, 1, claimcount + 1),
         claim      = IF(?, NOW(), claim)`,
      [guildId, userId, fresh ? 1 : 0, fresh ? 1 : 0]);
  }

  return { dropped: true, count, resets: resetsIn(reset) };
}
