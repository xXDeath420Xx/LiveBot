/*
 * Cat Bot — spawn + catch engine. Clean-room; see /LICENSE-CATBOT-NOTICE.md.
 *
 * A cat appears in a setupped channel on a random timer. The first person to type
 * "cat" catches it; a short window afterwards lets a few late catchers in too.
 *
 * The winner is decided by a single atomic UPDATE:
 *     UPDATE catbot_channels SET cat_message_id = NULL
 *      WHERE channel_id = ? AND cat_message_id = ?
 * Exactly one concurrent caller sees affectedRows === 1. That's the whole lock — it
 * holds across shards and pooled connections, which an in-process list would not.
 */
import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import {
  rollCatType, valueOf, isRare, CATCH_WORD, DEFAULT_SPAWN_MIN, DEFAULT_SPAWN_MAX,
  RESPAWN_GRACE, SWEEP_INTERVAL_MS, BELATED_WINDOW_MS, BELATED_WINDOW_LEGACY_MS,
  BELATED_WINDOW_RAIN_MS, MAX_CATCHERS, ANTI_DOUBLE_CATCH_MS, RAIN_MIN_DELAY, RAIN_MAX_DELAY,
} from './constants.js';
import { catEmoji } from './emoji.js';
import { boostCatch } from './prisms.js';
import { rollPackDrop, grantPack } from './packs.js';
import { checkAndAward } from './achievements.js';
import { addCoins, coinsForCat } from './economy.js';
import { activeEffects } from './catnip.js';
import { advance as advanceQuests, questLine } from './battlepass.js';
import { RAIN_CAT_COUNT } from './constants.js';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const nowSec = () => Math.floor(Date.now() / 1000);

// Our own generated sprites (scripts/catbot-generate-art.mjs). Absent = text-only spawns.
const SPRITE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'catbot');
const spriteCache = new Map();
function spriteFor(type) {
  if (!spriteCache.has(type)) {
    const file = join(SPRITE_DIR, `${type.toLowerCase()}.png`);
    spriteCache.set(type, existsSync(file) ? file : null);
  }
  return spriteCache.get(type);
}

// channelId -> Timeout. Only a scheduling hint; yet_to_spawn in the DB is the truth,
// so a restart loses nothing (the sweeper picks it back up).
const timers = new Map();
// channelId -> { type, at, catchers: string[], timer } for the belated window.
const belated = new Map();

let sweeper = null;

// ── Channel config ───────────────────────────────────────────────────────────

export async function getChannel(channelId) {
  const [[row]] = await pool.execute('SELECT * FROM catbot_channels WHERE channel_id = ?', [channelId]);
  return row || null;
}

export async function setupChannel(guildId, channelId) {
  await pool.execute(
    `INSERT INTO catbot_channels (channel_id, guild_id, enabled, yet_to_spawn)
     VALUES (?, ?, 1, ?)
     ON DUPLICATE KEY UPDATE enabled = 1, guild_id = VALUES(guild_id)`,
    [channelId, guildId, nowSec()]);
}

export async function forgetChannel(channelId) {
  clearTimer(channelId);
  const [r] = await pool.execute('DELETE FROM catbot_channels WHERE channel_id = ?', [channelId]);
  return r.affectedRows > 0;
}

export async function setTimings(channelId, min, max) {
  await pool.execute('UPDATE catbot_channels SET spawn_min = ?, spawn_max = ? WHERE channel_id = ?',
    [min, max, channelId]);
}

async function getSettings(guildId) {
  const [[row]] = await pool.execute('SELECT * FROM catbot_settings WHERE guild_id = ?', [guildId]);
  return row || {
    only_setupped_channels: 0, do_reactions: 1, do_responses: 1, do_rain: 1,
    mute_achievements: 0, auto_delete_catches: 0, anti_double_catch: 0, legacy_catching: 0,
  };
}

// ── Scheduling ───────────────────────────────────────────────────────────────

function clearTimer(channelId) {
  const t = timers.get(channelId);
  if (t) { clearTimeout(t); timers.delete(channelId); }
}

function randBetween(min, max) { return min + Math.random() * (max - min); }

