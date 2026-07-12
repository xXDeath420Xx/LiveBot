/*
 * Grow a Tree — the numbers. Ported from ssMMiles/grow-a-tree-discord (MIT).
 *
 * One tree per guild. Anyone can water it, but never twice in a row, and only once the
 * cooldown has elapsed. Each water adds exactly one foot.
 */

// Sizes 1 and 2 are free to water — the original pre-seeds its cache with 0 for both.
const INTERVAL_CACHE = new Map([[1, 0], [2, 0]]);

/** Seconds between waters at a given tree size. Grows slowly with height. */
export function getWateringInterval(size) {
  if (INTERVAL_CACHE.has(size)) return INTERVAL_CACHE.get(size);
  const seconds = Math.floor(Math.pow(size * 0.07 + 5, 1.1));
  INTERVAL_CACHE.set(size, seconds);
  return seconds;
}

/** Total seconds a community has spent growing a tree of this size. */
export function getTreeAge(size) {
  let total = 0;
  for (let i = 1; i <= size; i++) total += getWateringInterval(i);
  return total;
}

/** XP for watering a tree of this size. Taller trees pay better. */
export function getTreeXp(size) {
  return Math.floor(Math.pow(size * 0.05 + 5, 1.08));
}

/** XP needed to advance from `level` to the next. */
export function getNextLevelRequiredXp(level) {
  return Math.floor(Math.pow(20 * level, 0.812) + 30);
}

/**
 * Apply gained XP, rolling over as many levels as it covers.
 * @returns {{level:number, xp:number, levelsGained:number}}
 */
export function applyXp(level, xp, gained) {
  let newLevel = level;
  let newXp = xp + gained;
  let levelsGained = 0;

  let required = getNextLevelRequiredXp(newLevel);
  while (newXp >= required) {
    newXp -= required;
    newLevel++;
    levelsGained++;
    required = getNextLevelRequiredXp(newLevel);
  }
  return { level: newLevel, xp: newXp, levelsGained };
}

/**
 * The height to display. While the cooldown is running the tree "grows" toward its new
 * size in tenths of a foot; once it elapses it reads the whole number.
 *
 * @param tree {{size:number, pieces:number[], lastWateredAt:number}} lastWateredAt in unix SECONDS
 * @param nowSec current time in unix seconds
 */
export function getTreeHeight(tree, nowSec = Math.floor(Date.now() / 1000)) {
  const growthTime = getWateringInterval(tree.pieces.length - 1);
  if (growthTime <= 0) return tree.size;

  const canBeWateredAt = tree.lastWateredAt + growthTime;
  if (canBeWateredAt <= nowSec) return tree.size;

  const remaining = canBeWateredAt - nowSec;
  return tree.size - Math.floor((remaining / growthTime) * 10) / 10;
}

/** Is the tree still on cooldown? */
export function isGrowing(tree, nowSec = Math.floor(Date.now() / 1000)) {
  const growthTime = getWateringInterval(tree.pieces.length - 1);
  return tree.lastWateredAt + growthTime > nowSec;
}

/** Unix seconds at which the tree can next be watered. */
export function canBeWateredAt(tree) {
  return tree.lastWateredAt + getWateringInterval(tree.pieces.length - 1);
}

/** Background unlocks. */
export const BACKGROUNDS = Object.freeze(['Ground', 'Sky', 'SpaceEdge']);
export function backgroundForSize(size, current = 'Ground') {
  if (size >= 1000) return 'SpaceEdge';
  if (size >= 6) return current === 'SpaceEdge' ? 'SpaceEdge' : 'Sky';
  return current;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec || !parts.length) parts.push(`${sec}s`);
  return parts.join(' ');
}
