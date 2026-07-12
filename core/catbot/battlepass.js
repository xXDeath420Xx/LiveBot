/*
 * Cat Bot battlepass — daily and weekly quests feeding a season track. Clean-room.
 *
 * Quests are deterministic per (user, period): the same three dailies are chosen all day,
 * without storing a "which quests today" row. Progress is upserted as events happen.
 */
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { addCoins } from './economy.js';
import { grantPack, PACK_IDS } from './packs.js';

export const SEASON_XP_PER_LEVEL = 100;
export const MAX_SEASON_LEVEL = 50;

/**
 * `event` is what advances it. The catch pipeline emits: catch, catch_rare, catch_fast,
 * pack_open, game_play, game_win, prism_craft.
 */
export const QUESTS = Object.freeze([
  { id: 'catch-10', name: 'Cat Nap', event: 'catch', target: 10, xp: 25, coins: 60, kind: 'daily' },
  { id: 'catch-30', name: 'Herding Cats', event: 'catch', target: 30, xp: 45, coins: 140, kind: 'daily' },
  { id: 'rare-1', name: 'Something Special', event: 'catch_rare', target: 1, xp: 40, coins: 120, kind: 'daily' },
  { id: 'fast-3', name: 'Quick Draw', event: 'catch_fast', target: 3, xp: 35, coins: 100, kind: 'daily' },
  { id: 'pack-1', name: 'Unwrapped', event: 'pack_open', target: 1, xp: 30, coins: 80, kind: 'daily' },
  { id: 'games-3', name: 'Chancer', event: 'game_play', target: 3, xp: 25, coins: 70, kind: 'daily' },
  { id: 'wins-2', name: 'Lucky Streak', event: 'game_win', target: 2, xp: 35, coins: 110, kind: 'daily' },

  { id: 'w-catch-150', name: 'Cattery', event: 'catch', target: 150, xp: 150, coins: 600, kind: 'weekly' },
  { id: 'w-rare-5', name: 'Rare Breed', event: 'catch_rare', target: 5, xp: 180, coins: 700, kind: 'weekly' },
  { id: 'w-pack-5', name: 'Pack Rat', event: 'pack_open', target: 5, xp: 140, coins: 550, kind: 'weekly' },
]);

const DAILY_COUNT = 3;
const WEEKLY_COUNT = 1;

// ── Periods ──────────────────────────────────────────────────────────────────