/** Persist the next spawn time and arm an in-process timer for it. */
export async function scheduleNext(channelId, delaySec) {
  const due = nowSec() + Math.ceil(delaySec) + RESPAWN_GRACE;
  await pool.execute('UPDATE catbot_channels SET yet_to_spawn = ? WHERE channel_id = ?', [due, channelId]);
  armTimer(channelId, delaySec * 1000);
}

function armTimer(channelId, delayMs) {
  clearTimer(channelId);
  // setTimeout caps at ~24.8 days; our delays are minutes, but clamp anyway.
  const ms = Math.max(0, Math.min(delayMs, 2 ** 31 - 1));
  const handle = setTimeout(() => {
    timers.delete(channelId);
    spawnCat(channelId).catch(err => logger.error(`[CatBot] spawn failed in ${channelId}: ${err.message}`));
  }, ms);
  if (handle.unref) handle.unref();
  timers.set(channelId, handle);
}

// ── Spawning ─────────────────────────────────────────────────────────────────

function resolveClient(guildId) {
  return global.botManager?.getClientForGuild?.(guildId) || global.client || null;
}

/** The three permissions a spawn genuinely needs: read the channel, post, attach the sprite. */
const SPAWN_PERMS = Object.freeze([
  ['ViewChannel', 'View Channel'],
  ['SendMessages', 'Send Messages'],
  ['AttachFiles', 'Attach Files'],
]);

function missingSpawnPerms(channel) {
  const me = channel.guild?.members?.me;
  if (!me) return [];
  const have = channel.permissionsFor(me);
  if (!have) return [];
  return SPAWN_PERMS.filter(([flag]) => !have.has(flag)).map(([, label]) => label);
}

/**
 * Tell somebody. Rate-limited to once an hour per channel so a permanently broken channel does
 * not turn into its own spam problem, and skipped entirely when we cannot even post.
 */
const permComplaints = new Map();
async function reportMissingPerms(channel, missing) {
  logger.warn(`[CatBot] ${channel.id} missing: ${missing.join(', ')}`);
  if (missing.includes('Send Messages') || missing.includes('View Channel')) return;

  const last = permComplaints.get(channel.id) ?? 0;
  if (Date.now() - last < 3_600_000) return;
  permComplaints.set(channel.id, Date.now());

  await channel.send({
    content: '❌ Missing Permissions! Please give me the following:\n'
      + missing.map(p => `- ${p}`).join('\n')
      + '\nHint: try setting channel permissions if server permissions look correct.',
  }).catch(() => {});
}

/** Send a cat into a channel and record it as the live spawn. */
export async function spawnCat(channelId, forcedType = null) {
  const row = await getChannel(channelId);
  if (!row || !row.enabled) return null;
  if (row.cat_message_id) return null; // a cat is already out

  const client = resolveClient(row.guild_id);
  const channel = await client?.channels?.fetch(channelId).catch(() => null);
  if (!channel) {
    logger.warn(`[CatBot] channel ${channelId} unreachable; disabling`);
    await pool.execute('UPDATE catbot_channels SET enabled = 0 WHERE channel_id = ?', [channelId]);
    return null;
  }

  // We attach a sprite, so Attach Files is as load-bearing as Send Messages. Report what is
  // missing instead of failing silently — a channel that has quietly stopped spawning cats with
  // no explanation is the single most confusing way for this to break.
  const missing = missingSpawnPerms(channel);
  if (missing.length) {
    await reportMissingPerms(channel, missing);
    return null;
  }

  const type = forcedType || rollCatType();
  const botId = client.user?.id ?? null;
  const emoji = catEmoji(type, botId);
  const template = row.appear_msg || '{emoji} {type} cat has appeared! Type "cat" to catch it!';
  const content = template.replace(/{emoji}/g, emoji).replace(/{type}/g, type);

  const payload = { content };
  const sprite = spriteFor(type);
  if (sprite) payload.files = [{ attachment: sprite, name: `${type.toLowerCase()}_cat.png` }];

  const msg = await channel.send(payload).catch(err => {
    logger.warn(`[CatBot] send failed in ${channelId}: ${err.message}`);
    return null;
  });
  if (!msg) return null;

  await pool.execute(
    'UPDATE catbot_channels SET cat_message_id = ?, cat_type = ?, spawned_at = ? WHERE channel_id = ?',
    [msg.id, type, Date.now(), channelId]);
  return { type, messageId: msg.id };
}

