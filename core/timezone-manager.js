// Friend Time-style time conversion, native to CertiFriedUtility.
//
// A message mentioning a time ("raid at 8pm") gets a 🕰️ reaction; anyone who clicks it
// is DM'd that time converted into their own zone. Alternatively a guild can run in
// 'list' mode, where the bot replies in-channel with the time across its zone board.
//
// Times are interpreted in the AUTHOR's zone (falling back to the guild's zone), which is
// the only way "8pm" means anything. Detection is opt-in per guild: with no tz_guild_config
// row the message hook is inert, so adding this never changes behavior in an existing guild.
import * as chrono from 'chrono-node';
import moment from 'moment-timezone';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

export const CLOCK = '🕰️';
const MAX_LIST_ZONES = 10;
const MAX_RESULTS = 5; // don't spam a wall of conversions off one message

// ── Zones ────────────────────────────────────────────────────────────────────

const ZONES = moment.tz.names();
const ZONES_LOWER = new Map(ZONES.map(z => [z.toLowerCase(), z]));

// Common abbreviations people actually type. Mapped to IANA zones so DST is handled.
const ALIASES = {
  est: 'America/New_York', edt: 'America/New_York', et: 'America/New_York',
  cst: 'America/Chicago', cdt: 'America/Chicago', ct: 'America/Chicago',
  mst: 'America/Denver', mdt: 'America/Denver', mt: 'America/Denver',
  pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pt: 'America/Los_Angeles',
  akst: 'America/Anchorage', hst: 'Pacific/Honolulu',
  gmt: 'Etc/GMT', utc: 'Etc/UTC', z: 'Etc/UTC',
  bst: 'Europe/London', cet: 'Europe/Paris', cest: 'Europe/Paris', eet: 'Europe/Athens',
  ist: 'Asia/Kolkata', jst: 'Asia/Tokyo', kst: 'Asia/Seoul',
  aest: 'Australia/Sydney', aedt: 'Australia/Sydney', awst: 'Australia/Perth',
  nzst: 'Pacific/Auckland', nzdt: 'Pacific/Auckland',
};

/** Resolve user input ("pst", "america/new_york", "Europe/Paris") to a canonical IANA zone. */
export function resolveZone(input) {
  if (!input) return null;
  const raw = String(input).trim();
  const lower = raw.toLowerCase();
  return ALIASES[lower] || ZONES_LOWER.get(lower) || null;
}

/** Autocomplete: rank zones that contain the query, prefixes first. */
export function searchZones(query, limit = 25) {
  const q = String(query || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!q) {
    return ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
      'America/Anchorage', 'Pacific/Honolulu', 'Etc/UTC', 'Europe/London', 'Europe/Paris',
      'Europe/Berlin', 'Europe/Moscow', 'Asia/Kolkata', 'Asia/Tokyo', 'Asia/Seoul',
      'Asia/Shanghai', 'Australia/Sydney', 'Pacific/Auckland'].slice(0, limit);
  }
  const alias = ALIASES[q];
  const hits = ZONES.filter(z => z.toLowerCase().includes(q));
  hits.sort((a, b) => {
    const ai = a.toLowerCase().indexOf(q), bi = b.toLowerCase().indexOf(q);
    return ai - bi || a.length - b.length || a.localeCompare(b);
  });
  if (alias && !hits.includes(alias)) hits.unshift(alias);
  return hits.slice(0, limit);
}

/** e.g. "Wed, Jul 8 · 4:00 PM EDT" */
export function formatIn(date, zone, format = '12') {
  const pattern = format === '24' ? 'ddd, MMM D · HH:mm z' : 'ddd, MMM D · h:mm A z';
  return moment(date).tz(zone).format(pattern);
}

/** UTC offset of a zone at a given instant, in minutes (DST-correct). */
function offsetAt(zone, date) {
  return moment(date).tz(zone).utcOffset();
}

// ── Settings ─────────────────────────────────────────────────────────────────

export async function getUserSettings(userId) {
  const [rows] = await pool.execute(
    'SELECT time_zone, time_format, private_mode FROM tz_users WHERE user_id = ?', [userId]);
  return rows[0] || null;
}

export async function setUserZone(userId, zone) {
  await pool.execute(
    `INSERT INTO tz_users (user_id, time_zone) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE time_zone = VALUES(time_zone)`, [userId, zone]);
}

