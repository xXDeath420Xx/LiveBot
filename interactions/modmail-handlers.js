/**
 * Modmail buttons, selects and the close modal. Registered in interactions/handlerRegistry.js;
 * every id is prefix-matched and carries what it needs, so they keep working across restarts.
 *
 *   DM side    mmail_open:<guildId>:<dmMessageId>   button  "Open conversation"
 *              mmail_pick:<dmMessageId>             select  which server (several qualify)
 *              mmail_route:<dmMessageId>            select  which open conversation a DM is for
 *              mmail_cancel                         button
 *   Staff side mmail_close:<threadId>               button  → modal mmail_closem:<threadId>
 *              mmail_block:<threadId>               button  block the member and close
 */
import { ActionRowBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import logger from '../utils/logger.js';
import { themeColor } from '../core/guild-theme.js';
import { IDS, isSnowflake, parseCustomId } from '../core/modmail-format.js';
import {
    openFromPrompt, routeMessage, clearPrompt, getThread, getModmailConfig, isStaff, closeThread, blockUser,
} from '../core/modmail-manager.js';

const EPHEMERAL = 64;

async function safeReply(interaction, content) {
    const payload = { content, embeds: [], components: [] };
    try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
        else await interaction.reply({ ...payload, flags: EPHEMERAL });
    } catch (err) {
        logger.warn('[Modmail] Could not answer an interaction', { customId: interaction.customId, error: err.message });
    }
}

// ── DM side ──────────────────────────────────────────────────────────────────────────────────

export async function handleModmailOpen(interaction) {
    const [guildId, messageId] = parseCustomId(interaction.customId, IDS.open) || [];
    if (!isSnowflake(guildId) || !isSnowflake(messageId)) return safeReply(interaction, 'This button is no longer valid.');
    try {
        await interaction.deferUpdate();
        await openFromPrompt(interaction, guildId, messageId);
    } catch (err) {
        logger.error('[Modmail] Open button failed', { userId: interaction.user.id, guildId, error: err.message, stack: err.stack });
        await safeReply(interaction, 'Something went wrong opening your conversation. Please try again later.');
    }
}

export async function handleModmailPick(interaction) {
    const [messageId] = parseCustomId(interaction.customId, IDS.pick) || [];
    const guildId = interaction.values?.[0];
    if (!isSnowflake(messageId) || !isSnowflake(guildId)) return safeReply(interaction, 'This menu is no longer valid.');
    try {
        await interaction.deferUpdate();
        await openFromPrompt(interaction, guildId, messageId);
    } catch (err) {
        logger.error('[Modmail] Server picker failed', { userId: interaction.user.id, guildId, error: err.message, stack: err.stack });
        await safeReply(interaction, 'Something went wrong opening your conversation. Please try again later.');
    }
}

export async function handleModmailRoute(interaction) {
    const [messageId] = parseCustomId(interaction.customId, IDS.route) || [];
    const threadId = Number(interaction.values?.[0]);
    if (!isSnowflake(messageId) || !Number.isInteger(threadId) || threadId <= 0) {
        return safeReply(interaction, 'This menu is no longer valid.');
    }
    try {
        await interaction.deferUpdate();
        const result = await routeMessage(interaction, threadId, messageId);
        await interaction.editReply({
            content: result.ok ? `✅ Sent to the staff of **${result.guildName}**. Your next messages go there too.` : result.error,
            components: [],
        });
    } catch (err) {
        logger.error('[Modmail] Route picker failed', { userId: interaction.user.id, threadId, error: err.message, stack: err.stack });
        await safeReply(interaction, 'Something went wrong sending that message. Please try again.');
    }
}

export async function handleModmailCancel(interaction) {
    clearPrompt(interaction.client, interaction.user.id);
    try {
        await interaction.update({
            embeds: [new EmbedBuilder().setColor(themeColor(null, 'primary')).setDescription('Cancelled — nothing was sent to any staff team.')],
            components: [],
        });
    } catch (err) {
        logger.warn('[Modmail] Cancel failed', { error: err.message });
    }
}

