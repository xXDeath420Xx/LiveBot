/**
 * Holiday countdowns — per-server settings API.
 *
 * Mounted at /api/guilds/:guildId/holidays (behind apiCheckAuth + apiCheckGuildAdmin).
 *
 *   GET  /        every holiday with this server's settings and next date, plus the text
 *                 channels and roles to pick from and the server's timezone
 *   PUT  /:slug   save one holiday: { enabled, label, emoji, announceOnDay,
 *                 announceChannelId, mentionRoleId } (any subset)
 *
 * Storage and rendering live in core/holiday-manager.js (holiday_countdowns); the day-of post
 * is jobs/holiday-day-announcer.js.
 */
import express from 'express';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { getGuildTimezone } from '../../../../utils/guild-timezone.js';
import {
    getHoliday,
    listGuildConfig,
    upsertGuildConfig,
    computeCountdown,
    pinCountdownMessage,
} from '../../../../core/holiday-manager.js';
import { ANNOUNCE_LOCAL_HOUR } from '../../../../jobs/holiday-day-announcer.js';

const router = express.Router({ mergeParams: true });

const SNOWFLAKE = /^\d{15,25}$/;
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const LABEL_MAX = 80;  // holiday_countdowns.label_override VARCHAR(80)
const EMOJI_MAX = 24;  // holiday_countdowns.emoji_override VARCHAR(24)

/** The guild as the bot serving it sees it (custom bot when one is mapped). */
function guildFor(req) {
    const { guildId } = req.params;
    return global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId)
        || req.guildObject
        || req.app?.locals?.client?.guilds?.cache?.get(guildId)
        || null;
}

/** Collapse whitespace; returns null for empty. Rejects markup so a label can't carry mentions. */
function cleanText(raw, max, what) {
    if (raw === null || raw === undefined) return { value: null };
    const s = String(raw).replace(/\s+/g, ' ').trim();
    if (!s) return { value: null };
    if (/[<>]/.test(s)) return { error: `${what} must be plain text (no < or >).` };
    if ([...s].length > max) return { error: `${what} can be at most ${max} characters.` };
    return { value: s };
}

async function loadPins(guildId) {
    try {
        const [rows] = await pool.execute(
            'SELECT slug, channel_id, message_id, disabled_reason FROM holiday_countdown_pins WHERE guild_id = ?',
            [guildId]
        );
        return new Map(rows.map(r => [r.slug, r]));
    } catch {
        return new Map();
    }
}

async function describe(cfg, pin) {
    const info = await computeCountdown(cfg.slug).catch(() => null);
    return {
        slug: cfg.slug,
        label: cfg.label,
        emoji: cfg.emoji,
        defaultLabel: cfg.defaultLabel,
        defaultEmoji: cfg.defaultEmoji,
        labelOverride: cfg.labelOverride,
        emojiOverride: cfg.emojiOverride,
        enabled: cfg.enabled,
        announceOnDay: cfg.announceOnDay,
        announceChannelId: cfg.announceChannelId,
        mentionRoleId: cfg.mentionRoleId,
        nextDate: info ? info.nextDate.toISOString().slice(0, 10) : null,
        daysRemaining: info ? info.daysRemaining : null,
        pinned: pin ? { channelId: pin.channel_id, paused: !!pin.disabled_reason } : null,
    };
}

router.get('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [config, pins, timezone] = await Promise.all([
            listGuildConfig(guildId), loadPins(guildId), getGuildTimezone(guildId),
        ]);
        const holidays = [];
        for (const cfg of config) holidays.push(await describe(cfg, pins.get(cfg.slug)));
        holidays.sort((a, b) => (a.daysRemaining ?? 9999) - (b.daysRemaining ?? 9999));

        const guild = guildFor(req);
        const channels = guild
            ? [...guild.channels.cache.values()]
                .filter(c => TEXT_TYPES.has(c.type))
                .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
                .map(c => ({ id: c.id, name: c.name }))
            : [];
        const roles = guild
            ? [...guild.roles.cache.values()]
                .filter(r => r.id !== guild.id)
                .sort((a, b) => b.position - a.position)
                .map(r => ({ id: r.id, name: r.name }))
            : [];

        res.json({ success: true, holidays, channels, roles, timezone, announceHour: ANNOUNCE_LOCAL_HOUR });
    } catch (error) {
        logger.error('[API Holidays GET] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to load holiday settings' });
    }
});

