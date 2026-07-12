/*
 * Cat Coins — the spendable half of Cat Bot. Cats are the collectible; coins are earned
 * from catching them (a cat's rarity value) and spent on catnip perks and the minigames.
 */
import pool from '../../utils/db.js';
import { valueOf } from './constants.js';

export const STARTING_COINS = 100;

export async function getWallet(guildId, userId) {
  const [[row]] = await pool.execute(
    'SELECT coins, lifetime FROM catbot_wallets WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  if (row) return { coins: Number(row.coins), lifetime: Number(row.lifetime) };
  return { coins: STARTING_COINS, lifetime: 0 };
}

/** Ensure a row exists so the starting balance is real, not just implied. */
export async function ensureWallet(guildId, userId) {
  await pool.execute(
    'INSERT IGNORE INTO catbot_wallets (guild_id, user_id, coins) VALUES (?, ?, ?)',
    [guildId, userId, STARTING_COINS]);
}

/** Add (or subtract) coins. Never lets a balance go negative. */
export async function addCoins(guildId, userId, amount) {
  await ensureWallet(guildId, userId);
  const delta = Math.trunc(amount);
  if (delta >= 0) {
    await pool.execute(
      'UPDATE catbot_wallets SET coins = coins + ?, lifetime = lifetime + ? WHERE guild_id = ? AND user_id = ?',
      [delta, delta, guildId, userId]);
    return true;
  }
  const [r] = await pool.execute(
    'UPDATE catbot_wallets SET coins = coins + ? WHERE guild_id = ? AND user_id = ? AND coins >= ?',
    [delta, guildId, userId, -delta]);
  return r.affectedRows === 1;
}

/**
 * Atomically take `amount` coins. Returns false when they can't afford it — the
 * `coins >= ?` guard means two concurrent bets can't both spend the same balance.
 */
export async function spendCoins(guildId, userId, amount) {
  if (amount <= 0) return true;
  await ensureWallet(guildId, userId);
  const [r] = await pool.execute(
    'UPDATE catbot_wallets SET coins = coins - ? WHERE guild_id = ? AND user_id = ? AND coins >= ?',
    [amount, guildId, userId, amount]);
  return r.affectedRows === 1;
}

/** Coins earned for catching a cat of this type. */
export function coinsForCat(type) {
  return Math.max(1, Math.floor(valueOf(type)));
}

export async function getRichest(guildId, limit = 10) {
  const [rows] = await pool.execute(
    'SELECT user_id, coins FROM catbot_wallets WHERE guild_id = ? ORDER BY coins DESC LIMIT ?',
    [guildId, String(limit)]);
  return rows.map(r => ({ userId: r.user_id, coins: Number(r.coins) }));
}

// ── Per-game stats ───────────────────────────────────────────────────────────

export async function recordGame(guildId, userId, game, { won = false, net = 0 } = {}) {
  await pool.execute(
    `INSERT INTO catbot_game_stats (guild_id, user_id, game, plays, wins, net)
     VALUES (?, ?, ?, 1, ?, ?)
     ON DUPLICATE KEY UPDATE plays = plays + 1, wins = wins + VALUES(wins), net = net + VALUES(net)`,
    [guildId, userId, game, won ? 1 : 0, Math.trunc(net)]);
}

export async function getGameStats(guildId, userId) {
  const [rows] = await pool.execute(
    'SELECT game, plays, wins, net FROM catbot_game_stats WHERE guild_id = ? AND user_id = ? ORDER BY plays DESC',
    [guildId, userId]);
  return rows.map(r => ({ game: r.game, plays: r.plays, wins: r.wins, net: Number(r.net) }));
}

// ── Game profile (cookies, fish, pig, bakery) ────────────────────────────────

export async function getGameProfile(guildId, userId) {
  const [[row]] = await pool.execute(
    'SELECT * FROM catbot_game_profile WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  return row || {
    guild_id: guildId, user_id: userId, cookies: 0, bakery_level: 0, bakery_at: 0,
    fish_caught: 0, best_fish: null, last_fish_at: 0, best_pig: 0,
  };
}

export async function updateGameProfile(guildId, userId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  // Column names come from our own call sites, never from user input.
  const cols = keys.map(k => `${k} = VALUES(${k})`).join(', ');
  await pool.execute(
    `INSERT INTO catbot_game_profile (guild_id, user_id, ${keys.join(', ')})
     VALUES (?, ?, ${keys.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${cols}`,
    [guildId, userId, ...keys.map(k => fields[k])]);
}

export async function bumpGameProfile(guildId, userId, column, by = 1) {
  await pool.execute(
    `INSERT INTO catbot_game_profile (guild_id, user_id, ${column}) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE ${column} = ${column} + VALUES(${column})`,
    [guildId, userId, by]);
}
