/*
 * Grow a Tree — trunk segment generation. Each water pushes one new tile onto `pieces`.
 *
 * The rules keep a trunk readable: branches never stack directly on top of one another,
 * and consecutive branches alternate sides so the tree doesn't lean.
 */

export const TILE = Object.freeze({
  BASE: 0,
  SMALL_HOLE: 1,
  LARGE_HOLE: 2,
  RIGHT_BRANCH_1: 3,
  LEFT_BRANCH_1: 4,
  RIGHT_BRANCH_2: 5,
  LEFT_BRANCH_2: 6,
  SAPLING: 7,
});

export const TILE_NAMES = Object.freeze(Object.fromEntries(
  Object.entries(TILE).map(([k, v]) => [v, k])));

const RIGHT_BRANCHES = [TILE.RIGHT_BRANCH_1, TILE.RIGHT_BRANCH_2];
const LEFT_BRANCHES = [TILE.LEFT_BRANCH_1, TILE.LEFT_BRANCH_2];
const ALL_BRANCHES = [...RIGHT_BRANCHES, ...LEFT_BRANCHES];

export const isBranch = tile => ALL_BRANCHES.includes(tile);
const isRightBranch = tile => RIGHT_BRANCHES.includes(tile);
const isLeftBranch = tile => LEFT_BRANCHES.includes(tile);

// Relative odds for a fresh segment when a branch is allowed.
const WEIGHTS = Object.freeze({
  [TILE.BASE]: 50,
  [TILE.SMALL_HOLE]: 10,
  [TILE.LARGE_HOLE]: 6,
  branch: 34,
});

function weightedPick(entries, rng) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [value, weight] of entries) {
    r -= weight;
    if (r < 0) return value;
  }
  return entries[entries.length - 1][0];
}

/**
 * Pick the next trunk tile.
 * @param pieces the tree's current tiles, bottom-first
 */
export function generateNextSegment(pieces, rng = Math.random) {
  const top = pieces[pieces.length - 1];

  // No two branches in a row — the trunk needs somewhere to attach.
  if (isBranch(top)) {
    return weightedPick([
      [TILE.BASE, WEIGHTS[TILE.BASE]],
      [TILE.SMALL_HOLE, WEIGHTS[TILE.SMALL_HOLE]],
      [TILE.LARGE_HOLE, WEIGHTS[TILE.LARGE_HOLE]],
    ], rng);
  }

  const choice = weightedPick([
    [TILE.BASE, WEIGHTS[TILE.BASE]],
    [TILE.SMALL_HOLE, WEIGHTS[TILE.SMALL_HOLE]],
    [TILE.LARGE_HOLE, WEIGHTS[TILE.LARGE_HOLE]],
    ['branch', WEIGHTS.branch],
  ], rng);
  if (choice !== 'branch') return choice;

  // Alternate sides relative to the most recent branch below us.
  const lastBranch = [...pieces].reverse().find(isBranch);
  let side;
  if (lastBranch === undefined) side = rng() < 0.5 ? RIGHT_BRANCHES : LEFT_BRANCHES;
  else if (isRightBranch(lastBranch)) side = LEFT_BRANCHES;
  else if (isLeftBranch(lastBranch)) side = RIGHT_BRANCHES;
  else side = rng() < 0.5 ? RIGHT_BRANCHES : LEFT_BRANCHES;

  return side[rng() < 0.5 ? 0 : 1];
}

/** A newly planted tree: a sapling foot, a base, then one generated segment. */
export function newTree(rng = Math.random) {
  const pieces = [TILE.SAPLING, TILE.BASE];
  pieces.push(generateNextSegment(pieces, rng));
  return pieces;
}

/** Grow by one. Mutates nothing; returns the new pieces array. */
/**
 * One water = one segment, plus whatever the compost heap is worth.
 *
 * `extra` comes from compostBonus() and is capped there, deliberately. Uncapped compost would let
 * one player with coins buy a 900ft tree over an afternoon, and the tree is supposed to be a thing
 * the server does together over weeks — a shortcut past that is not a feature, it is an ending.
 */
export function grow(pieces, rng = Math.random, extra = 0) {
  const out = [...pieces];
  for (let i = 0; i <= Math.max(0, extra); i++) out.push(generateNextSegment(out, rng));
  return out;
}

/** The renderer only draws the top of the trunk. */
export const SHOW_LAST_N = 5;
export function visibleTiles(pieces, n = SHOW_LAST_N) {
  return pieces.slice(Math.max(0, pieces.length - n));
}
