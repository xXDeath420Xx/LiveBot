import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { EmbedBuilder } from 'discord.js';
import { logFeatureEvent } from './feature-log.js';
import { getGuildTimezone, getLocalDateParts } from '../utils/guild-timezone.js';

/*
 * Recurring channel messages (scheduled_announcements). Created from the dashboard's Scheduled
 * messages page (dashboard/routes/api/features/scheduled-messages.js) or /alerts scheduled, and
 * posted by jobs/announcement-scheduler.js, which calls checkDueAnnouncements() every minute.
 *
 * schedule_type / schedule_value:
 *   once      ISO instant ("2026-12-24T18:00:00.000Z")
 *   daily     "HH:MM"                    every day, server time
 *   weekly    "D[,D...] HH:MM"           days 0-6 (0 = Sunday) or names ("Monday 15:00" still works)
 *   monthly   "DD HH:MM"                 day 1-31; in a shorter month, its last day
 *   interval  "MINUTES" or "MINUTES@HH:MM" (the first post at that time of day, then every MINUTES)
 * Times of day are in the server's timezone (guild_settings.timezone, set on the Core page; UTC
 * when none is set), so a 09:00 post stays at 09:00 across daylight saving changes.
 *
 * Optional limits: end_at (no posts after it) and max_runs (stop after that many posts). A post
 * that fails records last_error and keeps its schedule; a deleted channel turns the post off.
 */

export const SCHEDULE_TYPES = ['once', 'daily', 'weekly', 'monthly', 'interval'];
export const MIN_INTERVAL_MINUTES = 10;
export const MAX_INTERVAL_MINUTES = 90 * 24 * 60;
export const MAX_PER_GUILD = 50;
export const NAME_MAX = 100;
export const CONTENT_MAX = 2000;
const PING_ROOM = 30; // "<@&id> " in front of the text
const SNOWFLAKE = /^\d{17,20}$/;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_LOOKUP = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

// ── time helpers ─────────────────────────────────────────────────────────────────────────────