/** Roll and arm the next spawn for a channel (respecting an active rain). */
export async function scheduleRespawn(channelId) {
  const row = await getChannel(channelId);
  if (!row || !row.enabled) return;
  const raining = row.rain_left > 0;
  if (raining) await pool.execute('UPDATE catbot_channels SET rain_left = rain_left - 1 WHERE channel_id = ?', [channelId]);
  const delay = raining
    ? randBetween(RAIN_MIN_DELAY, RAIN_MAX_DELAY)
    : randBetween(row.spawn_min ?? DEFAULT_SPAWN_MIN, row.spawn_max ?? DEFAULT_SPAWN_MAX);
  await scheduleNext(channelId, delay);
}

// ── Catching ─────────────────────────────────────────────────────────────────

/**
 * Atomically claim the live cat. Returns the caught type, or null if someone beat us.
 * This is the ONLY place a winner is decided.
 */
export async function claimCat(channelId, expectedMessageId) {
  const [r] = await pool.execute(
    'UPDATE catbot_channels SET cat_message_id = NULL, cat_type = NULL WHERE channel_id = ? AND cat_message_id = ?',
    [channelId, expectedMessageId]);
  return r.affectedRows === 1;
}

export async function creditCat(guildId, userId, type, elapsedMs, channelId) {
  await pool.execute(
    `INSERT INTO catbot_catches (guild_id, user_id, cat_type, count) VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE count = count + 1`, [guildId, userId, type]);
  await pool.execute(
    `INSERT INTO catbot_profiles (guild_id, user_id, total_catches, fastest_ms, slowest_ms, last_catch_at, last_channel)
     VALUES (?, ?, 1, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       total_catches = total_catches + 1,
       fastest_ms = LEAST(COALESCE(fastest_ms, 4294967295), VALUES(fastest_ms)),
       slowest_ms = GREATEST(COALESCE(slowest_ms, 0), VALUES(slowest_ms)),
       last_catch_at = VALUES(last_catch_at),
       last_channel = VALUES(last_channel)`,
    [guildId, userId, elapsedMs, elapsedMs, Date.now(), channelId]);
}

/**
 * messageCreate hook. Returns true if the message was a catch attempt we acted on.
 * Never consumes anything else.
 */