export async function setUserPrefs(userId, { timeFormat, privateMode }) {
  const sets = [], vals = [];
  if (timeFormat !== undefined) { sets.push('time_format = ?'); vals.push(timeFormat); }
  if (privateMode !== undefined) { sets.push('private_mode = ?'); vals.push(privateMode ? 1 : 0); }
  if (!sets.length) return false;
  vals.push(userId);
  const [r] = await pool.execute(`UPDATE tz_users SET ${sets.join(', ')} WHERE user_id = ?`, vals);
  return r.affectedRows > 0;
}

export async function clearUser(userId) {
  await pool.execute('DELETE FROM tz_users WHERE user_id = ?', [userId]);
}

// Short TTL cache — the message hook reads this on every message in enabled guilds.
const guildCache = new Map(); // guildId -> { at, cfg }
const GUILD_TTL = 60_000;

export async function getGuildConfig(guildId) {
  const hit = guildCache.get(guildId);
  if (hit && Date.now() - hit.at < GUILD_TTL) return hit.cfg;
  const [rows] = await pool.execute(
    'SELECT enabled, time_zone, time_format, auto_detect FROM tz_guild_config WHERE guild_id = ?', [guildId]);
  const cfg = rows[0] || null;
  guildCache.set(guildId, { at: Date.now(), cfg });
  return cfg;
}

export function invalidateGuild(guildId) { guildCache.delete(guildId); }

export async function setGuildConfig(guildId, { enabled, timeZone, timeFormat, autoDetect }) {
  await pool.execute(
    `INSERT INTO tz_guild_config (guild_id, enabled, time_zone, time_format, auto_detect)
     VALUES (?, COALESCE(?,1), ?, COALESCE(?,'12'), COALESCE(?,'react'))
     ON DUPLICATE KEY UPDATE
       enabled     = COALESCE(VALUES(enabled), enabled),
       time_zone   = COALESCE(VALUES(time_zone), time_zone),
       time_format = COALESCE(VALUES(time_format), time_format),
       auto_detect = COALESCE(VALUES(auto_detect), auto_detect)`,
    [guildId, enabled === undefined ? null : (enabled ? 1 : 0), timeZone ?? null,
      timeFormat ?? null, autoDetect ?? null]);
  invalidateGuild(guildId);
}

export async function getGuildList(guildId) {
  const [rows] = await pool.execute(
    'SELECT time_zone FROM tz_guild_list WHERE guild_id = ? ORDER BY position, time_zone', [guildId]);
  return rows.map(r => r.time_zone);
}

export async function addGuildListZone(guildId, zone) {
  const current = await getGuildList(guildId);
  if (current.includes(zone)) return { ok: false, reason: 'already' };
  if (current.length >= MAX_LIST_ZONES) return { ok: false, reason: 'full' };
  await pool.execute(
    'INSERT IGNORE INTO tz_guild_list (guild_id, time_zone, position) VALUES (?, ?, ?)',
    [guildId, zone, current.length]);
  return { ok: true };
}

export async function removeGuildListZone(guildId, zone) {
  const [r] = await pool.execute(
    'DELETE FROM tz_guild_list WHERE guild_id = ? AND time_zone = ?', [guildId, zone]);
  return r.affectedRows > 0;
}

// ── Detection ────────────────────────────────────────────────────────────────

