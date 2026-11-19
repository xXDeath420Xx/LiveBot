/**
 * Deliver a form response to people by DM.
 *
 * A DM is the only form destination that can fail permanently and invisibly — closed DMs, a
 * blocked bot, a member who left the server — and it is sent from a background handler with nobody
 * to report the failure to. So every attempt is recorded in form_dm_deliveries, and the dashboard
 * reads that back. "I never got a DM" has to be an answerable question.
 *
 * Sending is always best-effort with respect to the submission itself: the answers are stored
 * BEFORE this runs, and nothing in here may throw far enough to make a member think their
 * submission failed.
 */
import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';

/** Parse the stored dm_user_ids blob into an array of snowflakes. */
export function parseRecipients(raw) {
    if (!raw) return [];
    let list = raw;
    if (typeof raw === 'string') {
        try { list = JSON.parse(raw); } catch { list = raw.split(/[\s,]+/); }
    }
    if (!Array.isArray(list)) return [];
    return [...new Set(list.map(v => String(v).trim()).filter(v => /^\d{17,20}$/.test(v)))].slice(0, 10);
}

/** Serialise a recipient list for storage. Returns null for an empty list. */
export function serialiseRecipients(list) {
    const ids = parseRecipients(list);
    return ids.length ? JSON.stringify(ids) : null;
}

/**
 * Discord's own words for why a DM bounced. The raw codes mean nothing to a server owner, and
 * "Cannot send messages to this user" is the single most common one by a wide margin — it means
 * the recipient has DMs from server members switched off, which only they can change.
 */
export function describeDmError(error) {
    switch (error?.code) {
        case 50007: return "Their DMs are closed — they need to allow direct messages from server members.";
        case 50001: return 'The bot cannot access that user.';
        case 10013: return 'That user no longer exists.';
        default: return error?.message || 'Unknown error';
    }
}

/**
 * Build the DM embed for one submission.
 * Says which server and which form up front — a recipient may own several, and a DM carries no
 * channel context of its own to infer it from.
 */
export function buildResponseEmbed({ guild, formName, answers, submitter, guildId }) {
    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'primary'))
        .setTitle(`New response: ${formName}`.slice(0, 256))
        .setTimestamp();

    if (guild?.name) {
        embed.setAuthor({
            name: guild.name.slice(0, 256),
            iconURL: guild.iconURL?.({ size: 64 }) || undefined
        });
    }

    if (submitter) {
        const who = submitter.displayName && submitter.displayName !== submitter.username
            ? `${submitter.displayName} (@${submitter.username})`
            : `@${submitter.username}`;
        embed.setDescription(`Submitted by **${who}** — <@${submitter.id}>`);
        if (submitter.avatarUrl) embed.setThumbnail(submitter.avatarUrl);
        embed.setFooter({ text: `User ID: ${submitter.id}` });
    }

    for (const [question, answer] of Object.entries(answers || {})) {
        embed.addFields({
            name: String(question).slice(0, 256),
            value: (answer && String(answer).slice(0, 1024)) || '*No answer*'
        });
    }
    return embed;
}

/**
 * DM every recipient, recording each outcome.
 * @returns {Promise<{sent: string[], failed: {userId: string, reason: string}[]}>}
 */
export async function deliverToRecipients(client, { recipients, embed, components = [], formId, guildId, submissionId = null }) {
    const sent = [];
    const failed = [];

    for (const userId of recipients) {
        let status = 'sent';
        let reason = null;
        try {
            const user = await client.users.fetch(userId);
            // `components` carries the reply controls. They are attached to the notification
            // itself so answering somebody never requires going and finding them first.
            await user.send({ embeds: [embed], components });
            sent.push(userId);
        } catch (error) {
            status = 'failed';
            reason = describeDmError(error);
            failed.push({ userId, reason });
            logger.warn('[Form DM] Could not deliver', { formId, guildId, userId, code: error?.code, reason });
        }

        await pool.execute(
            `INSERT INTO form_dm_deliveries (submission_id, form_id, guild_id, user_id, status, error)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [submissionId, formId, guildId, userId, status, reason ? String(reason).slice(0, 255) : null]
        ).catch(() => { /* the log is a convenience; never let it sink a delivery */ });
    }

    return { sent, failed };
}
