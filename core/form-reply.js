/**
 * Replying to a form submission as the bot.
 *
 * The owner gets a DM saying somebody applied. This is what turns that into a conversation: the
 * notification carries the replies they might want to send, and one click DMs the applicant back
 * from the bot.
 *
 * CONDITIONAL TEMPLATES. A reply usually depends on an answer — a Steam player needs the branch
 * access code, an Epic player needs the patcher instead. A template can therefore name a question
 * and a substring, and it is only offered when that submission's answer contains it. The sender
 * does not have to remember which reply goes with which answer, and cannot send the Steam
 * instructions to somebody who told you they are on Epic.
 *
 * Templates that match are offered first and marked; the rest stay available, because a rule is a
 * suggestion and the human clicking the button is the one who decides.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
         StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';
import { describeDmError } from './form-dm.js';

/** Discord's embed description cap, which is what a reply body is rendered into. */
export const REPLY_BODY_LIMIT = 4000;
/** Buttons fit five to a row; more templates than this switch to a select menu. */
const BUTTON_ROW_LIMIT = 4;

export async function listTemplates(guildId, formId) {
    const [rows] = await pool.execute(
        `SELECT * FROM form_reply_templates WHERE guild_id = ? AND form_id = ?
          ORDER BY sort_order ASC, template_id ASC`, [guildId, formId]);
    return rows;
}

export async function getTemplate(templateId, guildId) {
    const [rows] = await pool.execute(
        'SELECT * FROM form_reply_templates WHERE template_id = ? AND guild_id = ?', [templateId, guildId]);
    return rows[0] || null;
}

/**
 * Does this template's rule fit this submission?
 *
 * `answers` is keyed by QUESTION TEXT (that is the shape stored in form_submissions), so the rule's
 * question id is resolved through the question rows rather than assumed.
 */
export function templateMatches(template, answers, questions) {
    if (!template.match_question_id || !template.match_contains) return false;
    const question = questions.find(q => String(q.question_id) === String(template.match_question_id));
    if (!question) return false;
    const given = String(answers?.[question.question_text] ?? '').toLowerCase();
    return given.includes(String(template.match_contains).toLowerCase());
}

/** Matching templates first, each flagged, then the rest. */
export function rankTemplates(templates, answers, questions) {
    return templates
        .map(t => ({ ...t, matched: templateMatches(t, answers, questions) }))
        .sort((a, b) => Number(b.matched) - Number(a.matched));
}

/**
 * Substitute the handful of placeholders a reply can use.
 * Deliberately tiny: anything richer belongs in the body the owner wrote, not in a template engine
 * nobody documented.
 */
export function renderBody(body, { submitter, form, guild }) {
    return String(body ?? '')
        .replaceAll('{user}', `<@${submitter?.id ?? ''}>`)
        .replaceAll('{name}', submitter?.displayName || submitter?.username || 'there')
        .replaceAll('{username}', submitter?.username || '')
        .replaceAll('{form}', form?.form_name || '')
        .replaceAll('{server}', guild?.name || '')
        .slice(0, REPLY_BODY_LIMIT);
}

/** The message the APPLICANT receives. */
export function buildReplyEmbed({ body, form, guild, guildId, senderTag }) {
    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'primary'))
        .setDescription(String(body).slice(0, REPLY_BODY_LIMIT))
        .setTimestamp();
    if (guild?.name) {
        embed.setAuthor({ name: guild.name.slice(0, 256), iconURL: guild.iconURL?.({ size: 64 }) || undefined });
    }
    // Says what it is about, because a DM out of nowhere from a bot is otherwise a mystery.
    embed.setFooter({
        text: `Regarding your response to “${form?.form_name ?? 'a form'}”${senderTag ? ` · sent by ${senderTag}` : ''}`.slice(0, 2048)
    });
    return embed;
}

/**
 * The controls attached to a response notification.
 * `submissionId` is the whole routing key — the handler re-reads everything else from the database,
 * so these survive restarts and template edits.
 */
export function buildReplyComponents(submissionId, ranked, { alreadyReplied = 0 } = {}) {
    const rows = [];

    if (ranked.length > BUTTON_ROW_LIMIT) {
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`formrep_s_${submissionId}`)
                .setPlaceholder('Send a saved reply…')
                .addOptions(ranked.slice(0, 25).map(t => ({
                    label: String(t.name).slice(0, 100),
                    value: String(t.template_id),
                    description: t.matched ? 'Suggested by their answers' : undefined,
                    emoji: t.matched ? '⭐' : undefined
                })))
        ));
    } else if (ranked.length > 0) {
        rows.push(new ActionRowBuilder().addComponents(
            ...ranked.map(t => new ButtonBuilder()
                .setCustomId(`formrep_t_${submissionId}_${t.template_id}`)
                .setLabel(String(t.name).slice(0, 80))
                .setStyle(t.matched ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setEmoji(t.matched ? '⭐' : '✉️'))
        ));
    }

    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`formrep_w_${submissionId}`)
            .setLabel(alreadyReplied ? `Write a reply (${alreadyReplied} sent)` : 'Write a reply…')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('✏️')
    ));
    return rows;
}

