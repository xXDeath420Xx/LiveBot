/**
 * Forward an applicant's DM reply back to the people who asked the question.
 *
 * The bot DMs somebody about their form response; they hit reply. Without this, that message
 * arrives in the bot's own DMs and stops there — the owner never hears the answer, and the
 * applicant spends the conversation talking to a wall while believing they are talking to the
 * server. That is worse than never having replied at all.
 *
 * THE GATE IS A PRIOR REPLY. Only a DM from somebody the bot has actually written to, about a
 * form, gets forwarded. Without that, every stray DM any of 83 servers' members ever sends the bot
 * would land in an owner's inbox. "We spoke to you first" is both the permission and the context:
 * it tells us which form, which guild and which submission this belongs to.
 */
import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';
import { parseRecipients, deliverToRecipients } from './form-dm.js';
import { listTemplates, rankTemplates, buildReplyComponents } from './form-reply.js';

/** How long after our last message a reply is still treated as part of that conversation. */
const CONVERSATION_WINDOW_DAYS = 30;
/** Forwards per applicant per hour. A flood should not become the owner's problem. */
const FORWARD_RATE_LIMIT = 15;

/**
 * The most recent form conversation this person is in, or null.
 * Ordered by our last outbound message, so somebody who applied to two forms gets their reply
 * attached to the one actually being discussed.
 */
async function findConversation(userId) {
    const [rows] = await pool.execute(
        `SELECT r.form_id, r.guild_id, r.submission_id
           FROM form_replies r
          WHERE r.recipient_id = ? AND r.direction = 'out' AND r.status = 'sent'
            AND r.sent_at > DATE_SUB(NOW(), INTERVAL ? DAY)
          ORDER BY r.sent_at DESC LIMIT 1`,
        [userId, CONVERSATION_WINDOW_DAYS]);
    return rows[0] || null;
}

async function recentInboundCount(userId) {
    const [[row]] = await pool.execute(
        `SELECT COUNT(*) AS n FROM form_replies
          WHERE sender_id = ? AND direction = 'in' AND sent_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
        [userId]);
    return Number(row?.n ?? 0);
}

/**
 * Handle one DM. Returns true when it was a form reply and has been dealt with, so the caller
 * stops processing it as anything else.
 */
export async function handleApplicantDm(message) {
    try {
        if (message.author?.bot) return false;
        if (message.guild) return false;

        const conversation = await findConversation(message.author.id);
        if (!conversation) return false;

        const [[form]] = await pool.execute(
            'SELECT * FROM ticket_forms WHERE form_id = ? AND guild_id = ?',
            [conversation.form_id, conversation.guild_id]);
        if (!form) return false;

        const body = String(message.content ?? '').trim();
        const attachments = [...(message.attachments?.values?.() ?? [])].map(a => a.url);
        if (!body && attachments.length === 0) return false;

        // Record it whatever happens next: the transcript is the point, and a forward that fails
        // must not also lose what they said.
        const stored = [body, ...attachments].filter(Boolean).join('\n').slice(0, 4000);
        await pool.execute(
            `INSERT INTO form_replies
                (submission_id, form_id, guild_id, sender_id, recipient_id, template_id, direction, body, status)
             VALUES (?, ?, ?, ?, NULL, NULL, 'in', ?, 'sent')`,
            [conversation.submission_id, form.form_id, form.guild_id, message.author.id, stored]
        ).catch(err => logger.warn('[Form Inbox] Could not record inbound reply', { error: err.message }));

        if (await recentInboundCount(message.author.id) > FORWARD_RATE_LIMIT) {
            logger.warn('[Form Inbox] Rate limit reached, not forwarding', { userId: message.author.id });
            return true;
        }

        const recipients = parseRecipients(form.dm_user_ids);
        if (recipients.length === 0) {
            // Nobody is listening. Still recorded above, and the dashboard shows it.
            logger.info('[Form Inbox] Reply stored but no DM recipients set', { formId: form.form_id });
            return true;
        }

        const guild = message.client.guilds?.cache?.get(form.guild_id) || null;

        const embed = new EmbedBuilder()
            .setColor(themeColor(form.guild_id, 'warning'))
            .setAuthor({
                name: `${message.author.globalName || message.author.username} replied`.slice(0, 256),
                iconURL: message.author.displayAvatarURL({ size: 128 })
            })
            .setTitle(`Re: ${form.form_name}`.slice(0, 256))
            .setDescription((body || '*(no text)*').slice(0, 4000))
            .setFooter({ text: `${guild?.name ? guild.name + ' · ' : ''}User ID: ${message.author.id}` })
            .setTimestamp();

        if (attachments.length) {
            embed.addFields({ name: 'Attachments', value: attachments.join('\n').slice(0, 1024) });
            const image = attachments.find(u => /\.(png|jpe?g|gif|webp)(\?|$)/i.test(u));
            if (image) embed.setImage(image);
        }

        // The same reply controls the original notification carries, so answering back is one
        // press from here rather than a trip to find the notification again.
        let components = [];
        if (conversation.submission_id) {
            const [[submission]] = await pool.execute(
                'SELECT * FROM form_submissions WHERE submission_id = ?', [conversation.submission_id]);
            if (submission) {
                const [questions] = await pool.execute(
                    `SELECT * FROM ticket_form_questions WHERE form_id = ?
                      ORDER BY question_order ASC, question_id ASC`, [form.form_id]);
                let answers = {};
                try { answers = JSON.parse(submission.submission_data || '{}'); } catch { answers = {}; }
                const ranked = rankTemplates(
                    await listTemplates(form.guild_id, form.form_id), answers, questions);
                components = buildReplyComponents(conversation.submission_id, ranked);
            }
        }

        await deliverToRecipients(message.client, {
            recipients, embed, components,
            formId: form.form_id,
            guildId: form.guild_id,
            submissionId: conversation.submission_id
        });

        // A quiet acknowledgement. Without it the applicant cannot tell whether a bot's DM is a
        // mailbox or a dead end, and people re-send when they are unsure.
        await message.react('✅').catch(() => {});

        logger.info('[Form Inbox] Forwarded applicant reply', {
            formId: form.form_id, userId: message.author.id, recipients: recipients.length });
        return true;
    } catch (error) {
        logger.error('[Form Inbox] Error handling DM', { error: error.message, stack: error.stack });
        return false;
    }
}
