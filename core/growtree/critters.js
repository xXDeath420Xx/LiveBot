/*
 * Grow a Tree — the encounters. Bugs to net, fruit to catch, coins to compost.
 *
 * Watering a tree, on its own, is a chore with a cooldown. What makes the real Grow a Tree a game is
 * that things HAPPEN while you are looking at it: an insect lands and the first person to hit the
 * bugnet gets its sticker; fruit falls and you have to guess which basket to hold out.
 *
 * Two rules run through all of it:
 *
 *   1. THE RACE IS REAL. A bug goes to whoever clicks first, and that is decided by a single
 *      conditional UPDATE (`WHERE caught_by IS NULL`), not by reading and then writing. Discord does
 *      not promise to deliver interactions in the order they were clicked, so a read-then-write
 *      hands the sticker to whoever happened to arrive last — which the loser can SEE, because they
 *      watched their own click land first.
 *
 *   2. LOSING IS NOT PUNISHED. Miss the bug and it flies off; guess the wrong basket and the fruit
 *      splats. You lose nothing you had. A collectathon that can take things away from you stops
 *      being something people click on for fun.
 */
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

/** How long you get. Short enough to be a race, long enough to be fair on a phone. */
export const BUG_TTL_MS = 25_000;
export const FRUIT_TTL_MS = 20_000;

/** Chance of something appearing when the tree is watered. */
export const BUG_CHANCE = 0.14;
export const FRUIT_CHANCE = 0.11;

/** How many baskets the fruit could fall into. More baskets = longer odds = more coins. */
export const BASKETS = 4;

/**
 * The sticker book.
 *
 * `weight` is the spawn weight, so rarity is a real thing and not a label — a Luna Moth is rare
 * because you will hardly ever see one, not because we wrote "rare" next to it.
 */
export const BUGS = Object.freeze([
  { code: 'cabbage_white', name: 'Cabbage White',  emoji: '🦋', rarity: 'common',    weight: 26, coins: 3 },
  { code: 'ladybird',      name: 'Ladybird',        emoji: '🐞', rarity: 'common',    weight: 24, coins: 3 },
  { code: 'honeybee',      name: 'Honeybee',        emoji: '🐝', rarity: 'common',    weight: 20, coins: 4 },
  { code: 'grasshopper',   name: 'Grasshopper',     emoji: '🦗', rarity: 'uncommon',  weight: 12, coins: 6 },
  { code: 'snail',         name: 'Garden Snail',    emoji: '🐌', rarity: 'uncommon',  weight: 10, coins: 6 },
  { code: 'caterpillar',   name: 'Caterpillar',     emoji: '🐛', rarity: 'uncommon',  weight: 10, coins: 7 },
  { code: 'stag_beetle',   name: 'Stag Beetle',     emoji: '🪲', rarity: 'rare',      weight: 6,  coins: 14 },
  { code: 'dragonfly',     name: 'Dragonfly',       emoji: '🪰', rarity: 'rare',      weight: 5,  coins: 16 },
  { code: 'mantis',        name: 'Praying Mantis',  emoji: '🦂', rarity: 'rare',      weight: 4,  coins: 18 },
  { code: 'firefly',       name: 'Firefly',         emoji: '✨', rarity: 'epic',      weight: 2,  coins: 40 },
  { code: 'luna_moth',     name: 'Luna Moth',       emoji: '🌙', rarity: 'legendary', weight: 1,  coins: 90 },
]);

export const FRUITS = Object.freeze([
  { code: 'apple',  name: 'Apple',  emoji: '🍎', coins: 8 },
  { code: 'pear',   name: 'Pear',   emoji: '🍐', coins: 8 },
  { code: 'plum',   name: 'Plum',   emoji: '🫐', coins: 10 },
  { code: 'peach',  name: 'Peach',  emoji: '🍑', coins: 12 },
  { code: 'cherry', name: 'Cherries', emoji: '🍒', coins: 14 },
]);

const BY_CODE = new Map([...BUGS, ...FRUITS].map(b => [b.code, b]));
export const lookup = (code) => BY_CODE.get(code) ?? null;

/** Weighted pick. */
function pick(list, rng = Math.random) {
  const total = list.reduce((n, b) => n + (b.weight ?? 1), 0);
  let roll = rng() * total;
  for (const b of list) {
    roll -= (b.weight ?? 1);
    if (roll <= 0) return b;
  }
  return list[list.length - 1];
}

/** Anything currently out there, unclaimed and unexpired. */
export async function activeEncounter(guildId) {
  const [[row]] = await pool.execute(
    `SELECT * FROM gat_encounters
      WHERE guild_id = ? AND caught_by IS NULL AND expires_at > NOW()
      ORDER BY id DESC LIMIT 1`, [guildId]);
  return row ?? null;
}

/**
 * Roll for an encounter after a water. Returns null most of the time — that is the point; something
 * that happens every time is not an event, it is a step.
 *
 * Never spawns on top of a live one: two bugs on screen means the second one steals the clicks of
 * people still racing for the first.
 */
