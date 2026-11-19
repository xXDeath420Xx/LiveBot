/**
 * Holiday countdown engine.
 *
 * Holiday catalog is in-code because the shape rarely changes and keeping it
 * close to the date-math makes new entries one-file edits. Per-guild config
 * (which holidays are enabled, which channel to post in, etc.) lives in the
 * `holiday_countdowns` MySQL table (migration 363). Lunar / variable-date
 * holidays whose next occurrence can't be computed cheaply are seeded in
 * `holiday_lunar_dates` and read live.
 *
 * Dates are computed in UTC. Days-remaining is defined as "midnight UTC of
 * the holiday minus midnight UTC of today" so a server in any TZ sees a
 * sensible single-day resolution. The one place the server's own timezone
 * matters is the "post on the day" message (jobs/holiday-day-announcer.js),
 * which goes out on the holiday's date as observed in guild_settings.timezone.
 *
 * Per-guild settings (holiday_countdowns): `enabled = 0` stops the holiday's
 * pinned message and auto-replies from being created or updated in that
 * guild, and label_override / emoji_override replace the catalog name and
 * emoji in everything the bot posts there (computeGuildCountdown). The public
 * /countdown/<slug> pages have no guild context and always use the catalog.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder } from 'discord.js';

const LOG = '[HolidayManager]';

// Holiday catalog. `kind` picks the resolver that produces the next date.
//   fixed-date   : month/day each year
//   nth-weekday  : the Nth <weekday> of <month> (US thanksgiving etc.)
//   last-weekday : the LAST <weekday> of <month> (memorial day etc.)
//   easter       : computus (Gauss/Meeus — Western / Gregorian)
//   lunar-table  : look up holiday_lunar_dates by (slug, year)
export const HOLIDAY_CATALOG = Object.freeze([
    { slug: 'christmas',       label: 'Christmas',           emoji: '🎄', kind: 'fixed-date',  month: 12, day: 25 },
    { slug: 'new-years-eve',   label: "New Year's Eve",      emoji: '🥂', kind: 'fixed-date',  month: 12, day: 31 },
    { slug: 'new-year',        label: 'New Year',            emoji: '🎉', kind: 'fixed-date',  month: 1,  day: 1 },
    { slug: 'halloween',       label: 'Halloween',           emoji: '🎃', kind: 'fixed-date',  month: 10, day: 31 },
    { slug: 'valentines',      label: "Valentine's Day",     emoji: '💝', kind: 'fixed-date',  month: 2,  day: 14 },
    { slug: 'st-patricks',     label: "St. Patrick's Day",   emoji: '☘️', kind: 'fixed-date',  month: 3,  day: 17 },
    { slug: 'fourtwenty',      label: '4/20',                emoji: '🌿', kind: 'fixed-date',  month: 4,  day: 20 },
    { slug: 'independence-us', label: 'Independence Day',    emoji: '🇺🇸', kind: 'fixed-date',  month: 7,  day: 4 },
    { slug: 'canada-day',      label: 'Canada Day',          emoji: '🇨🇦', kind: 'fixed-date',  month: 7,  day: 1 },
    { slug: 'juneteenth',      label: 'Juneteenth',          emoji: '🎊', kind: 'fixed-date',  month: 6,  day: 19 },
    { slug: 'thanksgiving-us', label: 'Thanksgiving (US)',   emoji: '🦃', kind: 'nth-weekday', month: 11, weekday: 4, n: 4 },
    { slug: 'thanksgiving-ca', label: 'Thanksgiving (CA)',   emoji: '🍁', kind: 'nth-weekday', month: 10, weekday: 1, n: 2 },
    { slug: 'mothers-day-us',  label: "Mother's Day",        emoji: '💐', kind: 'nth-weekday', month: 5,  weekday: 0, n: 2 },
    { slug: 'fathers-day-us',  label: "Father's Day",        emoji: '👔', kind: 'nth-weekday', month: 6,  weekday: 0, n: 3 },
    { slug: 'labor-day-us',    label: 'Labor Day',           emoji: '🛠️', kind: 'nth-weekday', month: 9,  weekday: 1, n: 1 },
    { slug: 'memorial-day-us', label: 'Memorial Day',        emoji: '🇺🇸', kind: 'last-weekday', month: 5, weekday: 1 },
    { slug: 'mlk-day',         label: 'MLK Jr. Day',         emoji: '🕊️', kind: 'nth-weekday', month: 1,  weekday: 1, n: 3 },
    { slug: 'easter',          label: 'Easter Sunday',       emoji: '🐣', kind: 'easter' },
    { slug: 'lunar-new-year',  label: 'Lunar New Year',      emoji: '🧧', kind: 'lunar-table' },
    { slug: 'diwali',          label: 'Diwali',              emoji: '🪔', kind: 'lunar-table' },
    { slug: 'hanukkah',        label: 'Hanukkah',            emoji: '🕎', kind: 'lunar-table' },
    { slug: 'ramadan',         label: 'Ramadan',             emoji: '🌙', kind: 'lunar-table' },
    { slug: 'eid-al-fitr',     label: 'Eid al-Fitr',         emoji: '🌙', kind: 'lunar-table' },
]);

export const CATALOG_BY_SLUG = new Map(HOLIDAY_CATALOG.map(h => [h.slug, h]));

export function listCatalog() {
    return HOLIDAY_CATALOG;
}

export function getHoliday(slug) {
    return CATALOG_BY_SLUG.get(String(slug || '').trim().toLowerCase()) || null;
}

// ────────────────────────────────────────────────────────────────────────────
// Date math.
// ────────────────────────────────────────────────────────────────────────────

/** Returns a UTC Date pinned to 00:00:00 of y-m-d (m is 1-indexed). */
function utcDate(y, m, d) {
    return new Date(Date.UTC(y, m - 1, d));
}

