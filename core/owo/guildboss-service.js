/*
 * OwO guild boss — CC-BY-NC-SA-4.0 derivative. See /LICENSE-OWO-NOTICE.md.
 *
 * One big enemy the whole guild fights together. It has a large HP pool; every fighter chips it
 * down with their real battle team, and the damage each person deals is banked per user. When HP
 * hits zero the boss is DEFEATED and everyone who fought is paid out (weighted by damage). If the
 * timer runs out first, it FLEES undefeated — exactly what happened to the one boss that spawned in
 * Kabster's guild (1 fighter, 0 defeated, ran away).
 *
 * The damage a fight deals is derived from the fighter's actual team — animal rank, stats and
 * equipped weapon — reusing the same philosophy as battle-engine.js, so a stronger, better-equipped
 * roster meaningfully out-damages a weak one. The boss hits back; if it wipes the team, that fighter
 * is marked "defeated" and cannot re-engage this boss.
 */
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getAnimal, getAnimalsByRank, RANK_META, RANK_COLORS } from './catalog.js';
import { getTeamDetails } from './teams-service.js';
import { addCowoncy } from './cowoncy.js';

/** How long a boss lingers before it flees. Matches OwO's ~hour-scale window. */
export const BOSS_LIFETIME_MS = 60 * 60 * 1000;
/** A fighter may strike at most this often — stops one big team from soloing in a burst. */
export const FIGHT_COOLDOWN_MS = 45 * 1000;
/** Ranks a boss is drawn from. Bosses are meant to be tough, so never a common critter. */
const BOSS_RANKS = ['rare', 'epic', 'mythical', 'legendary'];

// Mirror of battle-engine's bonus tables so boss damage lines up with normal combat.
const RANK_ATTACK_BONUS = { Common: 2, Uncommon: 5, Rare: 10, Epic: 20, Mythical: 40, Legendary: 80, Fabled: 160 };
const WEAR_MULT = { 4: 1.25, 3: 1.15, 2: 1.05, 1: 1.0, 0: 1.0 };
const rankKey = (r) => (r ? r[0].toUpperCase() + r.slice(1).toLowerCase() : 'Common');

function animalAttack(a) {
  let base = (a.stats?.att ?? 0) * 2 + 1;
  if (a.weapon) {
    base += (RANK_ATTACK_BONUS[rankKey(a.weapon.rank)] || 0) + Math.floor((a.weapon.stat || 0) / 4);
    base = Math.floor(base * (WEAR_MULT[a.weapon.wearId] || 1));
    for (const p of a.weapon.passives || []) base += Math.floor((p.quality || 0) / 2);
  }
  return base;
}
function animalHp(a) {
  const base = (a.stats?.hp ?? 0) * 50 + 100;
  return base + (a.weapon ? Math.floor((RANK_ATTACK_BONUS[rankKey(a.weapon.rank)] || 0) * 0.5) : 0);
}

// ── Spawn ──────────────────────────────────────────────────────────────────

/**
 * Roll a boss's level, HP and attack. Level scales the pool: a level-N boss needs roughly N solid
 * hits from an average team, so a few active players clear it inside the timer and a solo player
 * does not. Deterministic given (level, rng) so it is testable.
 */
export function rollBossStats(level) {
  const hp = Math.round(level * 1500 + 4000);
  const wp = Math.round(level * 18 + 40);
  return { hp, wp };
}

/**
 * Spawn a boss for a guild if one is not already active. Picks a random tough animal and a level
 * weighted toward the low end. Returns the boss row (with `isNew`) or the existing active boss.
 *
 * @param {object} [opts]
 * @param {number} [opts.level]   force a level (admin spawn / tests)
 * @param {string} [opts.channelId]
 * @param {() => number} [opts.rng]
 */
export async function spawnBoss(guildId, opts = {}) {
  const rng = opts.rng ?? Math.random;

  const existing = await getActiveBoss(guildId);
  if (existing) return { ...existing, isNew: false };

  // Pick the toughest available rank we actually have animals for, then a random animal in it.
  let animal = null;
  for (const rank of [...BOSS_RANKS].reverse()) {
    if (rng() < 0.55) continue; // bias toward lower ranks most of the time
    const pool = await getAnimalsByRank(rank).catch(() => []);
    if (pool.length) { animal = pool[Math.floor(rng() * pool.length)]; break; }
  }
  if (!animal) {
    for (const rank of BOSS_RANKS) {
      const pool = await getAnimalsByRank(rank).catch(() => []);
      if (pool.length) { animal = pool[Math.floor(rng() * pool.length)]; break; }
    }
  }
  if (!animal) throw new Error('no animals available to spawn a boss');

  // Level: 1..100, weighted low (square of a uniform roll).
  const level = opts.level ?? Math.max(1, Math.round(Math.pow(rng(), 2) * 99) + 1);
  const { hp, wp } = rollBossStats(level);
  const expiresAt = new Date(Date.now() + BOSS_LIFETIME_MS);

  // A fresh boss wipes the old damage board.
  await pool.execute('DELETE FROM owo_boss_damage WHERE guild_id = ?', [guildId]);
  await pool.execute(
    `INSERT INTO owo_guild_boss
       (guild_id, active, boss_animal, boss_lvl, boss_hp, boss_max_hp, boss_wp, channel_id, outcome, expires_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'active', ?)
     ON DUPLICATE KEY UPDATE
       active=1, boss_animal=VALUES(boss_animal), boss_lvl=VALUES(boss_lvl),
       boss_hp=VALUES(boss_hp), boss_max_hp=VALUES(boss_max_hp), boss_wp=VALUES(boss_wp),
       channel_id=VALUES(channel_id), message_id=NULL, outcome='active',
       spawned_at=CURRENT_TIMESTAMP, expires_at=VALUES(expires_at)`,
    [guildId, animal.name, level, hp, hp, wp, opts.channelId ?? null, expiresAt]);

  logger.info(`[OwO boss] spawned Lv.${level} ${animal.name} (${hp} HP) in guild ${guildId}`);
  return { ...(await getActiveBoss(guildId)), isNew: true };
}