/**
 * The free-text reply box.
 * `templateId` is threaded through so a reply that STARTED as a saved template still records
 * where it came from, even after the sender edited it.
 */
export function buildReplyModal(submissionId, prefill, templateId = null) {
    const input = new TextInputBuilder()
        .setCustomId('body')
        .setLabel('Your reply')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
        .setPlaceholder('Sent to them as a DM from the bot.');
    if (prefill) input.setValue(String(prefill).slice(0, 4000));
    return new ModalBuilder()
        .setCustomId(`formrep_m_${submissionId}${templateId ? `_${templateId}` : ''}`)
        .setTitle('Reply to this applicant')
        .addComponents(new ActionRowBuilder().addComponents(input));
}

/**
 * What the sender sees BEFORE anything is sent.
 *
 * Clicking a saved reply used to send it on the spot, which is a real message to a real person
 * from one stray tap — and in a DM, where a phone puts the buttons under your thumb. So the click
 * now renders the finished text instead: placeholders already substituted, so it reads exactly as
 * the applicant will read it, with the send still one deliberate press away.
 */
export function buildPreviewEmbed({ rendered, template, submission, form, guild, guildId, alreadySent }) {
    const who = submission.display_name || submission.username || submission.user_id;
    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'warning'))
        .setTitle(`Preview${template ? ` — ${String(template.name).slice(0, 200)}` : ''}`.slice(0, 256))
        .setDescription(String(rendered).slice(0, REPLY_BODY_LIMIT))
        .addFields({ name: 'Goes to', value: `**${who}** — <@${submission.user_id}>` });

    if (alreadySent > 0) {
        // The single most likely mistake here is sending the same instructions twice.
        embed.addFields({
            name: '⚠️ Already replied',
            value: `This applicant has had **${alreadySent}** repl${alreadySent === 1 ? 'y' : 'ies'} already.`
        });
    }
    embed.setFooter({ text: 'Nothing has been sent yet.' });
    return embed;
}

/** Send / Edit first / Cancel. */
export function buildPreviewButtons(submissionId, templateId) {
    const suffix = templateId ? `${submissionId}_${templateId}` : `${submissionId}`;
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`formrep_c_${suffix}`)
            .setLabel('Send it').setStyle(ButtonStyle.Success).setEmoji('📨'),
        new ButtonBuilder().setCustomId(`formrep_e_${suffix}`)
            .setLabel('Edit first').setStyle(ButtonStyle.Secondary).setEmoji('✏️'),
        new ButtonBuilder().setCustomId('formrep_x')
            .setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    )];
}

/**
 * May this person reply on this form's behalf?
 *
 * Anyone on the form's DM list, or anyone with Manage Server in the guild. The check matters:
 * these buttons live in a DM, and a DM is not a permissioned place — without it, a forwarded
 * screenshot's custom id would be enough for a stranger to message applicants as the server.
 */
export async function canReply(client, guildId, userId, dmRecipients) {
    if (dmRecipients?.includes(String(userId))) return true;
    try {
        const guild = client.guilds?.cache?.get(guildId) || await client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return false;
        const { PermissionsBitField } = await import('discord.js');
        return member.permissions.has(PermissionsBitField.Flags.ManageGuild);
    } catch {
        return false;
    }
}

/**
 * Send one reply and record the outcome.
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function sendReply(client, { submission, form, guild, body, senderId, senderTag, templateId }) {
    const rendered = renderBody(body, {
        submitter: {
            id: submission.user_id,
            username: submission.username,
            displayName: submission.display_name || submission.username
        },
        form,
        guild
    });

    let status = 'sent';
    let reason = null;
    try {
        const user = await client.users.fetch(submission.user_id);
        await user.send({
            embeds: [buildReplyEmbed({
                body: rendered, form, guild, guildId: submission.guild_id, senderTag
            })]
        });
    } catch (error) {
        status = 'failed';
        reason = describeDmError(error);
        logger.warn('[Form Reply] Could not deliver', {
            formId: form?.form_id, recipient: submission.user_id, code: error?.code, reason });
    }

    await pool.execute(
        `INSERT INTO form_replies
            (submission_id, form_id, guild_id, sender_id, recipient_id, template_id, body, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [submission.submission_id ?? null, form.form_id, submission.guild_id, senderId,
         submission.user_id, templateId ?? null, rendered, status, reason?.slice(0, 255) ?? null]
    ).catch(() => { /* the log is a convenience; never let it sink a delivery */ });

    return { ok: status === 'sent', reason, rendered };
}

/** How many replies this submission has already had — shown on the button so it is not sent twice. */
export async function replyCount(submissionId) {
    if (!submissionId) return 0;
    const [[row]] = await pool.execute(
        "SELECT COUNT(*) AS n FROM form_replies WHERE submission_id = ? AND status = 'sent'", [submissionId]);
    return Number(row?.n ?? 0);
}
