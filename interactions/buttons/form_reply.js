/**
 * The reply controls on a response notification.
 *
 * `formrep_t_<submissionId>_<templateId>` — PREVIEW a saved reply (sends nothing)
 * `formrep_s_<submissionId>`              — the select-menu form of the same preview
 * `formrep_c_<submissionId>[_<templateId>]` — confirm and send the previewed reply
 * `formrep_e_<submissionId>[_<templateId>]` — open the previewed reply in the editable box
 * `formrep_x`                             — cancel; nothing was sent
 * `formrep_w_<submissionId>`              — open the free-text box
 * `formrep_m_<submissionId>[_<templateId>]` — that box, submitted
 *
 * NOTHING SENDS ON THE FIRST CLICK. These buttons sit in a DM, where a phone puts them under your
 * thumb, and the thing on the other side is a real message to a real person with no way back. So
 * the first press only ever renders what WOULD be sent.
 *
 * Everything is re-read from the database on every click. These buttons live in a DM that can sit
 * around for weeks while templates are rewritten and members leave, so the message is a view and
 * never the source of truth.
 */
import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { parseRecipients } from '../../core/form-dm.js';
import {
    getTemplate, listTemplates, rankTemplates, buildReplyComponents, buildReplyModal,
    buildPreviewEmbed, buildPreviewButtons,
    canReply, sendReply, renderBody, replyCount
} from '../../core/form-reply.js';

const EPHEMERAL = { ephemeral: true };

/** Load the submission, its form, and check the clicker is allowed to answer on its behalf. */
async function resolve(interaction, submissionId) {
    const [[submission]] = await pool.execute(
        'SELECT * FROM form_submissions WHERE submission_id = ?', [submissionId]);
    if (!submission) return { error: 'That response no longer exists.' };

    const [[form]] = await pool.execute(
        'SELECT * FROM ticket_forms WHERE form_id = ? AND guild_id = ?',
        [submission.form_id, submission.guild_id]);
    if (!form) return { error: 'That form no longer exists.' };

    const allowed = await canReply(
        interaction.client, submission.guild_id, interaction.user.id, parseRecipients(form.dm_user_ids));
    if (!allowed) return { error: "You're not set up to reply on this form's behalf." };

    const guild = interaction.client.guilds?.cache?.get(submission.guild_id)
        || await interaction.client.guilds.fetch(submission.guild_id).catch(() => null);

    return { submission, form, guild };
}

/** Confirm back to the sender, and refresh the notification's buttons with the new reply count. */
async function report(interaction, context, result) {
    const { submission, form } = context;
    const embed = new EmbedBuilder()
        .setColor(result.ok ? 0x57c785 : 0xff6a4d)
        .setTitle(result.ok ? 'Reply sent' : 'Reply not delivered')
        .setDescription(result.ok
            ? `Sent to **${submission.display_name || submission.username || submission.user_id}**.`
            : `Could not DM **${submission.display_name || submission.username || submission.user_id}** — ${result.reason}`)
        .addFields({ name: 'What they got', value: String(result.rendered).slice(0, 1024) });

    // editReply, not deleteReply+followUp: the deferred reply is already the right slot for this,
    // and deleting it first is one more thing that can fail between sending and confirming.
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ embeds: [embed] }).catch(() => {});
    } else {
        await interaction.reply({ embeds: [embed], ...EPHEMERAL }).catch(() => {});
    }

    // The original notification keeps its buttons so a second reply is still possible, but the
    // count on them makes an accidental double-send obvious before it happens.
    try {
        const [questions] = await pool.execute(
            `SELECT * FROM ticket_form_questions WHERE form_id = ?
              ORDER BY question_order ASC, question_id ASC`, [form.form_id]);
        let answers = {};
        try { answers = JSON.parse(submission.submission_data || '{}'); } catch { answers = {}; }
        const ranked = rankTemplates(await listTemplates(form.guild_id, form.form_id), answers, questions);
        await interaction.message?.edit({
            components: buildReplyComponents(submission.submission_id, ranked, {
                alreadyReplied: await replyCount(submission.submission_id)
            })
        });
    } catch { /* cosmetic only */ }
}

/** Render a template's body for this submission, with placeholders filled in. */
function renderFor(context, body) {
    return renderBody(body, {
        submitter: {
            id: context.submission.user_id,
            username: context.submission.username,
            displayName: context.submission.display_name || context.submission.username
        },
        form: context.form,
        guild: context.guild
    });
}

/**
 * A saved reply, from a button or the select menu.
 * PREVIEWS ONLY — the send lives behind the confirm button this puts on screen.
 */
export async function handleFormReplyTemplate(interaction) {
    try {
        const parts = interaction.customId.split('_');
        const submissionId = parts[2];
        const templateId = interaction.isStringSelectMenu?.() ? interaction.values[0] : parts[3];

        const context = await resolve(interaction, submissionId);
        if (context.error) return interaction.reply({ content: context.error, ...EPHEMERAL });

        const template = await getTemplate(templateId, context.submission.guild_id);
        if (!template) return interaction.reply({ content: 'That saved reply has been deleted.', ...EPHEMERAL });

        await interaction.reply({
            embeds: [buildPreviewEmbed({
                rendered: renderFor(context, template.body),
                template,
                submission: context.submission,
                form: context.form,
                guild: context.guild,
                guildId: context.submission.guild_id,
                alreadySent: await replyCount(context.submission.submission_id)
            })],
            components: buildPreviewButtons(submissionId, template.template_id),
            ...EPHEMERAL
        });
    } catch (error) {
        logger.error('[Form Reply Preview Error]', error);
        await interaction.reply({ content: 'Could not build that preview.', ...EPHEMERAL }).catch(() => {});
    }
}

