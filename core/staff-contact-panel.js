/*
 * The Staff contact panel (dashboard Staff contact page, staff_contact_config).
 *
 * "Contact panel channel" is where members find the panel: one bot message with four buttons
 * (report a user, report a scam, contact staff, suggestion) whose forms are handled by
 * events/staffContactInteraction.js and posted to the "Reports go to" channel. Saving the page
 * calls syncStaffContactPanel(), which keeps exactly one panel in the chosen channel:
 *   - the panel already recorded (contact_message_id) in that channel is edited in place;
 *   - otherwise a panel the bot posted there earlier (found among recent messages) is adopted;
 *   - otherwise a new one is posted and pinned.
 * When the channel changes, the panel recorded in the previous channel is removed; when the
 * channel is cleared, the recorded panel is removed and nothing is posted.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';

export const PANEL_BUTTON_IDS = Object.freeze(['staff_report_user', 'staff_report_scam', 'staff_contact', 'staff_suggestion']);

export function buildStaffContactPanel(guildId) {
    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'primary'))
        .setTitle('Contact staff')
        .setDescription([
            'Need a moderator? Pick an option below and fill in the short form. Only staff can see what you send.',
            '',
            '**Report a user** for breaking the rules',
            '**Report a scam** if someone tried to scam you or others',
            '**Contact staff** for anything else',
            '**Suggestion** for an idea to improve the server',
        ].join('\n'));
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('staff_report_user').setLabel('Report a user').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('staff_report_scam').setLabel('Report a scam').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('staff_contact').setLabel('Contact staff').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('staff_suggestion').setLabel('Suggestion').setStyle(ButtonStyle.Success),
    );
    return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

/** A message the bot posted that carries the panel's buttons. */
export function isStaffContactPanel(message, botUserId) {
    if (!message || message.author?.id !== botUserId) return false;
    return (message.components || []).some(row => (row.components || []).some(c => c.customId === 'staff_report_user'));
}

async function saveMessageId(guildId, messageId) {
    await pool.execute('UPDATE staff_contact_config SET contact_message_id = ? WHERE guild_id = ?', [messageId, guildId]);
}

async function removeRecorded(guild, channelId, messageId) {
    if (!channelId || !messageId) return false;
    const ch = guild.channels.cache.get(String(channelId));
    if (!ch?.isTextBased?.()) return false;
    const msg = await ch.messages.fetch(String(messageId)).catch(() => null);
    if (!msg || msg.author?.id !== guild.client.user.id) return false;
    await msg.delete().catch(() => {});
    return true;
}

/**
 * Bring the panel in line with the saved settings.
 * @param {import('discord.js').Guild} guild
 * @param {{previousChannelId?: string|null}} [opts]
 * @returns {Promise<{ok:boolean, action:'posted'|'updated'|'adopted'|'removed'|'none', channelId?:string, note?:string, error?:string}>}
 */
export async function syncStaffContactPanel(guild, { previousChannelId = null } = {}) {
    try {
        const [[row]] = await pool.execute(
            'SELECT contact_channel_id, reports_channel_id, contact_message_id FROM staff_contact_config WHERE guild_id = ?',
            [guild.id]
        );
        if (!row) return { ok: true, action: 'none' };
        const channelId = row.contact_channel_id ? String(row.contact_channel_id) : null;
        const botId = guild.client.user.id;

        // Moved or cleared: take down the panel recorded in the old channel.
        let removed = false;
        if (row.contact_message_id && previousChannelId && String(previousChannelId) !== channelId) {
            removed = await removeRecorded(guild, previousChannelId, row.contact_message_id);
            await saveMessageId(guild.id, null);
            row.contact_message_id = null;
        }
        if (!channelId) {
            return { ok: true, action: removed ? 'removed' : 'none' };
        }

        const channel = guild.channels.cache.get(channelId);
        if (!channel?.isTextBased?.()) {
            return { ok: false, action: 'none', channelId, error: 'the contact panel channel no longer exists' };
        }
        const perms = channel.permissionsFor(guild.members.me);
        const missing = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory']
            .filter(p => !perms?.has(PermissionFlagsBits[p]));
        if (missing.length) {
            return { ok: false, action: 'none', channelId, error: `the bot needs ${missing.join(', ')} in that channel` };
        }

        const payload = buildStaffContactPanel(guild.id);
        const note = row.reports_channel_id ? null : 'Set "Reports go to" so the forms have somewhere to go.';

        if (row.contact_message_id) {
            const existing = await channel.messages.fetch(String(row.contact_message_id)).catch(() => null);
            if (existing && existing.author?.id === botId) {
                await existing.edit(payload);
                return { ok: true, action: 'updated', channelId, note };
            }
        }

        const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
        const adopt = recent ? [...recent.values()].find(m => isStaffContactPanel(m, botId)) : null;
        if (adopt) {
            await adopt.edit(payload);
            await saveMessageId(guild.id, adopt.id);
            return { ok: true, action: 'adopted', channelId, note };
        }

        const posted = await channel.send(payload);
        await saveMessageId(guild.id, posted.id);
        await posted.pin('Staff contact panel').catch(() => {});
        return { ok: true, action: 'posted', channelId, note };
    } catch (err) {
        logger.error('[StaffContact] Panel sync failed', { guildId: guild?.id, error: err.message });
        return { ok: false, action: 'none', error: 'Discord refused the request' };
    }
}

/** One or two sentences for the dashboard after a save ('' when nothing happened). */
export function describePanelSync(result) {
    if (!result) return '';
    if (!result.ok) return ` The contact panel could not be posted: ${result.error}.`;
    const lines = {
        posted: 'The contact panel was posted and pinned in the chosen channel.',
        updated: 'The contact panel was updated.',
        adopted: 'The contact panel already in that channel was updated.',
        removed: 'The contact panel was removed.',
        none: '',
    };
    const text = [lines[result.action] || '', result.note || ''].filter(Boolean).join(' ');
    return text ? ` ${text}` : '';
}

export default { syncStaffContactPanel, buildStaffContactPanel, isStaffContactPanel, describePanelSync, PANEL_BUTTON_IDS };