export async function handleCatMessage(message) {
  try {
    if (!message.guild || message.author?.bot) return false;

    // Pinging the bot earns "Who Ping" and nothing else. Deliberately does NOT return true:
    // a mention is not a catch attempt, and swallowing it here would blind every other
    // message handler in the pipeline to it.
    if (message.mentions?.users?.has(message.client.user.id)) {
      await awardPing(message).catch(() => {});
    }

    if (message.content.trim().toLowerCase() !== CATCH_WORD) return false;

    const row = await getChannel(message.channelId);
    if (!row || !row.enabled) return false;

    const settings = await getSettings(message.guild.id);

    // A cat is out and nobody has claimed it yet -> race for it.
    if (row.cat_message_id) {
      if (settings.anti_double_catch && await inAntiDoubleCooldown(message.guild.id, message.author.id, message.channelId)) {
        return false;
      }
      const spawnedType = row.cat_type;
      const won = await claimCat(message.channelId, row.cat_message_id);
      if (!won) return handleBelated(message, settings); // someone beat us by microseconds

      const guildId = message.guild.id;
      const userId = message.author.id;
      const botId = message.client.user?.id;
      const elapsed = Math.max(0, Date.now() - Number(row.spawned_at || Date.now()));

      // The winner's catnip loadout applies to this catch. Late catchers get the plain cat.
      const perks = await activeEffects(guildId, userId);

      // Prisms upgrade the catch; Prism Focus and Night Vision add to the same roll.
      const boost = await boostCatch(guildId, userId, spawnedType, Math.random,
        (perks.prism_focus || 0) + (perks.night_vision || 0));
      const type = boost.type;

      await creditCat(guildId, userId, type, elapsed, message.channelId);
      if (boost.tiers > 0) {
        await pool.execute(
          'UPDATE catbot_profiles SET boosted_catches = boosted_catches + 1 WHERE guild_id = ? AND user_id = ?',
          [guildId, userId]);
      }
      openBelatedWindow(message.channelId, type, settings);

      const template = row.caught_msg || '{emoji} **{username}** caught a **{type}** cat! ({time})';
      let content = template
        .replace(/{emoji}/g, catEmoji(type, botId))
        .replace(/{username}/g, message.author.username)
        .replace(/{type}/g, type)
        .replace(/{time}/g, formatElapsed(elapsed));

      if (boost.tiers > 0) {
        const source = boost.prisms > 0 ? '🔮 A prism' : '🌙 Your catnip';
        content += `\n${source} upgraded it from **${spawnedType}**${boost.tiers > 1 ? ` (${boost.tiers} tiers!)` : ''}.`;
      }

      // Twin Cats: a chance the cat brought a friend of the same type.
      let twin = false;
      if (perks.twin_cats && Math.random() < perks.twin_cats) {
        twin = true;
        await pool.execute(
          `INSERT INTO catbot_catches (guild_id, user_id, cat_type, count) VALUES (?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE count = count + 1`, [guildId, userId, type]);
        await pool.execute(
          'UPDATE catbot_profiles SET total_catches = total_catches + 1 WHERE guild_id = ? AND user_id = ?',
          [guildId, userId]);
        content += `\n👯 It brought a twin — **two ${type} cats**!`;
      }

      // Cat Coins, scaled by the cat's rarity and the Coin Purse perk.
      const coins = Math.max(1, Math.round(coinsForCat(type) * (1 + (perks.coin_purse || 0)) * (twin ? 2 : 1)));
      await addCoins(guildId, userId, coins);
      content += `\n🪙 +**${coins}** Cat Coins.`;

      // A pack sometimes falls out. Lucky Paws widens the odds.
      const pack = rollPackDrop(Math.random, perks.lucky_paws || 0);
      if (pack) {
        await grantPack(guildId, userId, pack.id);
        content += `\n${pack.emoji} It was carrying a **${pack.name}**! Open it with \`/cat packs\`.`;
      }

      content += questLine(await advanceQuests(guildId, userId, [
        ['catch', twin ? 2 : 1],
        ...(isRare(type) ? [['catch_rare', 1]] : []),
        ...(elapsed < 3000 ? [['catch_fast', 1]] : []),
      ]));

      const sent = await message.channel.send({ content }).catch(() => null);
      if (settings.auto_delete_catches && sent) setTimeout(() => sent.delete().catch(() => {}), 10_000);
      await deleteSpawnMessage(message.channel, row.cat_message_id);

      // An upgrade that rolled past the rarest cat spills over into a cat rain, and
      // Rainmaker can start one out of nowhere.
      if (settings.do_rain && boost.overflow) {
        await startRain(message.channelId);
        await message.channel.send('🌧️ The prism overflowed — **cats are raining!**').catch(() => {});
      } else if (settings.do_rain && perks.rainmaker && Math.random() < perks.rainmaker) {
        await startRain(message.channelId);
        await message.channel.send('🌧️ Rainmaker triggered — **cats are raining!**').catch(() => {});
      }

      await scheduleRespawn(message.channelId);
      await announceAchievements(message, guildId, userId, settings);
      return true;
    }

    // No live cat — maybe we're inside the belated window.
    return handleBelated(message, settings);
  } catch (err) {
    logger.error(`[CatBot] catch handler error: ${err.message}`);
    return false;
  }
}