export function dailyPeriod(date = new Date()) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export function weeklyPeriod(date = new Date()) {
  // ISO week: Thursday of the current week decides the year.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Stable 32-bit hash so a user's quest picks are the same all period. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministically choose this period's quests for a user — no extra table needed. */
export function questsFor(userId, date = new Date()) {
  const day = dailyPeriod(date);
  const week = weeklyPeriod(date);

  const dailies = pick(QUESTS.filter(q => q.kind === 'daily'), DAILY_COUNT, hash(`${userId}:${day}`));
  const weeklies = pick(QUESTS.filter(q => q.kind === 'weekly'), WEEKLY_COUNT, hash(`${userId}:${week}`));
  return [
    ...dailies.map(q => ({ ...q, period: day })),
    ...weeklies.map(q => ({ ...q, period: week })),
  ];
}

/** Deterministic sample without replacement. */
function pick(list, n, seed) {
  const pool_ = [...list];
  const out = [];
  let s = seed || 1;
  for (let i = 0; i < n && pool_.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out.push(pool_.splice(s % pool_.length, 1)[0]);
  }
  return out;
}

// ── Progress ─────────────────────────────────────────────────────────────────

/**
 * Advance every active quest listening for `event`.
 * @returns {Promise<Array>} quests that just hit their target (ready to claim).
 */
export async function progress(guildId, userId, event, amount = 1, date = new Date()) {
  const active = questsFor(userId, date).filter(q => q.event === event);
  if (!active.length) return [];

  const completed = [];
  for (const q of active) {
    // Clamp at target so `progress` can't run away past it.
    await pool.execute(
      `INSERT INTO catbot_quests (guild_id, user_id, period, quest_id, progress, target)
       VALUES (?, ?, ?, ?, LEAST(?, ?), ?)
       ON DUPLICATE KEY UPDATE progress = LEAST(progress + VALUES(progress), target)`,
      [guildId, userId, q.period, q.id, amount, q.target, q.target]);

    const [[row]] = await pool.execute(
      'SELECT progress, claimed FROM catbot_quests WHERE guild_id = ? AND user_id = ? AND period = ? AND quest_id = ?',
      [guildId, userId, q.period, q.id]);
    if (row && row.progress >= q.target && !row.claimed) completed.push(q);
  }
  return completed;
}

/**
 * Push a batch of events. Quests are best-effort — a failure here must never cost someone
 * their cat or their winnings.
 * @returns {Promise<Array>} quests that just became claimable.
 */
export async function advance(guildId, userId, events) {
  const completed = [];
  for (const [event, amount] of events) {
    try {
      completed.push(...await progress(guildId, userId, event, amount));
    } catch (err) {
      logger.error(`[CatBot] quest progress (${event}) failed: ${err.message}`);
    }
  }
  return completed;
}

/** "🎯 Quest complete: **A**, **B** — claim with `/cat quests`." or '' when nothing landed. */
export function questLine(completed) {
  if (!completed?.length) return '';
  return `\n🎯 Quest complete: **${completed.map(q => q.name).join('**, **')}** — claim with \`/cat quests\`.`;
}

export async function getBoard(guildId, userId, date = new Date()) {
  const quests = questsFor(userId, date);
  const [rows] = await pool.execute(
    `SELECT period, quest_id, progress, claimed FROM catbot_quests
      WHERE guild_id = ? AND user_id = ? AND period IN (?, ?)`,
    [guildId, userId, dailyPeriod(date), weeklyPeriod(date)]);
  const byKey = new Map(rows.map(r => [`${r.period}:${r.quest_id}`, r]));

  return quests.map(q => {
    const row = byKey.get(`${q.period}:${q.id}`);
    return {
      ...q,
      progress: Math.min(Number(row?.progress || 0), q.target),
      claimed: !!row?.claimed,
      complete: Number(row?.progress || 0) >= q.target,
    };
  });
}

/**
 * Claim a completed quest. The `claimed = 0` guard makes it single-use even under a
 * double click.
 */
export async function claim(guildId, userId, questId, date = new Date()) {
  const quest = questsFor(userId, date).find(q => q.id === questId);
  if (!quest) return { ok: false, reason: 'inactive' };

  const [r] = await pool.execute(
    `UPDATE catbot_quests SET claimed = 1
      WHERE guild_id = ? AND user_id = ? AND period = ? AND quest_id = ?
        AND claimed = 0 AND progress >= target`,
    [guildId, userId, quest.period, quest.id]);
  if (r.affectedRows !== 1) return { ok: false, reason: 'not-ready' };

  await addCoins(guildId, userId, quest.coins);
  const season = await addSeasonXp(guildId, userId, quest.xp);
  return { ok: true, quest, season };
}

// ── Season track ─────────────────────────────────────────────────────────────

export async function getSeason(guildId, userId) {
  const [[row]] = await pool.execute(
    'SELECT level, xp, claimed FROM catbot_season WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  return row
    ? { level: Number(row.level), xp: Number(row.xp), claimed: Number(row.claimed) }
    : { level: 1, xp: 0, claimed: 0 };
}

export async function addSeasonXp(guildId, userId, xp) {
  const current = await getSeason(guildId, userId);
  let { level } = current;
  let total = current.xp + xp;
  let gained = 0;

  while (level < MAX_SEASON_LEVEL && total >= SEASON_XP_PER_LEVEL) {
    total -= SEASON_XP_PER_LEVEL;
    level++;
    gained++;
  }
  if (level >= MAX_SEASON_LEVEL) total = Math.min(total, SEASON_XP_PER_LEVEL);

  await pool.execute(
    `INSERT INTO catbot_season (guild_id, user_id, level, xp) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE level = VALUES(level), xp = VALUES(xp)`,
    [guildId, userId, level, total]);

  return { level, xp: total, levelsGained: gained };
}

/** Reward for reaching a season level. Every 5th level pays a pack. */
export function seasonReward(level) {
  if (level % 10 === 0) return { coins: 1000, pack: 'golden' };
  if (level % 5 === 0) return { coins: 500, pack: 'silver' };
  return { coins: 100 * level };
}

/** Claim every unclaimed season level up to the current one. */
export async function claimSeason(guildId, userId) {
  const season = await getSeason(guildId, userId);
  if (season.claimed >= season.level) return { ok: false, reason: 'nothing' };

  let coins = 0;
  const packs = [];
  for (let lvl = season.claimed + 1; lvl <= season.level; lvl++) {
    const reward = seasonReward(lvl);
    coins += reward.coins;
    if (reward.pack && PACK_IDS.includes(reward.pack)) packs.push(reward.pack);
  }

  // Guard on the value we read so a double-claim can't pay twice.
  const [r] = await pool.execute(
    'UPDATE catbot_season SET claimed = ? WHERE guild_id = ? AND user_id = ? AND claimed = ?',
    [season.level, guildId, userId, season.claimed]);
  if (r.affectedRows !== 1) return { ok: false, reason: 'nothing' };

  if (coins) await addCoins(guildId, userId, coins);
  for (const p of packs) await grantPack(guildId, userId, p);
  return { ok: true, coins, packs, upTo: season.level };
}

export async function getSeasonBoard(guildId, limit = 10) {
  const [rows] = await pool.execute(
    'SELECT user_id, level, xp FROM catbot_season WHERE guild_id = ? ORDER BY level DESC, xp DESC LIMIT ?',
    [guildId, String(limit)]);
  return rows.map(r => ({ userId: r.user_id, level: Number(r.level), xp: Number(r.xp) }));
}