function todayUtc() {
    const n = new Date();
    return utcDate(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate());
}

/** Nth `weekday` of `month` in `year`. weekday: 0=Sun .. 6=Sat. */
function nthWeekdayOfMonth(year, month, weekday, n) {
    const first = utcDate(year, month, 1);
    const firstWeekday = first.getUTCDay();
    const offset = (weekday - firstWeekday + 7) % 7;
    const day = 1 + offset + (n - 1) * 7;
    return utcDate(year, month, day);
}

/** Last `weekday` of `month` in `year`. */
function lastWeekdayOfMonth(year, month, weekday) {
    const next = utcDate(year, month + 1, 1);
    const lastDay = new Date(next.getTime() - 86400000);
    const offset = (lastDay.getUTCDay() - weekday + 7) % 7;
    return utcDate(year, month, lastDay.getUTCDate() - offset);
}

/**
 * Computus (Meeus/Jones/Butcher Gregorian algorithm) — Western Easter Sunday
 * for any Gregorian year. Returns a UTC date pinned to 00:00.
 */
function easterSundayUtc(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return utcDate(year, month, day);
}

/**
 * Look up a lunar / variable-date holiday from `holiday_lunar_dates`. Returns
 * the next future date for `slug` strictly on-or-after `fromDate`.
 */
async function nextLunarOccurrence(slug, fromDate) {
    const [rows] = await pool.execute(
        `SELECT occurs_on FROM holiday_lunar_dates
         WHERE slug = ? AND occurs_on >= ?
         ORDER BY occurs_on ASC LIMIT 1`,
        [slug, fromDate.toISOString().slice(0, 10)]
    );
    if (!rows.length) return null;
    const row = rows[0].occurs_on;
    // mariadb may return a Date already; coerce either way to UTC midnight.
    if (row instanceof Date) {
        return utcDate(row.getUTCFullYear(), row.getUTCMonth() + 1, row.getUTCDate());
    }
    const [y, m, d] = String(row).slice(0, 10).split('-').map(n => parseInt(n, 10));
    return utcDate(y, m, d);
}

/**
 * Return the next occurrence of `slug` strictly on-or-after today (UTC).
 * On the day of, days remaining is 0 — a server shouldn't flip to "next
 * year" until the holiday has passed.
 */
export async function nextOccurrence(slug, { from } = {}) {
    const h = getHoliday(slug);
    if (!h) return null;
    const today = from ? utcDate(from.getUTCFullYear(), from.getUTCMonth() + 1, from.getUTCDate()) : todayUtc();
    const year = today.getUTCFullYear();

    const candidate = (y) => {
        switch (h.kind) {
            case 'fixed-date':   return utcDate(y, h.month, h.day);
            case 'nth-weekday':  return nthWeekdayOfMonth(y, h.month, h.weekday, h.n);
            case 'last-weekday': return lastWeekdayOfMonth(y, h.month, h.weekday);
            case 'easter':       return easterSundayUtc(y);
            default:             return null;
        }
    };

    if (h.kind === 'lunar-table') {
        return await nextLunarOccurrence(slug, today);
    }

    const thisYear = candidate(year);
    if (thisYear && thisYear.getTime() >= today.getTime()) return thisYear;
    return candidate(year + 1);
}

