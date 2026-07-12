/*
 * OwO lootboxes — CC-BY-NC-SA-4.0 derivative. See /LICENSE-OWO-NOTICE.md.
 *
 * A lootbox is dropped by hunting (see daily-drop.js) and opened for a gem.
 */
import pool from '../../utils/db.js';
import { grantRolled } from './gems-service.js';

export const MAX_OPEN_AT_ONCE = 100;

export async function count(guildId, userId) {
  const [[row]] = await pool.execute(
    'SELECT boxcount FROM owo_lootbox WHERE guild_id = ? AND id = ?', [guildId, userId]);
  return Number(row?.boxcount ?? 0);
}

/**
 * Open `n` lootboxes and bank what falls out.
 *
 * The boxes are spent with a guarded UPDATE (`boxcount >= n`) rather than a read-then-write, so
 * two `owo lb all` in flight at once cannot open the same box twice.
 *
 * @returns {Promise<{error?: string, opened?: number, gems?: Array<{gem, count}>}>}
 */
export async function open(guildId, userId, n = 1) {
  const want = Math.min(Math.max(1, Math.trunc(n)), MAX_OPEN_AT_ONCE);

  const [spent] = await pool.execute(
    `UPDATE owo_lootbox SET boxcount = boxcount - ?
     WHERE guild_id = ? AND id = ? AND boxcount >= ?`,
    [want, guildId, userId, want]);

  if (spent.affectedRows !== 1) {
    const have = await count(guildId, userId);
    return have > 0
      ? { error: `You only have **${have}** lootbox${have === 1 ? '' : 'es'}!` }
      : { error: "You don't have any lootboxes!" };
  }

  return { opened: want, gems: await grantRolled(guildId, userId, want) };
}

/** `all` — open everything, capped. Returns 0 if there is nothing to open. */
export async function openAll(guildId, userId) {
  const have = await count(guildId, userId);
  if (have <= 0) return { error: "You don't have any lootboxes!" };
  return open(guildId, userId, Math.min(have, MAX_OPEN_AT_ONCE));
}
