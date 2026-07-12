/*
 * OwO pet levels — CC-BY-NC-SA-4.0 derivative. See /LICENSE-OWO-NOTICE.md.
 *
 * An animal's level comes from the XP it has accumulated as a team pet (hunts feed the active
 * team — see manager.js `giveTeamXp`). Upstream's curve, unchanged:
 *
 *   xp to go from level n-1 to n  =  5000 + (n * 7)^2
 *
 * so the cost climbs quadratically and a level-26 pet is worth roughly 200k XP. This is what the
 * battle roster's "L. 26" is showing.
 */

/** XP needed to climb from `lvl - 1` to `lvl`. */
export const xpRequired = (lvl) => 5000 + Math.pow(lvl * 7, 2);

/** @returns {{level: number, currentxp: number, maxxp: number}} */
export function getLevel(xp = 0) {
  let remaining = Math.max(0, Number(xp) || 0);
  let level = 0;
  let required = xpRequired(level + 1);
  while (remaining > required) {
    remaining -= required;
    level++;
    required = xpRequired(level + 1);
  }
  return { level, currentxp: remaining, maxxp: required };
}

/**
 * The least XP that actually reads back as `lvl`. Inverse of getLevel, for imports.
 *
 * The `+ 1` is load-bearing: getLevel advances on `xp > required`, strictly, so a pet holding
 * exactly the cumulative cost of level 26 reads back as level 25.
 */
export function xpForLevel(lvl) {
  let total = 0;
  for (let n = 1; n <= lvl; n++) total += xpRequired(n);
  return total + 1;
}