export function daysBetween(a, b) {
    return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * Render a countdown summary for the given slug. Returns an object:
 *   { slug, label, emoji, nextDate, daysRemaining, isToday, year }
 */
export async function computeCountdown(slug, { from } = {}) {
    const h = getHoliday(slug);
    if (!h) return null;
    const today = from ? utcDate(from.getUTCFullYear(), from.getUTCMonth() + 1, from.getUTCDate()) : todayUtc();
    const next = await nextOccurrence(slug, { from: today });
    if (!next) return null;
    const days = daysBetween(today, next);
    return {
        slug: h.slug,
        label: h.label,
        emoji: h.emoji,
        nextDate: next,
        daysRemaining: days,
        isToday: days === 0,
        year: next.getUTCFullYear(),
    };
}

// Format a date as e.g. "Fri · Dec 25, 2026" using Intl (no deps).
export function formatHolidayDate(d) {
    try {
        return new Intl.DateTimeFormat('en-US', {
            weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
        }).format(d);
    } catch { return d.toISOString().slice(0, 10); }
}

// ────────────────────────────────────────────────────────────────────────────
// Rendering helpers.
// ────────────────────────────────────────────────────────────────────────────

export function buildCountdownEmbed(info, { linkUrl = null, mention = null } = {}) {
    const headline = info.isToday
        ? `${info.emoji} Today is ${info.label}!`
        : `${info.emoji} ${info.daysRemaining} day${info.daysRemaining === 1 ? '' : 's'} until ${info.label}`;
    const bars = countdownBar(info);

    const embed = new EmbedBuilder()
        .setTitle(headline)
        .setDescription([
            `**${formatHolidayDate(info.nextDate)}**`,
            bars,
            linkUrl ? `-# [Open live countdown](${linkUrl})` : null,
        ].filter(Boolean).join('\n'))
        .setColor(colorForHoliday(info.slug));

    if (mention) embed.setFooter({ text: mention });
    return embed;
}

/** Simple ASCII-ish bar as a visual anchor. Doesn't try to be art. */
function countdownBar(info) {
    if (info.isToday) return '🎉'.repeat(10);
    // Scale against the longest a countdown realistically sits in Discord — a
    // year out shows an almost-empty bar; same day shows nearly-full.
    const total = 365;
    const filled = Math.min(10, Math.max(0, Math.round(((total - info.daysRemaining) / total) * 10)));
    return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

function colorForHoliday(slug) {
    const map = {
        'christmas': 0xC8102E,
        'new-year': 0xFFD700,
        'new-years-eve': 0xFFD700,
        'halloween': 0xFF7F11,
        'valentines': 0xFF4F79,
        'st-patricks': 0x1F8B4C,
        'fourtwenty': 0x3BA55D,
        'independence-us': 0x2C7AC9,
        'canada-day': 0xC8102E,
        'juneteenth': 0xE4572E,
        'thanksgiving-us': 0xB36B2E,
        'thanksgiving-ca': 0xB36B2E,
        'mothers-day-us': 0xE88AAE,
        'fathers-day-us': 0x3B6E8F,
        'labor-day-us': 0x5865F2,
        'memorial-day-us': 0x2C7AC9,
        'mlk-day': 0x5865F2,
        'easter': 0xFFC0CB,
        'lunar-new-year': 0xE43B3B,
        'diwali': 0xE49B0F,
        'hanukkah': 0x3B6E8F,
        'ramadan': 0x4B8673,
        'eid-al-fitr': 0x4B8673,
    };
    return map[slug] ?? 0x5865F2;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-guild config.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Return the per-guild config for every holiday. Rows that haven't been
 * written to DB yet default to `enabled: true` (announce-on-day only comes
 * into effect when a channel is configured). We merge DB rows into the full
 * catalog so the UI always shows every holiday whether configured or not.
 * `label`/`emoji` are what the bot posts; `defaultLabel`/`defaultEmoji` are the
 * catalog values and `labelOverride`/`emojiOverride` the raw stored overrides.
 */
export async function listGuildConfig(guildId) {
    const [rows] = await pool.execute(
        `SELECT slug, enabled, announce_channel_id, announce_on_day, mention_role_id,
                emoji_override, label_override
           FROM holiday_countdowns WHERE guild_id = ?`,
        [guildId]
    );
    const byslug = new Map(rows.map(r => [r.slug, r]));
    return HOLIDAY_CATALOG.map(h => {
        const r = byslug.get(h.slug);
        return {
            ...h,
            enabled: r ? !!r.enabled : true,
            announceChannelId: r?.announce_channel_id || null,
            announceOnDay: r ? !!r.announce_on_day : true,
            mentionRoleId: r?.mention_role_id || null,
            emoji: r?.emoji_override || h.emoji,
            label: r?.label_override || h.label,
            defaultEmoji: h.emoji,
            defaultLabel: h.label,
            emojiOverride: r?.emoji_override || null,
            labelOverride: r?.label_override || null,
        };
    });
}

/** The stored row for one (guild, holiday), or null. Never throws — a read failure means "defaults". */
export async function getGuildHolidayRow(guildId, slug) {
    if (!guildId || !slug) return null;
    try {
        const [[row]] = await pool.execute(
            `SELECT enabled, emoji_override, label_override
               FROM holiday_countdowns WHERE guild_id = ? AND slug = ? LIMIT 1`,
            [String(guildId), String(slug)]
        );
        return row || null;
    } catch (e) {
        logger.warn(`${LOG} guild config read failed`, { guildId, slug, err: e.message });
        return null;
    }
}

/** Copy of a computeCountdown() result with the guild's label/emoji and its `enabled` flag. */
export function applyGuildHolidayConfig(info, row) {
    if (!info) return info;
    return {
        ...info,
        label: row?.label_override || info.label,
        emoji: row?.emoji_override || info.emoji,
        enabled: row ? !!row.enabled : true,
    };
}

/**
 * computeCountdown() as seen by one guild: label/emoji overrides applied and
 * `enabled` set. Use this for anything the bot posts into a guild.
 */
export async function computeGuildCountdown(guildId, slug, opts = {}) {
    const info = await computeCountdown(slug, opts);
    if (!info) return null;
    return applyGuildHolidayConfig(info, await getGuildHolidayRow(guildId, slug));
}

/**
 * Write per-guild settings for one holiday. Only keys present in `patch`
 * (not undefined) are written; null / '' clears an optional column.
 *   enabled, announceOnDay           boolean
 *   announceChannelId, mentionRoleId snowflake | null
 *   labelOverride, emojiOverride     string | null
 * Callers validate channel/role ownership; this only stores.
 */
export async function upsertGuildConfig(guildId, slug, patch = {}) {
    if (!getHoliday(slug)) throw new Error(`unknown holiday slug: ${slug}`);
    const bool = v => (v ? 1 : 0);
    const optional = v => (v === null || v === '' ? null : String(v));
    const map = [
        ['enabled', 'enabled', bool],
        ['announceChannelId', 'announce_channel_id', optional],
        ['announceOnDay', 'announce_on_day', bool],
        ['mentionRoleId', 'mention_role_id', optional],
        ['emojiOverride', 'emoji_override', optional],
        ['labelOverride', 'label_override', optional],
    ];
    const cols = map
        .filter(([key]) => patch[key] !== undefined)
        .map(([key, col, fn]) => [col, fn(patch[key])]);
    if (!cols.length) return;

    // UPSERT via ON DUPLICATE KEY UPDATE on (guild_id, slug).
    const insertCols = ['guild_id', 'slug', ...cols.map(([c]) => c)];
    const insertVals = [guildId, slug, ...cols.map(([, v]) => v)];
    const placeholders = insertCols.map(() => '?').join(', ');
    const updates = cols.map(([c]) => `${c} = VALUES(${c})`).join(', ');
    await pool.execute(
        `INSERT INTO holiday_countdowns (${insertCols.join(', ')}) VALUES (${placeholders})
         ON DUPLICATE KEY UPDATE ${updates}`,
        insertVals
    );
}

// ────────────────────────────────────────────────────────────────────────────
// Live pinned-message updater.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Create or update the live pinned countdown message for (guildId, slug) in
 * `channelId`. If a pin row already exists for this holiday, the previous
 * message is edited in place; otherwise a new message is sent and the id
 * recorded. Returns the message object.
 */
export async function pinCountdownMessage(client, { guildId, slug, channelId }) {
    const info = await computeGuildCountdown(guildId, slug);
    if (!info) throw new Error(`unknown slug: ${slug}`);
    if (!info.enabled) throw new Error(`${info.label} is turned off for this server. Turn it on under Holiday countdowns first.`);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error('guild not visible to client');
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) throw new Error('channel not text-based or missing');

    const publicUrl = publicCountdownUrl(slug);
    const embed = buildCountdownEmbed(info, { linkUrl: publicUrl });

    const [[existing]] = await pool.execute(
        'SELECT message_id, channel_id FROM holiday_countdown_pins WHERE guild_id = ? AND slug = ?',
        [guildId, slug]
    );
    let message = null;
    if (existing?.message_id && existing.channel_id === channelId) {
        try {
            message = await channel.messages.fetch(existing.message_id);
            await message.edit({ embeds: [embed] });
        } catch (e) {
            logger.warn(`${LOG} edit failed; falling back to new post`, { err: e.message, slug, guildId });
            message = null;
        }
    }
    if (!message) {
        message = await channel.send({ embeds: [embed] });
        // Try to pin — if we lack perms, keep the row anyway (it still edits in place).
        try { await message.pin('Holiday countdown live message'); } catch { /* no perms */ }
    }

    await pool.execute(
        `INSERT INTO holiday_countdown_pins (guild_id, slug, channel_id, message_id, last_updated_at, last_days_remaining, failures_since_success, disabled_reason)
         VALUES (?, ?, ?, ?, NOW(), ?, 0, NULL)
         ON DUPLICATE KEY UPDATE
            channel_id = VALUES(channel_id),
            message_id = VALUES(message_id),
            last_updated_at = VALUES(last_updated_at),
            last_days_remaining = VALUES(last_days_remaining),
            failures_since_success = 0,
            disabled_reason = NULL`,
        [guildId, slug, channelId, message.id, info.daysRemaining]
    );
    return message;
}

export async function unpinCountdownMessage(client, { guildId, slug }) {
    const [[row]] = await pool.execute(
        'SELECT channel_id, message_id FROM holiday_countdown_pins WHERE guild_id = ? AND slug = ?',
        [guildId, slug]
    );
    if (!row) return false;
    const guild = client.guilds.cache.get(guildId);
    if (guild && row.message_id) {
        try {
            const ch = await guild.channels.fetch(row.channel_id).catch(() => null);
            if (ch?.isTextBased?.()) {
                const msg = await ch.messages.fetch(row.message_id).catch(() => null);
                if (msg) await msg.delete().catch(() => {});
            }
        } catch { /* best-effort delete */ }
    }
    await pool.execute(
        'DELETE FROM holiday_countdown_pins WHERE guild_id = ? AND slug = ?',
        [guildId, slug]
    );
    return true;
}

/**
 * Public countdown URL for OG unfurl. The daily cache-bust lets Discord
 * re-fetch the preview each day without the user re-sharing anything new —
 * most Discord cache keys include the full URL, so a date-stamped suffix
 * guarantees a fresh unfurl every 24 h.
 */
export function publicCountdownUrl(slug, { cacheBustDay = true } = {}) {
    const base = `https://certifriedmultitool.com/countdown/${encodeURIComponent(slug)}`;
    if (!cacheBustDay) return base;
    const today = todayUtc();
    const stamp = today.toISOString().slice(0, 10);
    return `${base}?d=${stamp}`;
}

/**
 * Iterate every live pin and edit its message to today's countdown. Called
 * once a day (and on boot after a short delay). Pins whose channel/message
 * can't be edited are marked disabled with a reason.
 */
export async function refreshAllPins(client) {
    const [pins] = await pool.execute(
        `SELECT * FROM holiday_countdown_pins WHERE disabled_reason IS NULL`
    );
    if (!pins.length) {
        logger.info(`${LOG} no live pins to refresh`);
        return { updated: 0, failed: 0, disabled: 0 };
    }
    let updated = 0, failed = 0, disabled = 0, skipped = 0;
    for (const p of pins) {
        try {
            const info = await computeGuildCountdown(p.guild_id, p.slug);
            if (!info) throw new Error(`unknown slug: ${p.slug}`);
            // Turned off for this guild: leave the message as it is and stop editing it.
            // Not a failure, so the pin is not disabled and resumes if switched back on.
            if (!info.enabled) { skipped++; continue; }
            const guild = client.guilds.cache.get(p.guild_id);
            if (!guild) { throw new Error('guild not visible'); }
            const channel = await guild.channels.fetch(p.channel_id).catch(() => null);
            if (!channel?.isTextBased?.()) throw new Error('channel missing');
            const message = p.message_id
                ? await channel.messages.fetch(p.message_id).catch(() => null)
                : null;
            if (!message) throw new Error('message missing');

            const embed = buildCountdownEmbed(info, { linkUrl: publicCountdownUrl(p.slug) });
            await message.edit({ embeds: [embed] });
            await pool.execute(
                `UPDATE holiday_countdown_pins
                    SET last_updated_at = NOW(), last_days_remaining = ?, failures_since_success = 0
                    WHERE id = ?`,
                [info.daysRemaining, p.id]
            );
            updated++;
        } catch (e) {
            failed++;
            const nextFailures = (p.failures_since_success || 0) + 1;
            // Three consecutive failures => disable so we stop spamming
            // Discord with the same error every day.
            if (nextFailures >= 3) {
                disabled++;
                await pool.execute(
                    `UPDATE holiday_countdown_pins
                       SET failures_since_success = ?, disabled_reason = ?
                       WHERE id = ?`,
                    [nextFailures, String(e.message).slice(0, 120), p.id]
                );
            } else {
                await pool.execute(
                    `UPDATE holiday_countdown_pins SET failures_since_success = ? WHERE id = ?`,
                    [nextFailures, p.id]
                );
            }
            logger.warn(`${LOG} refresh failed`, { pinId: p.id, slug: p.slug, err: e.message });
        }
    }
    logger.info(`${LOG} pin refresh pass`, { updated, failed, disabled, skipped });
    return { updated, failed, disabled, skipped };
}

// The "post on the day" message (announce_on_day / announce_channel_id /
// mention_role_id) is sent by jobs/holiday-day-announcer.js, which records the
// year it posted in holiday_countdowns.last_announced_year (migration 417).

let intervalHandle = null;
let bootTimeoutHandle = null;

/**
 * Also refresh URL auto-replies on the same schedule. We import lazily inside
 * the function so holiday-manager.js stays importable without the auto-reply
 * table existing (migrations run before this module loads).
 */
async function refreshBoth(client) {
    await refreshAllPins(client).catch(e => logger.warn(`${LOG} pin refresh failed: ${e.message}`));
    try {
        const { refreshAllAutoReplies } = await import('./holiday-auto-reply.js');
        await refreshAllAutoReplies(client).catch(e => logger.warn(`${LOG} auto-reply refresh failed: ${e.message}`));
    } catch (e) {
        logger.warn(`${LOG} auto-reply module import failed: ${e.message}`);
    }
}

/** Start the pin refresher. Safe to call repeatedly; replaces prior timers. */
export function startHolidayPinUpdater(client) {
    if (intervalHandle) clearInterval(intervalHandle);
    if (bootTimeoutHandle) clearTimeout(bootTimeoutHandle);

    // Boot refresh after a short delay (member/channel caches warm), then
    // every 6 hours. Days-remaining changes once per day, but a 6-hour cadence
    // keeps the pin lively even if we restart around midnight.
    bootTimeoutHandle = setTimeout(() => {
        refreshBoth(client).catch(e => logger.warn(`${LOG} boot refresh failed: ${e.message}`));
    }, 30_000);

    intervalHandle = setInterval(() => {
        refreshBoth(client).catch(e => logger.warn(`${LOG} interval refresh failed: ${e.message}`));
    }, 6 * 60 * 60 * 1000);

    logger.info(`${LOG} pin updater started (boot refresh in 30s, interval 6h)`);
}

export function stopHolidayPinUpdater() {
    if (intervalHandle) clearInterval(intervalHandle);
    if (bootTimeoutHandle) clearTimeout(bootTimeoutHandle);
    intervalHandle = null;
    bootTimeoutHandle = null;
}
