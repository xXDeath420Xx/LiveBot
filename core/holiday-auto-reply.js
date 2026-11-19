// core/holiday-auto-reply.js
//
// When a user posts a /countdown/<slug> URL in an opted-in channel, reply
// with a live-editable embed and track it in holiday_countdown_auto_replies.
// The daily/boot refresh walks that table and edits each reply to today's
// count — same pattern as refreshAllPins() in holiday-manager.js, but
// one-to-many (many user posts → many bot replies for the same slug).

import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { getHoliday, computeGuildCountdown, buildCountdownEmbed, publicCountdownUrl } from './holiday-manager.js';

const LOG = '[HolidayAutoReply]';

// Hostnames we accept countdown URLs from. Explicit so a lookalike link on an
// attacker-controlled host cannot make the bot reply.
const ACCEPTED_HOSTS = new Set([
    'certifriedmultitool.com',
    'www.certifriedmultitool.com',
]);

// Per-user per-guild cooldown so a single user cannot flood the channel.
const USER_COOLDOWN = new Map();
const USER_COOLDOWN_MS = 10_000;

// Match /countdown/<slug> inside an http(s) URL. Slug tolerates lowercase
// letters, numbers, and hyphens — matching the catalog.
const COUNTDOWN_URL_RE = /\bhttps?:\/\/([a-z0-9.\-]+)\/countdown\/([a-z0-9\-]{1,48})(?:[\/?#.][^\s]*)?/ig;

async function getAutoChannels(guildId) {
    const [rows] = await pool.query(
        'SELECT channel_id, enabled_slugs FROM holiday_countdown_auto_channels WHERE guild_id = ?',
        [guildId]
    );
    return rows;
}

async function isSlugEnabledHere(guildId, channelId, slug) {
    const rows = await getAutoChannels(guildId);
    const row = rows.find(r => r.channel_id === channelId);
    if (!row) return false;
    if (!row.enabled_slugs) return true;
    let list;
    try { list = typeof row.enabled_slugs === 'string' ? JSON.parse(row.enabled_slugs) : row.enabled_slugs; }
    catch { return true; }
    if (!Array.isArray(list) || list.length === 0) return true;
    return list.includes(slug);
}

/**
 * Called from messageCreate. Any error is swallowed so a failure here cannot
 * break the surrounding message handler chain. Returns true if a reply posted.
 */
export async function handleCountdownUrlInMessage(message) {
    try {
        if (!message?.guild || message.author?.bot) return false;
        if (!message.content) return false;
        if (!message.content.includes('/countdown/')) return false;

        const channels = await getAutoChannels(message.guild.id);
        if (!channels.length) return false;
        if (!channels.find(c => c.channel_id === message.channel.id)) return false;

        const cdKey = `${message.guild.id}:${message.author.id}`;
        const lastAt = USER_COOLDOWN.get(cdKey) || 0;
        if (Date.now() - lastAt < USER_COOLDOWN_MS) return false;

        // Only the first VALID countdown URL in a message triggers a reply —
        // multiple URLs in one message is almost always a paste-dump.
        let picked = null;
        for (const m of message.content.matchAll(COUNTDOWN_URL_RE)) {
            const host = m[1].toLowerCase();
            const slug = m[2].toLowerCase();
            if (!ACCEPTED_HOSTS.has(host)) continue;
            if (!getHoliday(slug)) continue;
            if (!(await isSlugEnabledHere(message.guild.id, message.channel.id, slug))) continue;
            // Holiday turned off for this server on the dashboard: no reply.
            const info = await computeGuildCountdown(message.guild.id, slug);
            if (!info || !info.enabled) continue;
            picked = { host, slug, info };
            break;
        }
        if (!picked) return false;

        const info = picked.info;

        const embed = buildCountdownEmbed(info, { linkUrl: publicCountdownUrl(picked.slug) });
        const reply = await message.reply({
            embeds: [embed],
            allowedMentions: { repliedUser: false, parse: [] },
        });

        USER_COOLDOWN.set(cdKey, Date.now());

        await pool.query(
            `INSERT INTO holiday_countdown_auto_replies
                (guild_id, channel_id, triggering_message_id, reply_message_id, slug,
                 posted_by_user_id, last_updated_at, last_days_remaining)
             VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)`,
            [message.guild.id, message.channel.id, message.id, reply.id, picked.slug,
             message.author.id, info.daysRemaining]
        );

        logger.info(`${LOG} auto-replied in ${message.guild.id}/${message.channel.id} to ${message.author.id} slug=${picked.slug}`);
        return true;
    } catch (e) {
        logger.warn(`${LOG} failed`, { err: e.message, stack: e.stack });
        return false;
    }
}

/**
 * Walk every active auto-reply and edit it to today's count. Called by the
 * holiday pin updater schedule (boot + 6h). Rows older than 60 days are
 * removed so the table does not grow unbounded.
 */
export async function refreshAllAutoReplies(client) {
    await pool.query(
        `DELETE FROM holiday_countdown_auto_replies
         WHERE created_at < DATE_SUB(NOW(), INTERVAL 60 DAY)`
    );

    const [rows] = await pool.query(
        `SELECT * FROM holiday_countdown_auto_replies WHERE disabled_reason IS NULL`
    );
    if (!rows.length) {
        logger.info(`${LOG} no auto-replies to refresh`);
        return { updated: 0, failed: 0, disabled: 0 };
    }

    let updated = 0, failed = 0, disabled = 0, skipped = 0;
    for (const r of rows) {
        try {
            const info = await computeGuildCountdown(r.guild_id, r.slug);
            if (!info) throw new Error(`unknown slug: ${r.slug}`);
            // Turned off for this guild: stop editing, without counting it as a failure.
            if (!info.enabled) { skipped++; continue; }
            const guild = client.guilds.cache.get(r.guild_id);
            if (!guild) throw new Error('guild not visible');
            const channel = await guild.channels.fetch(r.channel_id).catch(() => null);
            if (!channel?.isTextBased?.()) throw new Error('channel missing');
            const msg = await channel.messages.fetch(r.reply_message_id).catch(() => null);
            if (!msg) throw new Error('reply message missing');

            // Skip edit if the day hasn't moved — saves a Discord rate-limit slot.
            if (r.last_days_remaining === info.daysRemaining && !info.isToday) {
                updated++;
                continue;
            }

            const embed = buildCountdownEmbed(info, { linkUrl: publicCountdownUrl(r.slug) });
            await msg.edit({ embeds: [embed] });
            await pool.query(
                `UPDATE holiday_countdown_auto_replies
                   SET last_updated_at = NOW(), last_days_remaining = ?, failures_since_success = 0
                   WHERE id = ?`,
                [info.daysRemaining, r.id]
            );
            updated++;
        } catch (e) {
            failed++;
            const next = (r.failures_since_success || 0) + 1;
            if (next >= 3) {
                disabled++;
                await pool.query(
                    `UPDATE holiday_countdown_auto_replies
                       SET failures_since_success = ?, disabled_reason = ?
                       WHERE id = ?`,
                    [next, String(e.message).slice(0, 120), r.id]
                );
            } else {
                await pool.query(
                    `UPDATE holiday_countdown_auto_replies SET failures_since_success = ? WHERE id = ?`,
                    [next, r.id]
                );
            }
            logger.warn(`${LOG} refresh failed`, { replyId: r.id, slug: r.slug, err: e.message });
        }
    }
    logger.info(`${LOG} refreshed ${updated}/${rows.length} auto-replies (${failed} failed, ${disabled} disabled, ${skipped} turned off)`);
    return { updated, failed, disabled, skipped };
}

// ────────────────────────────────────────────────────────────────────────────
// Dashboard config helpers.
// ────────────────────────────────────────────────────────────────────────────

export async function listAutoChannels(guildId) {
    const [rows] = await pool.query(
        'SELECT channel_id, enabled_slugs, created_at FROM holiday_countdown_auto_channels WHERE guild_id = ? ORDER BY created_at',
        [guildId]
    );
    return rows.map(r => ({
        channel_id: r.channel_id,
        enabled_slugs: parseSlugsList(r.enabled_slugs),
        created_at: r.created_at,
    }));
}

function parseSlugsList(v) {
    if (!v) return null;
    if (Array.isArray(v)) return v;
    try { const p = JSON.parse(v); return Array.isArray(p) && p.length ? p : null; } catch { return null; }
}

export async function addAutoChannel(guildId, channelId, slugs = null) {
    const json = slugs && slugs.length ? JSON.stringify(slugs) : null;
    await pool.query(
        `INSERT INTO holiday_countdown_auto_channels (guild_id, channel_id, enabled_slugs)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled_slugs = VALUES(enabled_slugs)`,
        [guildId, channelId, json]
    );
}

export async function removeAutoChannel(guildId, channelId) {
    await pool.query(
        'DELETE FROM holiday_countdown_auto_channels WHERE guild_id = ? AND channel_id = ?',
        [guildId, channelId]
    );
}
