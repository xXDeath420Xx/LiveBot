/**
 * Holiday "post on the day" announcer.
 *
 * Every 15 minutes, for each holiday_countdowns row with enabled = 1,
 * announce_on_day = 1 and an announce_channel_id, posts "Today is <label>!"
 * once on the holiday's date as observed in the guild's timezone
 * (guild_settings.timezone via utils/guild-timezone.js; UTC when unset), from
 * ANNOUNCE_LOCAL_HOUR local time onward so a role ping does not land at
 * midnight. The role in mention_role_id is pinged, and allowedMentions is
 * limited to that one role.
 *
 * Exactly-once: the row is claimed by setting last_announced_year (migration
 * 417) to the holiday's year with a conditional UPDATE *before* sending, so a
 * restart, a second tick, or a second process can never post twice. If the send
 * fails the claim is released for another try, at most MAX_SEND_ATTEMPTS times
 * per holiday per year (counted in memory), after which that year is skipped.
 *
 * Until migration 417 is applied the column is missing and this job posts
 * nothing (it logs that once) rather than posting without a de-dupe record.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { escapeMarkdown } from 'discord.js';
import { getGuildTimezone, getLocalDateParts } from '../utils/guild-timezone.js';
import { getHoliday, computeCountdown, applyGuildHolidayConfig } from '../core/holiday-manager.js';

const LOG = '[HolidayDayAnnouncer]';
const INTERVAL_MS = 15 * 60 * 1000;
const BOOT_DELAY_MS = 90 * 1000;
const MAX_SEND_ATTEMPTS = 3;

/** Local hour (0-23, in the guild's timezone) from which the day's post may go out. */
export const ANNOUNCE_LOCAL_HOUR = 9;

let intervalHandle = null;
let bootHandle = null;
let running = false;
let warnedMissingColumn = false;
const sendFailures = new Map(); // `${rowId}:${year}` -> failed attempts

/** The client that serves this guild (custom bot when one is mapped), else the default. */
function clientFor(client, guildId) {
    try {
        return global.botManager?.getClientForGuild?.(guildId) || client;
    } catch {
        return client;
    }
}

/**
 * One pass. Exported so it can be run by hand; `now` is injectable for testing.
 * Returns { checked, posted, failed }.
 */
export async function runHolidayDayAnnouncements(client, now = new Date()) {
    let rows;
    try {
        [rows] = await pool.execute(
            `SELECT id, guild_id, slug, announce_channel_id, mention_role_id,
                    emoji_override, label_override, enabled, last_announced_year
               FROM holiday_countdowns
              WHERE enabled = 1 AND announce_on_day = 1
                AND announce_channel_id IS NOT NULL AND announce_channel_id <> ''`
        );
    } catch (e) {
        if (e.code === 'ER_BAD_FIELD_ERROR') {
            if (!warnedMissingColumn) {
                warnedMissingColumn = true;
                logger.warn(`${LOG} holiday_countdowns.last_announced_year is missing (migration 417 not applied); not posting until it is`);
            }
            return { checked: 0, posted: 0, failed: 0 };
        }
        throw e;
    }

    let posted = 0, failed = 0;
    const tzCache = new Map();
    for (const row of rows) {
        try {
            if (!getHoliday(row.slug)) continue;

            if (!tzCache.has(row.guild_id)) tzCache.set(row.guild_id, await getGuildTimezone(row.guild_id));
            const local = getLocalDateParts(now, tzCache.get(row.guild_id));
            if (local.hour < ANNOUNCE_LOCAL_HOUR) continue;

            // Today's date in the guild's zone, pinned to UTC midnight (what computeCountdown expects).
            const localToday = new Date(Date.UTC(local.year, local.month, local.day));
            const info = await computeCountdown(row.slug, { from: localToday });
            if (!info?.isToday) continue;

            const year = info.year;
            if (row.last_announced_year != null && Number(row.last_announced_year) >= year) continue;
            const failKey = `${row.id}:${year}`;
            if ((sendFailures.get(failKey) || 0) >= MAX_SEND_ATTEMPTS) continue;

            const botClient = clientFor(client, row.guild_id);
            const guild = botClient?.guilds?.cache?.get(row.guild_id);
            if (!guild) continue; // bot not in the guild (or not ready yet) — try next tick
            const channel = await guild.channels.fetch(row.announce_channel_id).catch(() => null);
            if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
                logger.warn(`${LOG} channel missing or not text`, { guildId: row.guild_id, slug: row.slug, channelId: row.announce_channel_id });
                sendFailures.set(failKey, MAX_SEND_ATTEMPTS); // nothing to retry against today
                continue;
            }

            // Claim first: only the process whose UPDATE changes the row may send.
            const [claim] = await pool.execute(
                `UPDATE holiday_countdowns SET last_announced_year = ?
                  WHERE id = ? AND (last_announced_year IS NULL OR last_announced_year < ?)`,
                [year, row.id, year]
            );
            if (!claim.affectedRows) continue;

            const shown = applyGuildHolidayConfig(info, row);
            const roleId = row.mention_role_id && /^\d{15,25}$/.test(row.mention_role_id) ? row.mention_role_id : null;
            const text = `${shown.emoji} **Today is ${escapeMarkdown(shown.label)}!**`;
            try {
                await channel.send({
                    content: roleId ? `<@&${roleId}> ${text}` : text,
                    allowedMentions: roleId ? { parse: [], roles: [roleId] } : { parse: [] },
                });
                posted++;
                sendFailures.delete(failKey);
                logger.info(`${LOG} posted`, { guildId: row.guild_id, slug: row.slug, channelId: channel.id, year });
            } catch (e) {
                failed++;
                const attempts = (sendFailures.get(failKey) || 0) + 1;
                sendFailures.set(failKey, attempts);
                if (attempts < MAX_SEND_ATTEMPTS) {
                    // Release the claim so the next tick retries.
                    await pool.execute(
                        'UPDATE holiday_countdowns SET last_announced_year = ? WHERE id = ? AND last_announced_year = ?',
                        [row.last_announced_year ?? null, row.id, year]
                    ).catch(() => {});
                }
                logger.warn(`${LOG} send failed`, { guildId: row.guild_id, slug: row.slug, attempts, err: e.message });
            }
        } catch (e) {
            failed++;
            logger.warn(`${LOG} row failed`, { id: row.id, guildId: row.guild_id, slug: row.slug, err: e.message });
        }
    }
    return { checked: rows.length, posted, failed };
}

async function tick(client) {
    if (running) return;
    running = true;
    try {
        const r = await runHolidayDayAnnouncements(client);
        if (r.posted || r.failed) logger.info(`${LOG} pass`, r);
    } catch (e) {
        logger.warn(`${LOG} pass failed: ${e.message}`);
    } finally {
        running = false;
    }
}

/** Start the 15-minute announcer. Safe to call again; replaces prior timers. */
export function startHolidayDayAnnouncer(client) {
    stopHolidayDayAnnouncer();
    bootHandle = setTimeout(() => tick(client), BOOT_DELAY_MS);
    intervalHandle = setInterval(() => tick(client), INTERVAL_MS);
    logger.info(`${LOG} started (first pass in ${BOOT_DELAY_MS / 1000}s, then every 15 min)`);
}

export function stopHolidayDayAnnouncer() {
    if (intervalHandle) clearInterval(intervalHandle);
    if (bootHandle) clearTimeout(bootHandle);
    intervalHandle = null;
    bootHandle = null;
}