async function inAntiDoubleCooldown(guildId, userId, channelId) {
  const [[p]] = await pool.execute(
    'SELECT last_catch_at, last_channel FROM catbot_profiles WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  if (!p?.last_catch_at || !p.last_channel || p.last_channel === channelId) return false;
  return Date.now() - Number(p.last_catch_at) < ANTI_DOUBLE_CATCH_MS;
}

function openBelatedWindow(channelId, type, settings) {
  if (settings.legacy_catching) return;
  const windowMs = settings.legacy_catching ? BELATED_WINDOW_LEGACY_MS : BELATED_WINDOW_MS;
  const entry = { type, catchers: [], at: Date.now() };
  entry.timer = setTimeout(() => belated.delete(channelId), windowMs);
  if (entry.timer.unref) entry.timer.unref();
  belated.set(channelId, entry);
}

/** Late catchers get a plain +1 of the same type, capped at MAX_CATCHERS total. */
async function handleBelated(message, settings) {
  const entry = belated.get(message.channelId);
  if (!entry) return false;
  if (entry.catchers.length >= MAX_CATCHERS - 1) return false;
  if (entry.catchers.includes(message.author.id)) return false;

  entry.catchers.push(message.author.id);
  const guildId = message.guild.id;
  const userId = message.author.id;
  await creditCat(guildId, userId, entry.type, Date.now() - entry.at, message.channelId);
  await pool.execute(
    'UPDATE catbot_profiles SET belated_catches = belated_catches + 1 WHERE guild_id = ? AND user_id = ?',
    [guildId, userId]);
  // Half coins, no perks, no pack — being late should sting a little.
  await addCoins(guildId, userId, Math.max(1, Math.floor(coinsForCat(entry.type) / 2)));
  await advanceQuests(guildId, userId, [
    ['catch', 1],
    ...(isRare(entry.type) ? [['catch_rare', 1]] : []),
  ]);
  if (settings.do_reactions) await message.react('🐈').catch(() => {});
  await announceAchievements(message, guildId, userId, settings);
  return true;
}

/** Make the next RAIN_CAT_COUNT spawns come back-to-back. */
export async function startRain(channelId, count = RAIN_CAT_COUNT) {
  await pool.execute('UPDATE catbot_channels SET rain_left = ? WHERE channel_id = ?', [count, channelId]);
}

/**
 * "Who Ping" — awarded for mentioning the bot. Stays inert until the guild has actually set Cat
 * Bot up, so a server that never ran `/cat setup` cannot be handed a cat achievement for pinging.
 */
async function awardPing(message) {
  const [[live]] = await pool.execute(
    'SELECT 1 AS ok FROM catbot_channels WHERE guild_id = ? AND enabled = 1 LIMIT 1',
    [message.guild.id]);
  if (!live) return;

  const settings = await getSettings(message.guild.id);
  await announceAchievements(message, message.guild.id, message.author.id, settings, { pinged: true });
}

/** Award anything newly earned and say so, unless the guild muted it. */
async function announceAchievements(message, guildId, userId, settings, extra = {}) {
  try {
    const earned = await checkAndAward(guildId, userId, extra);
    if (!earned.length || settings.mute_achievements) return;

    // One "Achievement get!" embed per unlock, with the name as the field and the flavour text
    // as its value — the shape people already know from the bot this replaces.
    const embed = new EmbedBuilder()
      .setTitle('Achievement get!')
      .setColor(0xF2C14E)
      .setAuthor({ name: message.author.username, iconURL: message.author.displayAvatarURL() })
      .addFields(earned.map(a => ({ name: `${a.emoji} ${a.name}`, value: a.description })));

    await message.channel.send({ embeds: [embed], allowedMentions: { users: [] } }).catch(() => {});
  } catch (err) {
    logger.error(`[CatBot] achievement check failed: ${err.message}`);
  }
}

async function deleteSpawnMessage(channel, messageId) {
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (msg) await msg.delete().catch(() => {});
}

function formatElapsed(ms) {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(3)}s` : `${Math.floor(s / 60)}m ${(s % 60).toFixed(1)}s`;
}

// ── Startup + self-healing sweeper ───────────────────────────────────────────

/**
 * Re-arm timers for every enabled channel, and revive any whose spawn time passed
 * while we were down. Persisted yet_to_spawn means a restart never loses a spawn.
 */
export async function startSpawnEngine() {
  const { loadCustomEmoji } = await import('./emoji.js');
  await loadCustomEmoji();
  await reviveDue();
  if (sweeper) clearInterval(sweeper);
  sweeper = setInterval(() => reviveDue().catch(err =>
    logger.error(`[CatBot] sweeper failed: ${err.message}`)), SWEEP_INTERVAL_MS);
  if (sweeper.unref) sweeper.unref();
  logger.info('[CatBot] spawn engine started');
}

export function stopSpawnEngine() {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
  for (const id of [...timers.keys()]) clearTimer(id);
}

async function reviveDue() {
  const [rows] = await pool.execute(
    'SELECT channel_id, yet_to_spawn FROM catbot_channels WHERE enabled = 1 AND cat_message_id IS NULL');
  const now = nowSec();
  for (const r of rows) {
    if (timers.has(r.channel_id)) continue;
    const due = Number(r.yet_to_spawn || 0);
    if (due <= now) await spawnCat(r.channel_id).catch(() => {});
    else armTimer(r.channel_id, (due - now) * 1000);
  }
}

export const _internals = { formatElapsed, randBetween };