export async function maybeSpawn(guildId, channelId, { rng = Math.random, force = null } = {}) {
  if (await activeEncounter(guildId)) return null;

  const roll = rng();
  const kind = force ?? (roll < BUG_CHANCE ? 'bug'
    : roll < BUG_CHANCE + FRUIT_CHANCE ? 'fruit'
      : null);
  if (!kind) return null;

  const thing = pick(kind === 'bug' ? BUGS : FRUITS, rng);
  const answer = kind === 'fruit' ? Math.floor(rng() * BASKETS) : null;
  const ttl = kind === 'bug' ? BUG_TTL_MS : FRUIT_TTL_MS;

  const [r] = await pool.execute(
    `INSERT INTO gat_encounters (guild_id, kind, code, answer, channel_id, expires_at)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [guildId, kind, thing.code, answer, channelId, Math.round(ttl / 1000)]);

  logger.info(`[GrowTree] ${kind} spawned in ${guildId}: ${thing.name}`);
  return { id: r.insertId, kind, code: thing.code, answer, thing, expiresInMs: ttl };
}

export async function setEncounterMessage(id, messageId) {
  await pool.execute('UPDATE gat_encounters SET message_id = ? WHERE id = ?', [messageId, id]);
}

/**
 * Try to claim it. THIS is the race, and it is decided in one statement.
 *
 * `WHERE caught_by IS NULL` means exactly one UPDATE can affect a row. Everyone else gets
 * affectedRows = 0 and is told they were too slow — truthfully, because they were.
 *
 * For fruit, `basket` must also be the right one. A wrong basket does not consume the encounter:
 * the fruit is still falling, and someone else may still catch it.
 */
export async function claim(guildId, encounterId, userId, basket = null) {
  const [[enc]] = await pool.execute(
    'SELECT * FROM gat_encounters WHERE id = ? AND guild_id = ?', [encounterId, guildId]);
  if (!enc) return { ok: false, reason: 'gone' };
  if (enc.caught_by) return { ok: false, reason: 'taken', by: enc.caught_by };
  if (new Date(enc.expires_at) < new Date()) return { ok: false, reason: 'expired' };

  if (enc.kind === 'fruit' && Number(basket) !== Number(enc.answer)) {
    return { ok: false, reason: 'wrong-basket', answer: enc.answer };
  }

  const [r] = await pool.execute(
    `UPDATE gat_encounters SET caught_by = ?, caught_at = NOW()
      WHERE id = ? AND caught_by IS NULL AND expires_at > NOW()`,
    [userId, encounterId]);
  if (r.affectedRows !== 1) return { ok: false, reason: 'taken' };

  const thing = lookup(enc.code);
  const coins = thing?.coins ?? 1;

  // The player row may not exist yet — someone can catch a bug before they have ever watered.
  await pool.execute(
    `INSERT INTO gat_players (user_id, level, xp, waters, coins, catches)
     VALUES (?, 1, 0, 0, ?, 1)
     ON DUPLICATE KEY UPDATE coins = coins + VALUES(coins), catches = catches + 1`,
    [userId, coins]);

  let isNew = false;
  if (enc.kind === 'bug') {
    const [sr] = await pool.execute(
      `INSERT INTO gat_stickers (user_id, code, count) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE count = count + 1`, [userId, enc.code]);
    // mysql2: 1 = inserted, 2 = updated. A brand-new sticker is worth saying out loud.
    isNew = sr.affectedRows === 1;
  }

  return { ok: true, kind: enc.kind, thing, coins, isNew };
}

/** Expire anything that timed out. Returns them so the message can be edited to say it got away. */
export async function reapExpired() {
  const [rows] = await pool.execute(
    `SELECT * FROM gat_encounters
      WHERE caught_by IS NULL AND expires_at <= NOW() AND message_id IS NOT NULL
        AND spawned_at > DATE_SUB(NOW(), INTERVAL 1 DAY)`);
  return rows;
}

/** Mark a reaped encounter handled, so the reaper does not keep finding it. */
export async function markReaped(id) {
  await pool.execute("UPDATE gat_encounters SET caught_by = '0' WHERE id = ?", [id]);
}

// ── the sticker book ─────────────────────────────────────────────────────────

export async function getBook(userId) {
  const [rows] = await pool.execute(
    'SELECT code, count, first_at FROM gat_stickers WHERE user_id = ?', [userId]);
  const have = new Map(rows.map(r => [r.code, r]));
  return BUGS.map(b => ({ ...b, count: Number(have.get(b.code)?.count ?? 0) }));
}

export async function getCoins(userId) {
  const [[row]] = await pool.execute('SELECT coins FROM gat_players WHERE user_id = ?', [userId]);
  return Number(row?.coins ?? 0);
}

// ── the composter ────────────────────────────────────────────────────────────

/**
 * Coins into the heap. The tree grows faster for EVERYONE, not just the person who paid — a
 * community tree whose boosts are personal is not a community tree.
 *
 * The spend is conditional on the balance, in one statement, so two simultaneous composts cannot
 * take a player below zero.
 */
export async function compost(guildId, userId, coins) {
  if (!Number.isInteger(coins) || coins < 1) return { ok: false, reason: 'amount' };

  const [r] = await pool.execute(
    'UPDATE gat_players SET coins = coins - ? WHERE user_id = ? AND coins >= ?',
    [coins, userId, coins]);
  if (r.affectedRows !== 1) return { ok: false, reason: 'broke', have: await getCoins(userId) };

  await pool.execute(
    'UPDATE gat_trees SET compost = compost + ? WHERE guild_id = ?', [coins, guildId]);

  const [[t]] = await pool.execute('SELECT compost FROM gat_trees WHERE guild_id = ?', [guildId]);
  return { ok: true, coins, total: Number(t?.compost ?? 0) };
}

/**
 * What the compost heap is worth: extra growth per water.
 *
 * Deliberately logarithmic and CAPPED. Linear compost would let one rich player buy a 900ft tree in
 * an afternoon, which ends the game for everyone else — the tree is supposed to be something the
 * server does together over weeks.
 */
export function compostBonus(compost) {
  if (!compost) return 0;
  return Math.min(4, Math.floor(Math.log2(compost / 25 + 1)));
}

export default {
  BUGS, FRUITS, BASKETS, lookup, maybeSpawn, activeEncounter, setEncounterMessage,
  claim, reapExpired, markReaped, getBook, getCoins, compost, compostBonus,
};