// Strip things that read like times but aren't: URLs, code, custom emoji (<a:name:123>),
// mentions, and Discord's own <t:...> timestamps (already localized by the client).
function scrub(content) {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/<t:\d+(?::[tTdDfFR])?>/g, ' ')
    .replace(/<a?:\w+:\d+>/g, ' ')
    .replace(/<[@#&]!?\d+>/g, ' ');
}

/**
 * Times explicitly stated in `content`, interpreted in `sourceZone`.
 * Only results with a CERTAIN hour count — "see you tomorrow" and "version 2.5" are not times.
 */
export function findTimes(content, sourceZone, now = new Date()) {
  const text = scrub(content || '');
  if (!text.trim()) return [];
  let results;
  try {
    results = chrono.parse(text, { instant: now, timezone: offsetAt(sourceZone, now) });
  } catch (err) {
    logger.debug(`[Timezone] chrono parse failed: ${err.message}`);
    return [];
  }
  return results
    .filter(r => r.start?.isCertain('hour'))
    .slice(0, MAX_RESULTS)
    .map(r => ({ text: r.text, date: r.start.date() }));
}

/** The zone a message's times should be read in: author's, else the guild's. */
async function sourceZoneFor(message, cfg) {
  const user = await getUserSettings(message.author.id);
  if (user?.time_zone) return { zone: user.time_zone, private: !!user.private_mode, owned: true };
  if (cfg?.time_zone) return { zone: cfg.time_zone, private: false, owned: false };
  return null;
}

// ── messageCreate hook ───────────────────────────────────────────────────────

/**
 * Reacts 🕰️ (or posts the zone board) when a message states a time.
 * ALWAYS returns false — this never consumes a message.
 */
export async function handleTimeMessage(message) {
  try {
    if (!message.guild || message.author?.bot || !message.content) return false;

    const cfg = await getGuildConfig(message.guild.id);
    if (!cfg || !cfg.enabled || cfg.auto_detect === 'off') return false;

    const src = await sourceZoneFor(message, cfg);
    if (!src) return false; // nobody has told us what "8pm" means here

    const times = findTimes(message.content, src.zone);
    if (!times.length) return false;

    if (cfg.auto_detect === 'react') {
      const me = message.guild.members.me;
      if (!message.channel.permissionsFor(me)?.has('AddReactions')) return false;
      await message.react(CLOCK).catch(() => {});
      return false;
    }

    // 'list' — post the conversions in-channel across the guild's zone board.
    let zones = await getGuildList(message.guild.id);
    if (!zones.length) zones = cfg.time_zone ? [cfg.time_zone] : [];
    if (!zones.length) return false;

    const lines = times.map(t => {
      const unix = Math.floor(t.date.getTime() / 1000);
      const per = zones.map(z => `• ${z} — ${formatIn(t.date, z, cfg.time_format)}`).join('\n');
      return `**${t.text}** (<t:${unix}:f>)\n${per}`;
    });
    await message.reply({ content: lines.join('\n\n').slice(0, 1900), allowedMentions: { repliedUser: false } })
      .catch(() => {});
    return false;
  } catch (err) {
    logger.error(`[Timezone] message hook error: ${err.message}`);
    return false;
  }
}

// ── messageReactionAdd hook ──────────────────────────────────────────────────

/**
 * Someone clicked the bot's 🕰️ — DM them the message's times in their own zone.
 * Returns true if handled.
 */
export async function handleTimeReaction(reaction, user) {
  try {
    if (user.bot) return false;
    if (reaction.emoji.name !== CLOCK) return false;
    if (reaction.partial) { try { await reaction.fetch(); } catch { return false; } }
    if (!reaction.me) return false; // only OUR clock, not a user's own 🕰️
    const message = reaction.message.partial
      ? await reaction.message.fetch().catch(() => null)
      : reaction.message;
    if (!message?.guild || !message.content) return false;

    const cfg = await getGuildConfig(message.guild.id);
    if (!cfg || !cfg.enabled) return false;

    const src = await sourceZoneFor(message, cfg);
    if (!src) return false;

    const viewer = await getUserSettings(user.id);
    if (!viewer?.time_zone) {
      await user.send(
        `You haven't set a time zone yet, so I can't convert that for you.\n` +
        `Run **/timezone set** in **${message.guild.name}** and click the clock again.`
      ).catch(() => {});
      return true;
    }

    const times = findTimes(message.content, src.zone);
    if (!times.length) return false;

    const from = src.private ? 'their time zone' : src.zone;
    const lines = times.map(t => {
      const unix = Math.floor(t.date.getTime() / 1000);
      return `**${t.text}** → ${formatIn(t.date, viewer.time_zone, viewer.time_format)}  (<t:${unix}:f>)`;
    });

    await user.send({
      content:
        `🕰️ **${message.author.username}** in **${message.guild.name}** (${from}):\n` +
        lines.join('\n') + `\n\n${message.url}`,
    }).catch(() => { /* DMs closed — Friend Time behaves the same way */ });

    // Let them click again later.
    if (message.channel.permissionsFor(message.guild.members.me)?.has('ManageMessages')) {
      await reaction.users.remove(user.id).catch(() => {});
    }
    return true;
  } catch (err) {
    logger.error(`[Timezone] reaction hook error: ${err.message}`);
    return false;
  }
}