router.put('/:slug', async (req, res) => {
    const { guildId } = req.params;
    const slug = String(req.params.slug || '').toLowerCase();
    try {
        const holiday = getHoliday(slug);
        if (!holiday) return res.status(404).json({ error: 'Unknown holiday' });
        const body = req.body || {};
        const current = (await listGuildConfig(guildId)).find(c => c.slug === slug);
        const patch = {};

        if (body.enabled !== undefined) patch.enabled = !!body.enabled;
        if (body.announceOnDay !== undefined) patch.announceOnDay = !!body.announceOnDay;

        if (body.label !== undefined) {
            const r = cleanText(body.label, LABEL_MAX, 'Name');
            if (r.error) return res.status(400).json({ error: r.error });
            // Saving the catalog name back is the same as no override.
            patch.labelOverride = r.value === holiday.label ? null : r.value;
        }
        if (body.emoji !== undefined) {
            const r = cleanText(body.emoji, EMOJI_MAX, 'Emoji');
            if (r.error) return res.status(400).json({ error: r.error });
            patch.emojiOverride = r.value === holiday.emoji ? null : r.value;
        }

        const guild = guildFor(req);
        const warnings = [];
        let channel = null;

        if (body.announceChannelId !== undefined) {
            const id = body.announceChannelId ? String(body.announceChannelId) : null;
            if (id) {
                if (!SNOWFLAKE.test(id)) return res.status(400).json({ error: 'Invalid channel' });
                if (!guild) return res.status(503).json({ error: 'The bot cannot see this server right now. Try again in a minute.' });
                channel = guild.channels.cache.get(id);
                if (!channel || !TEXT_TYPES.has(channel.type)) {
                    return res.status(400).json({ error: 'Pick a text or announcement channel in this server.' });
                }
                const me = guild.members.me;
                const perms = me ? channel.permissionsFor(me) : null;
                if (perms && !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
                    return res.status(400).json({ error: `The bot cannot send messages in #${channel.name}.` });
                }
            }
            patch.announceChannelId = id;
        }

        if (body.mentionRoleId !== undefined) {
            const id = body.mentionRoleId ? String(body.mentionRoleId) : null;
            if (id) {
                if (!SNOWFLAKE.test(id) || id === guildId) return res.status(400).json({ error: 'Invalid role' });
                if (!guild) return res.status(503).json({ error: 'The bot cannot see this server right now. Try again in a minute.' });
                const role = guild.roles.cache.get(id);
                if (!role) return res.status(400).json({ error: 'That role is not in this server.' });
                const chId = patch.announceChannelId !== undefined ? patch.announceChannelId : current?.announceChannelId;
                const ch = channel || (chId ? guild.channels.cache.get(chId) : null);
                const me = guild.members.me;
                const canForce = ch && me ? ch.permissionsFor(me)?.has(PermissionFlagsBits.MentionEveryone) : false;
                if (!role.mentionable && !canForce) {
                    warnings.push(`@${role.name} is not mentionable and the bot lacks "Mention @everyone, @here, and All Roles" there, so Discord will show the mention without notifying anyone.`);
                }
            }
            patch.mentionRoleId = id;
        }

        // Turning the day-of post on needs somewhere to post.
        const willAnnounce = patch.announceOnDay ?? current?.announceOnDay;
        const willChannel = patch.announceChannelId !== undefined ? patch.announceChannelId : current?.announceChannelId;
        if (body.announceOnDay && willAnnounce && !willChannel) {
            return res.status(400).json({ error: 'Pick a channel for the post on the day, or switch that off.' });
        }

        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to save' });
        await upsertGuildConfig(guildId, slug, patch);

        const after = (await listGuildConfig(guildId)).find(c => c.slug === slug);
        const pins = await loadPins(guildId);
        const pin = pins.get(slug);

        // Show a new name/emoji in the live pinned message now rather than at the next 6-hour refresh.
        const looksChanged = after && current && (after.label !== current.label || after.emoji !== current.emoji);
        if (looksChanged && after.enabled && pin && !pin.disabled_reason && guild?.client) {
            await pinCountdownMessage(guild.client, { guildId, slug, channelId: pin.channel_id })
                .catch(e => logger.warn('[API Holidays] pin refresh after save failed', { guildId, slug, err: e.message }));
        }

        res.json({ success: true, holiday: await describe(after, pin), warnings });
    } catch (error) {
        logger.error('[API Holidays PUT] Error:', { error: error.message, guildId, slug });
        res.status(500).json({ error: 'Failed to save holiday settings' });
    }
});

export default router;