/** Attach the message id so the announcement's buttons can update it later. */
export async function setBossMessage(guildId, channelId, messageId) {
  await pool.execute(
    'UPDATE owo_guild_boss SET channel_id = ?, message_id = ? WHERE guild_id = ? AND active = 1',
    [channelId, messageId, guildId]);
}

// ── Read ───────────────────────────────────────────────────────────────────

export async function getActiveBoss(guildId) {
  const [[boss]] = await pool.execute(
    "SELECT * FROM owo_guild_boss WHERE guild_id = ? AND active = 1 AND outcome = 'active'", [guildId]);
  if (!boss) return null;
  if (new Date(boss.expires_at).getTime() <= Date.now()) return null; // expired but not yet swept
  const hydrated = await getAnimal(boss.boss_animal).catch(() => null);
  return {
    guildId, animal: boss.boss_animal, emoji: hydrated?.emoji || boss.boss_animal,
    rank: hydrated?.rank || 'epic', level: boss.boss_lvl,
    hp: boss.boss_hp, maxHp: boss.boss_max_hp, wp: boss.boss_wp,
    channelId: boss.channel_id, messageId: boss.message_id,
    spawnedAt: boss.spawned_at, expiresAt: boss.expires_at,
  };
}

/** Top damage dealers on the current boss, highest first. */
export async function getLeaderboard(guildId, limit = 10) {
  const [rows] = await pool.execute(
    `SELECT uid, total_dmg, hits, defeated FROM owo_boss_damage
      WHERE guild_id = ? AND total_dmg > 0 ORDER BY total_dmg DESC LIMIT ?`,
    [guildId, limit]);
  return rows.map((r, i) => ({
    rank: i + 1, userId: r.uid, damage: Number(r.total_dmg), hits: Number(r.hits), defeated: !!r.defeated,
  }));
}

/** Fighter count + how many were wiped — the "⚔️ N fighters · 💀 M defeated" line. */
export async function getBossStats(guildId) {
  const [[row]] = await pool.execute(
    `SELECT COUNT(*) AS fighters, COALESCE(SUM(defeated),0) AS defeated, COALESCE(SUM(total_dmg),0) AS total
       FROM owo_boss_damage WHERE guild_id = ?`, [guildId]);
  return { fighters: Number(row.fighters), defeated: Number(row.defeated), totalDamage: Number(row.total) };
}

// ── Fight ────────────────────────────────────────────────────────────────────

/**
 * Fight the active boss with a user's active team. Computes the damage the team deals across a
 * short exchange, banks it, and lowers the boss's HP. If the boss's counterattack outlasts the
 * team, the fighter is marked defeated and cannot strike this boss again.
 *
 * @returns {Promise<object>} one of:
 *   {ok:false, reason:'no-boss'|'cooldown'|'defeated'|'no-team', ...}
 *   {ok:true, damage, bossHp, bossMaxHp, defeated, killed, boss, rewards?}
 */