/** "9:30" / "09:30" → { h, m }; anything else → null. */
export function parseClock(raw) {
  const m = String(raw ?? '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}

const pad = (n) => String(n).padStart(2, '0');
const clock = (t) => `${pad(t.h)}:${pad(t.m)}`;

/** Offset of `tz` from UTC at `instantMs`, in ms (local wall time minus UTC). */
function tzOffsetMs(instantMs, tz) {
  const p = getLocalDateParts(new Date(instantMs), tz);
  return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(instantMs / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` reads year-month-day hour:minute (month 0-based). */
export function zonedTimeToUtc(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month, day, hour, minute);
  const off = tzOffsetMs(guess, tz);
  let t = guess - off;
  const off2 = tzOffsetMs(t, tz);
  if (off2 !== off) t = guess - off2;
  return new Date(t);
}

/** "1,3,5 15:00", "Monday 15:00", "mon,wed 9:00" → { days: [1,3,5], time } or null. */
export function parseWeekly(value) {
  const parts = String(value ?? '').trim().split(/\s+/);
  if (parts.length < 2) return null;
  const time = parseClock(parts.pop());
  if (!time) return null;
  const days = new Set();
  for (const tok of parts.join(',').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (/^[0-6]$/.test(tok)) days.add(Number(tok));
    else if (DAY_LOOKUP[tok] !== undefined) days.add(DAY_LOOKUP[tok]);
    else return null;
  }
  return days.size ? { days: [...days].sort((a, b) => a - b), time } : null;
}

/** "15 12:00" → { day: 15, time } or null. */
export function parseMonthly(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2})\s+(\S+)$/);
  if (!m) return null;
  const day = Number(m[1]);
  const time = parseClock(m[2]);
  return day >= 1 && day <= 31 && time ? { day, time } : null;
}

/** "360" or "360@09:00" → { minutes, start } or null. */
export function parseInterval(value) {
  const m = String(value ?? '').trim().match(/^(\d+)(?:@(\d{1,2}:\d{2}))?$/);
  if (!m) return null;
  const minutes = Number(m[1]);
  if (!Number.isInteger(minutes) || minutes < 1) return null;
  const start = m[2] ? parseClock(m[2]) : null;
  if (m[2] && !start) return null;
  return { minutes, start };
}

/** The first instant after `from` whose wall clock in `tz` matches `match(y, m, d, weekday)` at `time`. */
function nextWallClock(from, tz, time, match) {
  const local = getLocalDateParts(from, tz);
  for (let i = 0; i <= 400; i++) {
    const d = new Date(Date.UTC(local.year, local.month, local.day + i));
    const y = d.getUTCFullYear(), mo = d.getUTCMonth(), day = d.getUTCDate();
    if (!match(y, mo, day, d.getUTCDay())) continue;
    const at = zonedTimeToUtc(y, mo, day, time.h, time.m, tz);
    if (at > from) return at;
  }
  return null;
}

/**
 * When a post should next go out, strictly after `from`. `previous` is the run that just happened
 * (an interval keeps its rhythm from it); leave it out for a new or edited post. null = never.
 */
export function computeNextRun(scheduleType, scheduleValue, tz, from = new Date(), previous = null) {
  switch (scheduleType) {
    case 'once': {
      if (previous) return null;
      const at = new Date(scheduleValue);
      return Number.isNaN(at.getTime()) ? null : at;
    }
    case 'daily': {
      const time = parseClock(scheduleValue);
      return time ? nextWallClock(from, tz, time, () => true) : null;
    }
    case 'weekly': {
      const w = parseWeekly(scheduleValue);
      return w ? nextWallClock(from, tz, w.time, (y, m, d, wd) => w.days.includes(wd)) : null;
    }
    case 'monthly': {
      const mo = parseMonthly(scheduleValue);
      if (!mo) return null;
      return nextWallClock(from, tz, mo.time, (y, m, d) => {
        const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        return d === Math.min(mo.day, last);
      });
    }
    case 'interval': {
      const iv = parseInterval(scheduleValue);
      if (!iv) return null;
      const step = iv.minutes * 60000;
      if (previous) {
        // Keep the rhythm; a post that was overdue by several intervals goes out once, not in a burst.
        const base = new Date(previous).getTime();
        const steps = Math.max(1, Math.floor((from.getTime() - base) / step) + 1);
        return new Date(base + steps * step);
      }
      if (iv.start) return nextWallClock(from, tz, iv.start, () => true);
      return new Date(from.getTime() + step);
    }
    default:
      return null;
  }
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

/** "Every 6 hours", "Every day at 09:00", "Mondays and Fridays at 15:00", ... */
export function describeSchedule(scheduleType, scheduleValue) {
  switch (scheduleType) {
    case 'once':
      return 'Once';
    case 'daily': {
      const t = parseClock(scheduleValue);
      return t ? `Every day at ${clock(t)}` : 'Every day';
    }
    case 'weekly': {
      const w = parseWeekly(scheduleValue);
      if (!w) return 'Weekly';
      if (w.days.length === 7) return `Every day at ${clock(w.time)}`;
      const names = w.days.map((d) => `${DAY_NAMES[d]}s`);
      const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
      return `${list} at ${clock(w.time)}`;
    }
    case 'monthly': {
      const mo = parseMonthly(scheduleValue);
      return mo ? `Day ${mo.day} of every month at ${clock(mo.time)}` : 'Monthly';
    }
    case 'interval': {
      const iv = parseInterval(scheduleValue);
      if (!iv) return 'Repeating';
      const m = iv.minutes;
      const every = m % 1440 === 0 ? plural(m / 1440, 'day') : m % 60 === 0 ? plural(m / 60, 'hour') : plural(m, 'minute');
      return `Every ${every}${iv.start ? `, from ${clock(iv.start)}` : ''}`;
    }
    default:
      return String(scheduleType || '');
  }
}

// ── message ──────────────────────────────────────────────────────────────────────────────────

const EMBED_LIMITS = { title: 256, description: 4096, author_name: 256, footer_text: 2048 };
const HTTP_URL = /^https?:\/\/\S{1,2000}$/i;

/**
 * The dashboard's embed fields ({ title, description, url, color, author_name, author_icon_url,
 * thumbnail_url, image_url, footer_text }) as Discord embed JSON, or null when every field is
 * empty. Returns { embed } or { error }.
 */
export function buildEmbedData(fields) {
  if (!fields || typeof fields !== 'object') return { embed: null };
  const s = (k) => String(fields[k] ?? '').trim();
  const embed = {};
  for (const [k, max] of Object.entries(EMBED_LIMITS)) {
    if (s(k).length > max) return { error: `The embed ${k.replace('_', ' ')} can be at most ${max} characters.` };
  }
  for (const k of ['url', 'author_icon_url', 'thumbnail_url', 'image_url']) {
    if (s(k) && !HTTP_URL.test(s(k))) return { error: `The embed ${k.replace(/_/g, ' ')} must start with http:// or https://.` };
  }
  if (s('title')) embed.title = s('title');
  if (s('description')) embed.description = s('description');
  if (s('url')) embed.url = s('url');
  if (s('author_name')) embed.author = { name: s('author_name'), ...(s('author_icon_url') ? { icon_url: s('author_icon_url') } : {}) };
  if (s('thumbnail_url')) embed.thumbnail = { url: s('thumbnail_url') };
  if (s('image_url')) embed.image = { url: s('image_url') };
  if (s('footer_text')) embed.footer = { text: s('footer_text') };
  const total = [embed.title, embed.description, embed.author?.name, embed.footer?.text].filter(Boolean).join('').length;
  if (total > 6000) return { error: 'The embed text is longer than Discord allows (6000 characters in all).' };
  if (!Object.keys(embed).length) return { embed: null };
  const color = s('color');
  if (color) {
    if (!/^#?[0-9a-f]{6}$/i.test(color)) return { error: 'The embed colour must be a hex colour like #5865f2.' };
    embed.color = parseInt(color.replace('#', ''), 16);
  }
  return { embed };
}

/** Discord embed JSON back into the dashboard's flat fields. */
export function embedFields(embedData) {
  let e = embedData;
  if (typeof e === 'string') { try { e = JSON.parse(e); } catch { e = null; } }
  if (!e || typeof e !== 'object') return null;
  return {
    title: e.title || '', description: e.description || '', url: e.url || '',
    color: Number.isInteger(e.color) ? `#${e.color.toString(16).padStart(6, '0')}` : '',
    author_name: e.author?.name || '', author_icon_url: e.author?.icon_url || '',
    thumbnail_url: e.thumbnail?.url || '', image_url: e.image?.url || '', footer_text: e.footer?.text || '',
  };
}

/** The message a row posts: text with the optional ping in front, the optional embed, and only the ping allowed to notify. */
export function buildPayload(row) {
  let content = String(row.message_content || '');
  const allowedMentions = { parse: ['users'], roles: [] };
  if (row.ping_role_id === 'everyone') {
    content = `@everyone ${content}`;
    allowedMentions.parse.push('everyone');
  } else if (SNOWFLAKE.test(String(row.ping_role_id || ''))) {
    content = `<@&${row.ping_role_id}> ${content}`;
    allowedMentions.roles = [String(row.ping_role_id)];
  }
  content = content.trim().slice(0, CONTENT_MAX);
  const embeds = [];
  if (row.embed_data) {
    try {
      const data = typeof row.embed_data === 'string' ? JSON.parse(row.embed_data) : row.embed_data;
      if (data && Object.keys(data).length) embeds.push(new EmbedBuilder(data));
    } catch (embedError) {
      logger.error(`[ScheduledAnnouncementsManager] Failed to parse embed data: ${embedError.message}`, { announcementId: row.id });
    }
  }
  return { ...(content ? { content } : {}), embeds, allowedMentions };
}

/**
 * Validate a post from the dashboard against its guild. `input`:
 *   name, channel_id, message_content, embed (flat fields, or null), ping_role_id ('' | 'everyone' | role id),
 *   enabled, schedule: { mode: 'interval'|'days'|'monthly'|'once', interval_value, interval_unit
 *   ('minutes'|'hours'|'days'), start_time, days: [0-6], time, day_of_month, once_date, once_time },
 *   end_date ('YYYY-MM-DD' or ''), max_runs (number or '')
 * Returns { ok: true, row, nextRun } or { ok: false, error }. Times are read in `tz`.
 */
export function validatePostInput(input, guild, tz, now = new Date()) {
  if (!guild) return { ok: false, error: 'The bot cannot see this server right now. Try again in a minute.' };
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
  if (/[<>]/.test(name)) return { ok: false, error: 'The name must be plain text (no < or >).' };
  if ([...name].length > NAME_MAX) return { ok: false, error: `The name can be at most ${NAME_MAX} characters.` };

  const channelId = String(input.channel_id ?? '').trim();
  const channel = SNOWFLAKE.test(channelId) ? guild.channels.cache.get(channelId) : null;
  if (!channel || ![0, 5].includes(channel.type)) return { ok: false, error: 'Choose a text or announcement channel in this server.' };

  const content = String(input.message_content ?? '').replace(/\r\n/g, '\n').trim();
  if (content.length > CONTENT_MAX - PING_ROOM) return { ok: false, error: `The message can be at most ${CONTENT_MAX - PING_ROOM} characters.` };

  const built = buildEmbedData(input.embed);
  if (built.error) return { ok: false, error: built.error };
  if (!content && !built.embed) return { ok: false, error: 'Write a message, an embed, or both.' };

  let ping = String(input.ping_role_id ?? '').trim();
  if (ping && ping !== 'everyone') {
    if (!SNOWFLAKE.test(ping) || !guild.roles.cache.has(ping) || ping === guild.id) return { ok: false, error: 'The role to ping is not in this server.' };
  }

  // Schedule
  const sc = input.schedule && typeof input.schedule === 'object' ? input.schedule : {};
  let scheduleType;
  let scheduleValue;
  switch (sc.mode) {
    case 'interval': {
      const n = Number.parseInt(sc.interval_value, 10);
      const unit = { minutes: 1, hours: 60, days: 1440 }[sc.interval_unit];
      if (!Number.isInteger(n) || n < 1 || !unit) return { ok: false, error: 'Enter how often to post.' };
      const minutes = n * unit;
      if (minutes < MIN_INTERVAL_MINUTES) return { ok: false, error: `Posts can repeat at most every ${MIN_INTERVAL_MINUTES} minutes.` };
      if (minutes > MAX_INTERVAL_MINUTES) return { ok: false, error: 'The gap between posts can be at most 90 days.' };
      let start = null;
      if (String(sc.start_time ?? '').trim()) {
        start = parseClock(sc.start_time);
        if (!start) return { ok: false, error: 'The start time must look like 09:00.' };
      }
      scheduleType = 'interval';
      scheduleValue = start ? `${minutes}@${clock(start)}` : String(minutes);
      break;
    }
    case 'days': {
      const time = parseClock(sc.time);
      if (!time) return { ok: false, error: 'The time must look like 09:00.' };
      const days = [...new Set((Array.isArray(sc.days) ? sc.days : String(sc.days ?? '').split(','))
        .map((d) => Number.parseInt(d, 10)).filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
      if (!days.length) return { ok: false, error: 'Pick at least one day.' };
      scheduleType = days.length === 7 ? 'daily' : 'weekly';
      scheduleValue = days.length === 7 ? clock(time) : `${days.join(',')} ${clock(time)}`;
      break;
    }
    case 'monthly': {
      const time = parseClock(sc.time);
      const day = Number.parseInt(sc.day_of_month, 10);
      if (!time) return { ok: false, error: 'The time must look like 09:00.' };
      if (!Number.isInteger(day) || day < 1 || day > 31) return { ok: false, error: 'The day of the month must be from 1 to 31.' };
      scheduleType = 'monthly';
      scheduleValue = `${day} ${clock(time)}`;
      break;
    }
    case 'once': {
      const dm = String(sc.once_date ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const time = parseClock(sc.once_time);
      if (!dm || !time) return { ok: false, error: 'Choose the date and time to post.' };
      const at = zonedTimeToUtc(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), time.h, time.m, tz);
      if (Number.isNaN(at.getTime())) return { ok: false, error: 'That date is not valid.' };
      if (at <= now) return { ok: false, error: 'That date and time has already passed.' };
      if (at.getTime() - now.getTime() > 400 * 86400000) return { ok: false, error: 'Pick a date within the next year.' };
      scheduleType = 'once';
      scheduleValue = at.toISOString();
      break;
    }
    default:
      return { ok: false, error: 'Choose when to post.' };
  }

  let endAt = null;
  if (String(input.end_date ?? '').trim() && scheduleType !== 'once') {
    const em = String(input.end_date).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!em) return { ok: false, error: 'The end date is not valid.' };
    endAt = zonedTimeToUtc(Number(em[1]), Number(em[2]) - 1, Number(em[3]), 23, 59, tz);
    if (endAt <= now) return { ok: false, error: 'The end date has already passed.' };
    if (endAt.getTime() - now.getTime() > 5 * 366 * 86400000) return { ok: false, error: 'Pick an end date within the next five years.' };
  }
  let maxRuns = null;
  if (String(input.max_runs ?? '').trim() && scheduleType !== 'once') {
    maxRuns = Number.parseInt(input.max_runs, 10);
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 10000) return { ok: false, error: 'Stop after must be a number of posts from 1 to 10000.' };
  }

  const nextRun = computeNextRun(scheduleType, scheduleValue, tz, now);
  if (!nextRun) return { ok: false, error: 'That schedule never posts.' };
  if (endAt && nextRun > endAt) return { ok: false, error: 'The end date is before the first post.' };

  const enabled = input.enabled === undefined ? 1 : (input.enabled === true || input.enabled === 1 || input.enabled === '1' || input.enabled === 'on' || input.enabled === 'true') ? 1 : 0;
  return {
    ok: true,
    nextRun,
    row: {
      name: name || null,
      channel_id: channelId,
      message_content: content,
      embed_data: built.embed ? JSON.stringify(built.embed) : null,
      ping_role_id: ping || null,
      schedule_type: scheduleType,
      schedule_value: scheduleValue,
      end_at: endAt,
      max_runs: maxRuns,
      enabled,
    },
  };
}

/** A row's schedule as the dashboard's editor fields. */
export function scheduleFields(row, tz) {
  const out = { mode: 'interval', interval_value: 1, interval_unit: 'days', start_time: '', days: [], time: '09:00', day_of_month: 1, once_date: '', once_time: '' };
  switch (row.schedule_type) {
    case 'interval': {
      const iv = parseInterval(row.schedule_value);
      if (iv) {
        const m = iv.minutes;
        if (m % 1440 === 0) Object.assign(out, { interval_value: m / 1440, interval_unit: 'days' });
        else if (m % 60 === 0) Object.assign(out, { interval_value: m / 60, interval_unit: 'hours' });
        else Object.assign(out, { interval_value: m, interval_unit: 'minutes' });
        if (iv.start) out.start_time = clock(iv.start);
      }
      break;
    }
    case 'daily': {
      const t = parseClock(row.schedule_value);
      Object.assign(out, { mode: 'days', days: [0, 1, 2, 3, 4, 5, 6], time: t ? clock(t) : '09:00' });
      break;
    }
    case 'weekly': {
      const w = parseWeekly(row.schedule_value);
      Object.assign(out, { mode: 'days', days: w ? w.days : [], time: w ? clock(w.time) : '09:00' });
      break;
    }
    case 'monthly': {
      const mo = parseMonthly(row.schedule_value);
      Object.assign(out, { mode: 'monthly', day_of_month: mo ? mo.day : 1, time: mo ? clock(mo.time) : '09:00' });
      break;
    }
    case 'once': {
      const at = new Date(row.schedule_value);
      if (!Number.isNaN(at.getTime())) {
        const p = getLocalDateParts(at, tz);
        Object.assign(out, { mode: 'once', once_date: `${p.year}-${pad(p.month + 1)}-${pad(p.day)}`, once_time: `${pad(p.hour)}:${pad(p.minute)}` });
      } else out.mode = 'once';
      break;
    }
    default: break;
  }
  return out;
}

function clientFor(guildId, fallback) {
  return global.botManager?.getClientForGuild?.(guildId) || fallback;
}

class ScheduledAnnouncementsManager {
  constructor(client) {
    this.client = client;
    this.checking = false;
    logger.info('[ScheduledAnnouncementsManager] Scheduled announcements manager initialized');
  }

  /**
   * Post everything that is due. One pass covers every bot: each row is sent by the client that
   * serves its guild (a custom bot when the guild has one), so a guild run by a custom bot is
   * neither skipped nor posted twice.
   */
  async checkDueAnnouncements() {
    if (this.checking) return; // a slow pass must not overlap the next minute's
    this.checking = true;
    try {
      const [announcements] = await pool.execute(
        'SELECT * FROM scheduled_announcements WHERE enabled = 1 AND next_run <= NOW() ORDER BY next_run ASC LIMIT 200'
      );
      if (announcements.length === 0) return;
      logger.info(`[ScheduledAnnouncementsManager] Found ${announcements.length} due announcements`);
      for (const announcement of announcements) {
        await this.runDue(announcement);
      }
    } catch (error) {
      logger.error(`[ScheduledAnnouncementsManager] Error checking announcements: ${error.message}`);
    } finally {
      this.checking = false;
    }
  }

  /** Move a due row to its next time (claiming it), then post it. */
  async runDue(row) {
    try {
      const tz = await getGuildTimezone(row.guild_id);
      const now = new Date();
      const expired = row.end_at && new Date(row.end_at) <= now;
      const next = expired ? null : computeNextRun(row.schedule_type, row.schedule_value, tz, now, row.next_run);
      const keepGoing = next && !(row.end_at && next > new Date(row.end_at));
      const [claim] = await pool.execute(
        'UPDATE scheduled_announcements SET next_run = ?, enabled = ? WHERE id = ? AND enabled = 1 AND next_run <= NOW()',
        [next || row.next_run, keepGoing ? 1 : 0, row.id]
      );
      if (!claim.affectedRows || expired) return;
      await this.sendAnnouncement(row, { countRun: true });
    } catch (error) {
      logger.error(`[ScheduledAnnouncementsManager] Failed to run announcement ${row.id}: ${error.message}`, { guildId: row.guild_id });
    }
  }

  /**
   * Post a row now. countRun: a scheduled post (counts towards max_runs and updates last_run);
   * a "Send now" test from the dashboard does not. Returns { ok } or { ok: false, error }.
   */
  async sendAnnouncement(announcement, { countRun = true } = {}) {
    const client = clientFor(announcement.guild_id, this.client);
    try {
      const guild = client.guilds.cache.get(announcement.guild_id);
      if (!guild) {
        logger.warn(`[ScheduledAnnouncementsManager] Guild ${announcement.guild_id} not available for announcement ${announcement.id}`);
        return { ok: false, error: 'The bot is not in this server right now.' };
      }

      const channel = guild.channels.cache.get(announcement.channel_id)
        || await guild.channels.fetch(announcement.channel_id).catch(() => null);
      if (!channel) {
        logger.warn(`[ScheduledAnnouncementsManager] Channel ${announcement.channel_id} not found, disabling announcement ${announcement.id}`);
        await pool.execute('UPDATE scheduled_announcements SET enabled = 0, last_error = ? WHERE id = ?', ['Its channel was deleted', announcement.id]);
        const preview = String(announcement.message_content || '').trim();
        void logFeatureEvent(() => (guild), 'system.featureDisabled', () => ({
          title: '⛔ Feature Auto-Disabled',
          description: 'A scheduled message was turned off because the channel it posts to no longer exists. It will not post again until it is set up with a channel that exists.',
          fields: [
            ['Feature', 'Scheduled message'],
            ['Why', 'Its channel was deleted'],
            ['Message', announcement.name ? announcement.name : `#${announcement.id}`],
            ['Channel', `<#${announcement.channel_id}>`],
            ['Text', preview ? (preview.length > 150 ? `${preview.slice(0, 149)}…` : preview) : null, false],
          ],
        }));
        return { ok: false, error: 'The channel no longer exists, so the message was turned off.' };
      }
      if (!channel.isTextBased()) return { ok: false, error: 'That channel cannot hold messages.' };

      const payload = buildPayload(announcement);
      if (!payload.content && !payload.embeds.length) return { ok: false, error: 'The message is empty.' };
      await channel.send(payload);

      if (countRun) {
        await pool.execute(
          `UPDATE scheduled_announcements
              SET enabled = IF(max_runs IS NOT NULL AND run_count + 1 >= max_runs, 0, enabled),
                  run_count = run_count + 1, last_run = NOW(), last_error = NULL
            WHERE id = ?`,
          [announcement.id]
        );
      } else if (announcement.last_error) {
        await pool.execute('UPDATE scheduled_announcements SET last_error = NULL WHERE id = ?', [announcement.id]);
      }

      logger.info(`[ScheduledAnnouncementsManager] Sent announcement ${announcement.id} to ${channel.name}`, {
        guildId: guild.id,
        announcementId: announcement.id,
        test: !countRun,
      });
      return { ok: true };
    } catch (error) {
      const why = error.code === 50013 || error.code === 50001
        ? 'The bot is missing permission to post in that channel.'
        : String(error.message || 'Sending failed').slice(0, 240);
      await pool.execute('UPDATE scheduled_announcements SET last_error = ? WHERE id = ?', [why, announcement.id]).catch(() => {});
      logger.error(`[ScheduledAnnouncementsManager] Failed to send announcement ${announcement.id}: ${error.message}`, {
        announcementId: announcement.id,
        error: error.message
      });
      return { ok: false, error: why };
    }
  }

  /** /alerts scheduled create. Throws on a schedule value that never posts. */
  async createAnnouncement(guildId, channelId, messageContent, scheduleType, scheduleValue, embedData, createdBy) {
    try {
      const tz = await getGuildTimezone(guildId);
      const nextRun = computeNextRun(scheduleType, scheduleValue, tz);
      if (!nextRun) throw new Error('That schedule value is not valid. Use daily="14:00", weekly="Monday 14:00", monthly="15 12:00" or interval=minutes.');

      const [result] = await pool.execute(`
        INSERT INTO scheduled_announcements
        (guild_id, channel_id, message_content, embed_data, schedule_type, schedule_value, next_run, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [guildId, channelId, messageContent, embedData ? JSON.stringify(embedData) : null, scheduleType, scheduleValue, nextRun, createdBy]);

      logger.info(`[ScheduledAnnouncementsManager] Created announcement ${result.insertId}`, { guildId, scheduleType });
      return result.insertId;
    } catch (error) {
      logger.error(`[ScheduledAnnouncementsManager] Failed to create announcement: ${error.message}`, { guildId });
      throw error;
    }
  }

  /** The first post time for a schedule, in the guild's timezone (null when it never posts). */
  async calculateNextRunFromParams(scheduleType, scheduleValue, guildId = null) {
    const tz = guildId ? await getGuildTimezone(guildId) : 'UTC';
    return computeNextRun(scheduleType, scheduleValue, tz);
  }

  async updateAnnouncement(announcementId, updates) {
    try {
      const setParts = [];
      const values = [];

      if (updates.messageContent !== undefined) {
        setParts.push('message_content = ?');
        values.push(updates.messageContent);
      }
      if (updates.embedData !== undefined) {
        setParts.push('embed_data = ?');
        values.push(updates.embedData ? JSON.stringify(updates.embedData) : null);
      }
      if (updates.scheduleType !== undefined && updates.scheduleValue !== undefined) {
        const row = await this.getAnnouncement(announcementId);
        const nextRun = await this.calculateNextRunFromParams(updates.scheduleType, updates.scheduleValue, row?.guild_id);
        if (!nextRun) return false;
        setParts.push('schedule_type = ?', 'schedule_value = ?', 'next_run = ?');
        values.push(updates.scheduleType, updates.scheduleValue, nextRun);
      }

      if (setParts.length === 0) {
        return false;
      }

      values.push(announcementId);
      await pool.execute(
        `UPDATE scheduled_announcements SET ${setParts.join(', ')} WHERE id = ?`,
        values
      );

      logger.info(`[ScheduledAnnouncementsManager] Updated announcement ${announcementId}`);
      return true;
    } catch (error) {
      logger.error(`[ScheduledAnnouncementsManager] Failed to update announcement: ${error.message}`);
      return false;
    }
  }

  async deleteAnnouncement(announcementId) {
    try {
      await pool.execute('DELETE FROM scheduled_announcements WHERE id = ?', [announcementId]);
      logger.info(`[ScheduledAnnouncementsManager] Deleted announcement ${announcementId}`);
      return true;
    } catch (error) {
      logger.error(`[ScheduledAnnouncementsManager] Failed to delete announcement: ${error.message}`);
      return false;
    }
  }

  async toggleAnnouncement(announcementId, enabled) {
    try {
      if (enabled) {
        // Turning a post back on: start again from its next time after now, not from a time long past.
        const row = await this.getAnnouncement(announcementId);
        if (row) {
          const tz = await getGuildTimezone(row.guild_id);
          const next = computeNextRun(row.schedule_type, row.schedule_value, tz, new Date(), row.schedule_type === 'interval' ? row.next_run : null);
          if (next) await pool.execute('UPDATE scheduled_announcements SET next_run = ? WHERE id = ?', [next, announcementId]);
        }
      }
      await pool.execute('UPDATE scheduled_announcements SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, announcementId]);
      logger.info(`[ScheduledAnnouncementsManager] Toggled announcement ${announcementId} to ${enabled}`);
      return true;
    } catch (error) {
      logger.error(`[ScheduledAnnouncementsManager] Failed to toggle announcement: ${error.message}`);
      return false;
    }
  }

  async getGuildAnnouncements(guildId) {
    try {
      const [announcements] = await pool.execute(
        'SELECT * FROM scheduled_announcements WHERE guild_id = ? ORDER BY next_run ASC',
        [guildId]
      );
      return announcements;
    } catch (error) {
      logger.error(`[ScheduledAnnouncementsManager] Failed to get announcements: ${error.message}`, { guildId });
      return [];
    }
  }

  async getAnnouncement(announcementId) {
    try {
      const [announcements] = await pool.execute(
        'SELECT * FROM scheduled_announcements WHERE id = ?',
        [announcementId]
      );
      return announcements[0] || null;
    } catch (error) {
      logger.error(`[ScheduledAnnouncementsManager] Failed to get announcement: ${error.message}`);
      return null;
    }
  }
}

export default ScheduledAnnouncementsManager;