/** "Send it" — the only path that actually delivers a saved reply. */
export async function handleFormReplyConfirm(interaction) {
    try {
        const parts = interaction.customId.split('_');
        const submissionId = parts[2];
        const templateId = parts[3] || null;

        const context = await resolve(interaction, submissionId);
        if (context.error) return interaction.update({ content: context.error, embeds: [], components: [] });

        let body = null;
        if (templateId) {
            const template = await getTemplate(templateId, context.submission.guild_id);
            if (!template) {
                return interaction.update({
                    content: 'That saved reply has been deleted since you opened this preview.',
                    embeds: [], components: []
                });
            }
            body = template.body;
        } else {
            // No template: the preview embed's own description is the text that was approved.
            body = interaction.message?.embeds?.[0]?.description ?? '';
        }
        if (!String(body).trim()) {
            return interaction.update({ content: 'Nothing to send.', embeds: [], components: [] });
        }

        await interaction.deferUpdate();
        const result = await sendReply(interaction.client, {
            ...context,
            body,
            senderId: interaction.user.id,
            senderTag: interaction.user.username,
            templateId
        });
        await report(interaction, context, result);
    } catch (error) {
        logger.error('[Form Reply Confirm Error]', error);
        await interaction.followUp({ content: 'Could not send that reply.', ...EPHEMERAL }).catch(() => {});
    }
}

/** "Edit first" — the previewed text, opened in the box so it can be changed before sending. */
export async function handleFormReplyEdit(interaction) {
    try {
        const parts = interaction.customId.split('_');
        const submissionId = parts[2];
        const templateId = parts[3] || null;

        const context = await resolve(interaction, submissionId);
        if (context.error) return interaction.reply({ content: context.error, ...EPHEMERAL });

        // Prefer the text on screen: it is what the sender just read and decided to adjust.
        const prefill = interaction.message?.embeds?.[0]?.description
            || (templateId ? renderFor(context, (await getTemplate(templateId, context.submission.guild_id))?.body ?? '') : '');

        await interaction.showModal(buildReplyModal(submissionId, prefill, templateId));
    } catch (error) {
        logger.error('[Form Reply Edit Error]', error);
        await interaction.reply({ content: 'Could not open the editor.', ...EPHEMERAL }).catch(() => {});
    }
}

/** "Cancel" — say plainly that nothing went out. */
export async function handleFormReplyCancel(interaction) {
    await interaction.update({
        content: 'Cancelled — nothing was sent.',
        embeds: [], components: []
    }).catch(() => {});
}

/** "Write a reply…" — opens the box, pre-filled with the best-matching template as a starting point. */
export async function handleFormReplyWrite(interaction) {
    try {
        const submissionId = interaction.customId.split('_')[2];
        const context = await resolve(interaction, submissionId);
        if (context.error) return interaction.reply({ content: context.error, ...EPHEMERAL });

        const [questions] = await pool.execute(
            `SELECT * FROM ticket_form_questions WHERE form_id = ?
              ORDER BY question_order ASC, question_id ASC`, [context.form.form_id]);
        let answers = {};
        try { answers = JSON.parse(context.submission.submission_data || '{}'); } catch { answers = {}; }

        // Pre-fill from the suggested template so "mostly the standard reply, with a line added"
        // is a small edit rather than a retype.
        const ranked = rankTemplates(
            await listTemplates(context.submission.guild_id, context.form.form_id), answers, questions);
        const suggested = ranked.find(t => t.matched);
        const prefill = suggested ? renderBody(suggested.body, {
            submitter: {
                id: context.submission.user_id,
                username: context.submission.username,
                displayName: context.submission.display_name || context.submission.username
            },
            form: context.form,
            guild: context.guild
        }) : '';

        await interaction.showModal(buildReplyModal(submissionId, prefill));
    } catch (error) {
        logger.error('[Form Reply Write Error]', error);
        await interaction.reply({ content: 'Could not open the reply box.', ...EPHEMERAL }).catch(() => {});
    }
}

/** The free-text box, submitted. */
export async function handleFormReplyModal(interaction) {
    try {
        const submissionId = interaction.customId.split('_')[2];
        const context = await resolve(interaction, submissionId);
        if (context.error) return interaction.reply({ content: context.error, ...EPHEMERAL });

        const body = interaction.fields.getTextInputValue('body')?.trim();
        if (!body) return interaction.reply({ content: 'Nothing to send.', ...EPHEMERAL });

        // Straight through: the sender wrote this text themselves a second ago and pressed submit,
        // so a preview of their own words would be a pointless extra press. The preview exists for
        // canned replies, where one tap could otherwise send text the sender has not re-read.
        const templateId = interaction.customId.split('_')[3] || null;

        await interaction.deferReply(EPHEMERAL);
        const result = await sendReply(interaction.client, {
            ...context,
            body,
            senderId: interaction.user.id,
            senderTag: interaction.user.username,
            templateId
        });
        await report(interaction, context, result);
    } catch (error) {
        logger.error('[Form Reply Modal Error]', error);
        await interaction.followUp({ content: 'Could not send that reply.', ...EPHEMERAL }).catch(() => {});
    }
}