export async function fightBoss(guildId, userId, opts = {}) {
  const rng = opts.rng ?? Math.random;
  const boss = await getActiveBoss(guildId);
  if (!boss) return { ok: false, reason: 'no-boss' };

  const [[dmgRow]] = await pool.execute(
    'SELECT total_dmg, hits, defeated, last_hit_at FROM owo_boss_damage WHERE guild_id = ? AND uid = ?',
    [guildId, userId]);
  if (dmgRow?.defeated) return { ok: false, reason: 'defeated', boss };
  if (dmgRow?.last_hit_at) {
    const since = Date.now() - new Date(dmgRow.last_hit_at).getTime();
    if (since < FIGHT_COOLDOWN_MS) return { ok: false, reason: 'cooldown', retryMs: FIGHT_COOLDOWN_MS - since, boss };
  }

  const team = await getTeamDetails(guildId, userId).catch(() => null);
  if (!team?.animals?.length) return { ok: false, reason: 'no-team', boss };

  // Exchange: the team attacks the boss for a few rounds; the boss retaliates against the team.
  // Damage is summed, not winner-take-all — this is chip damage on a shared pool.
  const ROUNDS = 4;
  let teamHp = team.animals.reduce((s, a) => s + animalHp(a), 0);
  let dealt = 0;
  let wiped = false;
  for (let r = 0; r < ROUNDS && teamHp > 0; r++) {
    for (const a of team.animals) {
      const atk = animalAttack(a);
      dealt += Math.max(1, atk + Math.floor(rng() * (atk / 2)) - Math.floor(boss.wp / 4));
    }
    // Boss swings back once per round at the whole team.
    teamHp -= Math.max(1, boss.wp + Math.floor(rng() * boss.wp) - Math.floor(boss.wp / 3));
    if (teamHp <= 0) { wiped = true; break; }
  }
  dealt = Math.max(1, Math.round(dealt));

  // Apply to the boss atomically: never let HP go below zero, and detect the killing blow.
  const [res] = await pool.execute(
    "UPDATE owo_guild_boss SET boss_hp = GREATEST(0, boss_hp - ?) WHERE guild_id = ? AND active = 1 AND outcome = 'active'",
    [dealt, guildId]);
  if (!res.affectedRows) return { ok: false, reason: 'no-boss' };

  await pool.execute(
    `INSERT INTO owo_boss_damage (guild_id, uid, total_dmg, hits, defeated, last_hit_at)
     VALUES (?, ?, ?, 1, ?, NOW())
     ON DUPLICATE KEY UPDATE
       total_dmg = total_dmg + VALUES(total_dmg),
       hits = hits + 1,
       defeated = GREATEST(defeated, VALUES(defeated)),
       last_hit_at = NOW()`,
    [guildId, userId, dealt, wiped ? 1 : 0]);

  const [[after]] = await pool.execute(
    'SELECT boss_hp FROM owo_guild_boss WHERE guild_id = ?', [guildId]);
  const bossHp = Number(after.boss_hp);
  const killed = bossHp <= 0;

  let rewards = null;
  if (killed) rewards = await defeatBoss(guildId, boss);

  return {
    ok: true, damage: dealt, bossHp, bossMaxHp: boss.maxHp,
    defeated: wiped, killed, boss, rewards,
    yourTotal: Number(dmgRow?.total_dmg ?? 0) + dealt,
  };
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * The boss is dead. Mark it defeated and pay every fighter, weighted by damage, with a bonus for
 * the top dealer. Reward pool scales with the boss's level. Idempotent: a second caller finds the
 * boss already resolved and pays nobody twice.
 */
export async function defeatBoss(guildId, boss) {
  const [res] = await pool.execute(
    "UPDATE owo_guild_boss SET outcome = 'defeated', active = 0 WHERE guild_id = ? AND outcome = 'active'",
    [guildId]);
  if (!res.affectedRows) return null; // someone else already resolved it

  const board = await getLeaderboard(guildId, 1000);
  const totalDamage = board.reduce((s, b) => s + b.damage, 0) || 1;
  const pool_ = Math.round((boss.level ?? 1) * 500 + 2000); // total cowoncy to split

  const payouts = [];
  for (const [i, f] of board.entries()) {
    const share = Math.round(pool_ * (f.damage / totalDamage));
    const bonus = i === 0 ? Math.round(pool_ * 0.15) : 0; // top-dealer bonus
    const amount = Math.max(50, share + bonus);
    await addCowoncy(guildId, f.userId, amount, `OwO guild boss defeated (Lv.${boss.level})`).catch(() => {});
    payouts.push({ userId: f.userId, amount, damage: f.damage, top: i === 0 });
  }
  logger.info(`[OwO boss] defeated in guild ${guildId}: paid ${payouts.length} fighter(s) from a ${pool_} pool`);
  return { pool: pool_, payouts, totalDamage };
}

/**
 * Retire a boss whose timer ran out — it flees undefeated. Returns the boss + final board so the
 * caller can edit the announcement to its "ran away" state.
 */
export async function expireBoss(guildId) {
  const [[boss]] = await pool.execute(
    "SELECT * FROM owo_guild_boss WHERE guild_id = ? AND active = 1 AND outcome = 'active'", [guildId]);
  if (!boss) return null;
  await pool.execute(
    "UPDATE owo_guild_boss SET outcome = 'fled', active = 0 WHERE guild_id = ? AND outcome = 'active'", [guildId]);
  return boss;
}

/** Every guild whose active boss has passed its timer — for the sweep job. */
export async function findExpiredBosses() {
  const [rows] = await pool.execute(
    "SELECT guild_id FROM owo_guild_boss WHERE active = 1 AND outcome = 'active' AND expires_at <= NOW()");
  return rows.map(r => r.guild_id);
}
