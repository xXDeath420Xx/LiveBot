/**
 * The "Create giveaway" panel (register H-715).
 *
 * Giveaway host roles (giveaway_host_roles, the Giveaways page) gate the Create Giveaway button
 * (interactions/buttons/giveaway_create.js), which opens a form and starts the giveaway in the channel the
 * panel is in. /manage giveaway start needs Manage Server, which Discord checks before the bot sees the
 * command, so the button is how members with a host role but without Manage Server start one.
 *
 * Only a one-off script for one server (scripts/kitsune-giveaway-panel.mjs) ever posted the panel, so the
 * roles did nothing anywhere else. The Giveaways page now posts it in any server, in the channel chosen
 * there (the server's giveaways channel, where members enter by reacting), and keeps one per server:
 * saving again edits it, choosing another channel moves it, and choosing none removes it.
 *
 * giveaway_panels (migration 453) remembers where it is.
 */
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';

export const PANEL_CUSTOM_ID = 'giveaway_create';
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const NEEDED = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

/** The panel message: the wording scripts/kitsune-giveaway-panel.mjs posted, with the server's theme colour. */
export function panelPayload(guildId) {
    return {
        embeds: [{
            title: '🎉 Giveaways',
            description:
                '**Entering is one click.** When a giveaway is posted below, react with 🎉 to enter. ' +
                'That\'s it — no command, no form.\n\n' +
                'When the timer runs out the winners are drawn automatically and pinged right here. ' +
                'You can leave at any time by removing your reaction.\n\n' +
                '*Staff: use the button below to start one in this channel.*',
            color: parseInt(themeColor(guildId, 'primary').slice(1), 16),
        }],
        components: [{
            type: 1,
            components: [{ type: 2, style: 1, label: 'Create Giveaway', emoji: { name: '🎉' }, custom_id: PANEL_CUSTOM_ID }],
        }],
    };
}

/** Where this server's panel is: { channel_id, message_id } or null. */
export async function getGiveawayPanel(guildId, { db = pool } = {}) {
    const [rows] = await db.execute('SELECT channel_id, message_id FROM giveaway_panels WHERE guild_id = ?', [guildId]);
    return rows[0] ?? null;
}

async function fetchMessage(guild, channelId, messageId) {
    if (!channelId || !messageId) return null;
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    return channel?.messages ? channel.messages.fetch(messageId).catch(() => null) : null;
}

/** The bot's own panel among the channel's last 50 messages, or null. */
async function findUntrackedPanel(channel, botId) {
    if (!botId || !channel.messages?.fetch) return null;
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!recent) return null;
    return [...recent.values()].find((m) => m.author?.id === botId
        && m.components?.some((row) => (row.components || []).some((c) => (c.customId ?? c.custom_id) === PANEL_CUSTOM_ID))) || null;
}

/**
 * Post the panel in `channelId`, or edit it when it is already there; a panel in another channel is removed.
 * @returns {Promise<{ok: true, action: 'posted'|'updated'|'moved', channelId: string, messageId: string} | {ok: false, error: string}>}
 */
export async function postGiveawayPanel({ guild, channelId, userId = null, db = pool }) {
    if (!guild) return { ok: false, error: 'The bot is not in this server right now. Try again in a minute.' };
    const id = String(channelId || '');
    if (!/^\d{17,20}$/.test(id)) return { ok: false, error: 'Choose a channel.' };
    const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
    if (!channel || !TEXT_TYPES.has(channel.type)) return { ok: false, error: 'Choose a text or announcement channel in this server.' };
    const me = guild.members?.me;
    const perms = me && channel.permissionsFor ? channel.permissionsFor(me) : null;
    if (perms && !NEEDED.every((p) => perms.has(p))) {
        return { ok: false, error: `The bot cannot post in #${channel.name}. Give it View Channel, Send Messages and Embed Links there.` };
    }

    const current = await getGiveawayPanel(guild.id, { db });
    const payload = panelPayload(guild.id);
    let action = 'posted';
    let message = null;

    if (current && String(current.channel_id) === id) {
        const existing = await fetchMessage(guild, id, current.message_id);
        if (existing?.edit) {
            message = await existing.edit(payload);
            action = 'updated';
        }
    } else if (current) {
        const old = await fetchMessage(guild, current.channel_id, current.message_id);
        await old?.delete?.().catch(() => {});
        action = 'moved';
    }

    if (!message) {
        // A panel posted before this was tracked (scripts/kitsune-giveaway-panel.mjs) is reused, not doubled.
        const prior = await findUntrackedPanel(channel, me?.id ?? guild.client?.user?.id);
        if (prior?.edit) {
            message = await prior.edit(payload);
            action = action === 'moved' ? 'moved' : 'updated';
        }
    }
    if (!message) {
        message = await channel.send(payload);
        // Pinned so it stays findable under the giveaways; needs Manage Messages, so best effort.
        await message.pin?.().catch(() => {});
    }

    await db.execute(
        `INSERT INTO giveaway_panels (guild_id, channel_id, message_id, updated_by) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), message_id = VALUES(message_id), updated_by = VALUES(updated_by)`,
        [guild.id, id, message.id, userId]
    );
    logger.info(`[Giveaways] Create giveaway panel ${action} in #${channel.name}`, { guildId: guild.id, category: 'giveaways' });
    return { ok: true, action, channelId: id, messageId: message.id };
}

/** Remove the panel message (when the bot can) and forget it. */
export async function removeGiveawayPanel({ guild, guildId = guild?.id, db = pool }) {
    const current = await getGiveawayPanel(guildId, { db });
    if (!current) return { ok: true, removed: false };
    if (guild) {
        const old = await fetchMessage(guild, current.channel_id, current.message_id);
        await old?.delete?.().catch(() => {});
    }
    await db.execute('DELETE FROM giveaway_panels WHERE guild_id = ?', [guildId]);
    return { ok: true, removed: true };
}

export default { panelPayload, getGiveawayPanel, postGiveawayPanel, removeGiveawayPanel, PANEL_CUSTOM_ID };