// ── Staff side ───────────────────────────────────────────────────────────────────────────────

/** The open thread a staff button refers to, checked against the guild and the clicker. */
async function staffThread(interaction, prefix) {
    const [rawId] = parseCustomId(interaction.customId, prefix) || [];
    const threadId = Number(rawId);
    if (!interaction.guild || !Number.isInteger(threadId) || threadId <= 0) return { error: 'This button is no longer valid.' };
    const thread = await getThread(threadId);
    if (!thread || thread.guild_id !== interaction.guild.id) return { error: 'That conversation no longer exists.' };
    if (thread.status !== 'open') return { error: 'This conversation is already closed.' };
    const cfg = await getModmailConfig(interaction.guild.id);
    if (!isStaff(interaction.member, cfg)) return { error: 'Only the modmail staff team can do that.' };
    return { thread, cfg };
}

export async function handleModmailClose(interaction) {
    try {
        const { thread, error } = await staffThread(interaction, IDS.close);
        if (error) return safeReply(interaction, error);
        const modal = new ModalBuilder()
            .setCustomId(`${IDS.closeModal}${thread.id}`)
            .setTitle(`Close modmail #${thread.id}`);
        const reason = new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Reason (sent to the member — optional)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(1000);
        modal.addComponents(new ActionRowBuilder().addComponents(reason));
        await interaction.showModal(modal);
    } catch (err) {
        logger.error('[Modmail] Close button failed', { error: err.message, stack: err.stack });
        await safeReply(interaction, 'Something went wrong. Please try again.');
    }
}

export async function handleModmailCloseModal(interaction) {
    try {
        await interaction.deferReply({ flags: EPHEMERAL });
        const { thread, error } = await staffThread(interaction, IDS.closeModal);
        if (error) return safeReply(interaction, error);
        const reason = interaction.fields.getTextInputValue('reason')?.trim() || null;

        const result = await closeThread({ client: interaction.client, thread, closedBy: interaction.user, reason });
        if (!result.ok) return safeReply(interaction, result.error);

        await interaction.channel?.send({
            content: `🔒 Closed by ${interaction.user}. The transcript has been saved and this channel will be deleted in a few seconds.`,
            allowedMentions: { parse: [] },
        }).catch(() => {});
        await safeReply(interaction, 'Conversation closed and the member has been told.');
    } catch (err) {
        logger.error('[Modmail] Close modal failed', { error: err.message, stack: err.stack });
        await safeReply(interaction, 'Something went wrong closing the conversation. Please try again.');
    }
}

export async function handleModmailBlock(interaction) {
    try {
        await interaction.deferReply({ flags: EPHEMERAL });
        const { thread, error } = await staffThread(interaction, IDS.block);
        if (error) return safeReply(interaction, error);

        await blockUser(thread.guild_id, thread.user_id, interaction.user.id, `Blocked from modmail #${thread.id} by ${interaction.user.tag}`);
        const result = await closeThread({
            client: interaction.client, thread, closedBy: interaction.user,
            reason: `Member blocked from modmail by ${interaction.user.tag}`, shareReason: false,
        });

        await interaction.channel?.send({
            content: `⛔ <@${thread.user_id}> was blocked from modmail by ${interaction.user}. ${result.ok ? 'This channel will be deleted in a few seconds.' : ''}`,
            allowedMentions: { parse: [] },
        }).catch(() => {});
        await safeReply(interaction, 'Member blocked from modmail and the conversation closed. Unblock them from the dashboard\'s Modmail page.');
    } catch (err) {
        logger.error('[Modmail] Block button failed', { error: err.message, stack: err.stack });
        await safeReply(interaction, 'Something went wrong blocking the member. Please try again.');
    }
}
