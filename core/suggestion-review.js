/**
 * Suggestion approval (register H-662).
 *
 * With "Require staff approval" on (suggestion_config.require_approval), a new suggestion is not
 * posted where members vote. It is saved as 'pending' and a review card with Approve and Reject
 * buttons goes to the staff review channel (staff_review_channel_id) when one is set. Approving it,
 * from that card, /engage suggest approve or the dashboard, posts it to the suggestions channel for
 * voting; rejecting it never posts it. Votes are refused while a suggestion is pending (older
 * suggestions posted while pending may still carry vote buttons).
 *
 * Staff are members with Manage Server or the suggestions staff role (approved_role_id).
 *
 * suggestions.review_channel_id / review_message_id (migrations/448_suggestion_review_card.js) point
 * at the review card so it can be closed whichever way the decision is made.
 */
import {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits,
} from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import SuggestionManager from './suggestion-manager.js';

const on = (v) => v === true || v === 1 || v === '1';

/** Approval is required: new suggestions wait for staff before they are posted. */
export function holdsForReview(config) {
    return on(config?.require_approval);
}

/** Members can vote once a suggestion is out of the approval queue. */
export function votingOpen(status) {
    return status !== 'pending';
}

/** Manage Server, or the suggestions staff role. */
export function isSuggestionStaff(member, config) {
    if (member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
    const roleId = config?.approved_role_id;
    return Boolean(roleId && member?.roles?.cache?.has?.(roleId));
}

export async function getSuggestionConfig(guildId) {
    const [rows] = await pool.execute('SELECT * FROM suggestion_config WHERE guild_id = ?', [guildId]);
    return rows[0] || null;
}

async function getSuggestion(guildId, suggestionId) {
    const [rows] = await pool.execute('SELECT * FROM suggestions WHERE id = ? AND guild_id = ?', [suggestionId, guildId]);
    return rows[0] || null;
}

/** The Approve / Reject buttons on a review card. */
export function reviewButtons(suggestionId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sgr:approve:${suggestionId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`sgr:reject:${suggestionId}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
    );
}

/** Post the review card for a held suggestion; returns true when it was posted. */
export async function postReviewCard({ guild, config, suggestionId, text, userId, anonymous }) {
    if (!config?.staff_review_channel_id) return false;
    const channel = guild.channels.cache.get(config.staff_review_channel_id)
        || await guild.channels.fetch(config.staff_review_channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) return false;

    const base = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '');
    const embed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle(`Suggestion #${suggestionId} is waiting for approval`)
        .setURL(`${base}/manage/${guild.id}?page=suggestions`)
        .setDescription(String(text).slice(0, 4000))
        .addFields({ name: 'From', value: anonymous ? 'Sent anonymously' : `<@${userId}>`, inline: true })
        .setFooter({ text: 'Approve posts it for voting. Reject keeps it private.' });
    const message = await channel.send({ embeds: [embed], components: [reviewButtons(suggestionId)], allowedMentions: { parse: [] } })
        .catch((err) => { logger.warn('[Suggestions] Review card not posted', { guildId: guild.id, error: err.message }); return null; });
    if (!message) return false;
    await pool.execute('UPDATE suggestions SET review_channel_id = ?, review_message_id = ? WHERE id = ?',
        [channel.id, message.id, suggestionId]).catch(() => {});
    return true;
}

/** Mark the review card as decided and take its buttons off. Best effort. */
async function closeReviewCard(guild, suggestion, status, reviewerId, note = null) {
    if (!suggestion?.review_channel_id || !suggestion.review_message_id) return;
    try {
        const channel = guild.channels.cache.get(suggestion.review_channel_id)
            || await guild.channels.fetch(suggestion.review_channel_id).catch(() => null);
        const message = await channel?.messages?.fetch(suggestion.review_message_id).catch(() => null);
        if (!message?.embeds?.[0]) return;
        const manager = new SuggestionManager(guild.client);
        const verb = status === 'approved' ? 'Approved and posted for voting' : 'Rejected';
        const embed = EmbedBuilder.from(message.embeds[0])
            .setColor(manager.getStatusColor(status))
            .setTitle(`Suggestion #${suggestion.id}: ${manager.getStatusDisplay(status)}`)
            .setFooter({ text: verb });
        if (reviewerId) embed.addFields({ name: 'By', value: `<@${reviewerId}>`, inline: true });
        if (note) embed.addFields({ name: status === 'rejected' ? 'Reason' : 'Response', value: String(note).slice(0, 1024), inline: false });
        await message.edit({ embeds: [embed], components: [], allowedMentions: { parse: [] } });
    } catch (err) {
        logger.warn('[Suggestions] Could not close the review card', { guildId: guild.id, suggestionId: suggestion.id, error: err.message });
    }
}

/**
 * Save a new suggestion and either post it for voting or hold it for staff.
 * @returns {Promise<{ id: number, held: boolean, reviewCard: boolean }>}
 */
export async function submitSuggestion({ client, guild, user, text, anonymous = false, config }) {
    const manager = new SuggestionManager(client);
    const held = holdsForReview(config);
    const id = await manager.createSuggestion(guild.id, user.id, text, anonymous, config);
    if (held) {
        const reviewCard = await postReviewCard({ guild, config, suggestionId: id, text, userId: user.id, anonymous });
        return { id, held, reviewCard };
    }
    await manager.postSuggestion(guild, config.suggestions_channel_id, id, text, user, anonymous, 'approved');
    return { id, held, reviewCard: false };
}

/**
 * Approve a suggestion. One that was held (never posted) is posted to the suggestions channel now.
 * @returns {Promise<{ ok: boolean, error?: string, posted?: boolean }>}
 */
export async function approveSuggestion({ client, guild, suggestionId, reviewerId, response = null }) {
    const suggestion = await getSuggestion(guild.id, suggestionId);
    if (!suggestion) return { ok: false, error: 'Suggestion not found.' };
    const manager = new SuggestionManager(client);
    await manager.updateStatus(suggestionId, 'approved', reviewerId, response);

    let posted = false;
    if (!suggestion.message_id) {
        const config = await getSuggestionConfig(guild.id);
        if (!config?.suggestions_channel_id) {
            return { ok: false, error: 'Approved, but there is no suggestions channel to post it in. Set one on the dashboard.' };
        }
        try {
            await manager.postSuggestion(guild, config.suggestions_channel_id, suggestionId, suggestion.suggestion_text,
                `<@${suggestion.user_id}>`, Boolean(Number(suggestion.is_anonymous)), 'approved');
            posted = true;
        } catch (err) {
            logger.error('[Suggestions] Approved suggestion could not be posted', { guildId: guild.id, suggestionId, error: err.message });
            return { ok: false, error: 'Approved, but posting it to the suggestions channel failed. Check that I can send messages there.' };
        }
        if (response) {
            const fresh = await getSuggestion(guild.id, suggestionId);
            await manager.updateSuggestionEmbed(guild, fresh, 'approved', response);
        }
    } else {
        await manager.updateSuggestionEmbed(guild, suggestion, 'approved', response);
    }

    await closeReviewCard(guild, suggestion, 'approved', reviewerId, response);
    if (!Number(suggestion.is_anonymous)) {
        await manager.notifyUser(client, suggestion.user_id, guild.name, suggestionId, suggestion.suggestion_text, 'approved', response);
    }
    return { ok: true, posted };
}

/**
 * The dashboard's Approve / Reject / Mark implemented: the same decision, through the bot that serves
 * the server. When that bot cannot see the server (still starting, say) an approval is refused, since it
 * could not be posted; a rejection or implemented mark only needs the status saved.
 */
export async function decideFromDashboard({ guildId, suggestionId, reviewerId, decision }) {
    const client = global.botManager?.getClientForGuild?.(guildId) || global.botManager?.getDefaultClient?.() || null;
    const guild = client?.guilds?.cache?.get(guildId) || null;
    if (!guild) {
        if (decision === 'approved') return { ok: false, error: 'The bot cannot see this server right now, so the suggestion could not be posted. Try again in a minute.' };
        logger.warn('[Suggestions] Dashboard decision saved without the bot', { guildId, suggestionId, decision });
        await pool.execute('UPDATE suggestions SET status = ?, reviewed_by = ?, reviewed_at = NOW() WHERE guild_id = ? AND id = ?',
            [decision, reviewerId, guildId, suggestionId]);
        return { ok: true, posted: false };
    }
    if (decision === 'implemented') return implementSuggestion({ client, guild, suggestionId, reviewerId });
    return decision === 'approved'
        ? approveSuggestion({ client, guild, suggestionId, reviewerId })
        : rejectSuggestion({ client, guild, suggestionId, reviewerId });
}

/**
 * Mark a suggestion implemented: the status, the posted message and a DM to the author, the same as
 * /engage suggest implement. (The dashboard used to change only the status.)
 */
export async function implementSuggestion({ client, guild, suggestionId, reviewerId }) {
    const suggestion = await getSuggestion(guild.id, suggestionId);
    if (!suggestion) return { ok: false, error: 'Suggestion not found.' };
    const manager = new SuggestionManager(client);
    await manager.updateStatus(suggestionId, 'implemented', reviewerId);
    if (suggestion.message_id) await manager.updateSuggestionEmbed(guild, suggestion, 'implemented');
    if (!Number(suggestion.is_anonymous)) {
        await manager.notifyUser(client, suggestion.user_id, guild.name, suggestionId, suggestion.suggestion_text, 'implemented');
    }
    return { ok: true };
}

/** Reject a suggestion. A held one stays private; a posted one shows the decision. */
export async function rejectSuggestion({ client, guild, suggestionId, reviewerId, reason = null }) {
    const suggestion = await getSuggestion(guild.id, suggestionId);
    if (!suggestion) return { ok: false, error: 'Suggestion not found.' };
    const manager = new SuggestionManager(client);
    await manager.updateStatus(suggestionId, 'rejected', reviewerId, reason);
    if (suggestion.message_id) await manager.updateSuggestionEmbed(guild, suggestion, 'rejected', reason);
    await closeReviewCard(guild, suggestion, 'rejected', reviewerId, reason);
    if (!Number(suggestion.is_anonymous)) {
        await manager.notifyUser(client, suggestion.user_id, guild.name, suggestionId, suggestion.suggestion_text, 'rejected', reason);
    }
    return { ok: true };
}
