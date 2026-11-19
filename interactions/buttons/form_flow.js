/**
 * The stepper behind a form panel: open, navigate, answer free text, submit.
 *
 * Every handler here re-reads the form and the session from the database rather than trusting the
 * message it was clicked on. A panel can sit in a channel for weeks while its questions are
 * edited, and the member's half-finished session outlives restarts — so the message is a view,
 * never the source of truth.
 */
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { EmbedBuilder } from 'discord.js';
import {
    loadForm, openSession, getSession, setStep, closeSession,
    renderStep, buildTextModal, finalAnswers, missingRequired, saveAnswer, sessionAnswers
} from '../../core/form-flow.js';
import { parseRecipients, buildResponseEmbed, deliverToRecipients } from '../../core/form-dm.js';
import {
    listTemplates, rankTemplates, buildReplyComponents, renderBody, buildReplyEmbed
} from '../../core/form-reply.js';
import { themeColor } from '../../core/guild-theme.js';

const EPHEMERAL = { ephemeral: true };

/** Panel button — `form_open_<formId>`. */
export async function handleFormOpen(interaction) {
    try {
        const formId = interaction.customId.slice('form_open_'.length);
        const loaded = await loadForm(interaction.guild.id, formId);
        if (!loaded) {
            return interaction.reply({ content: 'This form no longer exists.', ...EPHEMERAL });
        }
        if (loaded.questions.length === 0) {
            return interaction.reply({
                content: 'This form has no questions yet. Ask a server admin to add some.', ...EPHEMERAL });
        }

        const session = await openSession(interaction.guild.id, formId, interaction.user.id);
        const view = renderStep({ ...loaded, session, guildId: interaction.guild.id });
        await interaction.reply({ ...view, ...EPHEMERAL });
    } catch (error) {
        logger.error('[Form Open Error]', error);
        await interaction.reply({ content: 'Could not open that form. Please try again later.', ...EPHEMERAL })
            .catch(() => {});
    }
}

/** Re-draw the current step in place. */
async function refresh(interaction, session) {
    const loaded = await loadForm(interaction.guild.id, session.form_id);
    if (!loaded) return interaction.update({ content: 'This form no longer exists.', embeds: [], components: [] });
    // A question deleted while somebody was answering would leave the step past the end.
    if (session.step > loaded.questions.length) await setStep(session, loaded.questions.length);
    await interaction.update(renderStep({ ...loaded, session, guildId: interaction.guild.id }));
}

/** Back / Next / Submit — `formq_back_<id>`, `formq_next_<id>`, `formq_submit_<id>`. */
export async function handleFormNav(interaction) {
    try {
        const [, action, sessionId] = interaction.customId.split('_');
        const session = await getSession(sessionId, interaction.user.id);
        if (!session) {
            return interaction.update({
                content: 'That form session has expired — click the panel button to start again.',
                embeds: [], components: []
            });
        }

        if (action === 'back') {
            await setStep(session, Math.max(0, session.step - 1));
            return refresh(interaction, session);
        }
        if (action === 'next') {
            const loaded = await loadForm(interaction.guild.id, session.form_id);
            await setStep(session, Math.min(loaded.questions.length, session.step + 1));
            return refresh(interaction, session);
        }
        return submitForm(interaction, session);
    } catch (error) {
        logger.error('[Form Nav Error]', error);
        await interaction.reply({ content: 'Something went wrong. Please try again.', ...EPHEMERAL }).catch(() => {});
    }
}

/** "Type your answer" — `formq_txt_<sessionId>_<questionId>`. */
export async function handleFormText(interaction) {
    try {
        const [, , sessionId, questionId] = interaction.customId.split('_');
        const session = await getSession(sessionId, interaction.user.id);
        if (!session) {
            return interaction.reply({ content: 'That form session has expired — start again from the panel.', ...EPHEMERAL });
        }
        const [[question]] = await pool.execute(
            'SELECT * FROM ticket_form_questions WHERE question_id = ?', [questionId]);
        if (!question) {
            return interaction.reply({ content: 'That question has been removed.', ...EPHEMERAL });
        }
        await interaction.showModal(buildTextModal(session, question));
    } catch (error) {
        logger.error('[Form Text Error]', error);
        await interaction.reply({ content: 'Could not open the answer box.', ...EPHEMERAL }).catch(() => {});
    }
}

/**
 * Store the answers, then notify. Storage FIRST and unconditionally: a DM or a channel post that
 * fails must never cost somebody their application.
 */
export async function submitForm(interaction, session) {
    const loaded = await loadForm(interaction.guild.id, session.form_id);
    if (!loaded) {
        return interaction.update({ content: 'This form no longer exists.', embeds: [], components: [] });
    }
    const { form, questions } = loaded;

    const missing = missingRequired(questions, session);
    if (missing.length > 0) {
        const first = questions.indexOf(missing[0]);
        await setStep(session, first);
        const view = renderStep({ form, questions, session, guildId: interaction.guild.id });
        view.embeds[0].setFooter({ text: `Required — ${missing.length} question(s) still need an answer` });
        return interaction.update(view);
    }

    const answers = finalAnswers(questions, session);

    const member = interaction.member;
    const username = interaction.user.username || null;
    const displayName = member?.nickname || interaction.user.globalName || interaction.user.displayName || username;
    const avatarUrl = member?.displayAvatarURL?.({ size: 128 }) || interaction.user.displayAvatarURL({ size: 128 }) || null;

    const [inserted] = await pool.execute(
        `INSERT INTO form_submissions
            (form_id, guild_id, user_id, username, display_name, avatar_url, submission_data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [form.form_id, interaction.guild.id, interaction.user.id,
         username?.slice(0, 64) || null, displayName?.slice(0, 64) || null,
         avatarUrl?.slice(0, 255) || null, JSON.stringify(answers)]
    );

    await closeSession(session.session_id);

    const submitter = { id: interaction.user.id, username, displayName, avatarUrl };

    // ── answer them on the spot, if this form is set up to ───────────────────
    // A form whose whole purpose is "tell me which one you are so I can hand you the right
    // instructions" should not make anybody wait for a human. Same matching the notification DM
    // uses, so there is one definition of which reply fits which answer.
    let autoReply = null;
    if (Number(form.auto_reply)) {
        const templates = await listTemplates(interaction.guild.id, form.form_id).catch(() => []);
        const ranked = rankTemplates(templates, answers, questions);
        // The template whose rule fits; failing that, one with no rule at all, which is how a
        // form says "everyone else gets this".
        const chosen = ranked.find(t => t.matched)
            || ranked.find(t => !t.match_question_id || !t.match_contains)
            || null;

        if (chosen) {
            const body = renderBody(chosen.body, { submitter, form, guild: interaction.guild });

            // The confirmation is EPHEMERAL — it vanishes when Discord feels like it, and this
            // text can carry an access code. So a copy goes to their DMs, and if that fails they
            // are told plainly to keep what is on screen.
            let dmOk = false;
            try {
                await interaction.user.send({
                    embeds: [buildReplyEmbed({
                        body, form, guild: interaction.guild,
                        guildId: interaction.guild.id, senderTag: null
                    })]
                });
                dmOk = true;
            } catch { dmOk = false; }

            await pool.execute(
                `INSERT INTO form_replies
                    (submission_id, form_id, guild_id, sender_id, recipient_id, template_id, direction, body, status, error)
                 VALUES (?, ?, ?, ?, ?, ?, 'out', ?, ?, ?)`,
                [inserted?.insertId ?? null, form.form_id, interaction.guild.id,
                 interaction.client.user.id, interaction.user.id, chosen.template_id,
                 body, dmOk ? 'sent' : 'failed', dmOk ? null : 'Their DMs are closed']
            ).catch(() => {});

            autoReply = { body, dmOk };
        }
    }

    await interaction.update({
        content: null,
        embeds: [autoReply
            ? new EmbedBuilder()
                .setColor(themeColor(interaction.guild.id, 'success'))
                .setTitle('Thanks — here’s how to get in')
                .setDescription(autoReply.body.slice(0, 4000))
                .setFooter({ text: autoReply.dmOk
                    ? 'A copy is in your DMs, so you will not lose this.'
                    : 'Your DMs are closed, so copy anything you need from here before you dismiss it.' })
            : new EmbedBuilder()
                .setColor(themeColor(interaction.guild.id, 'success'))
                .setTitle('Submitted')
                .setDescription(`Thanks — your response to **${form.form_name}** has been recorded.`)],
        components: []
    });

    // The per-submission notification is opt-outable on its own. The recipient list is NOT the
    // switch for it — that list is also where an applicant's own replies get forwarded, so
    // emptying it to stop the pings would quietly strand anyone who writes back.
    const recipients = parseRecipients(form.dm_user_ids);
    if (recipients.length > 0 && Number(form.dm_on_submit ?? 1)) {
        // Templates ride along with the notification, ranked so the ones the answers actually
        // point at come first. Resolved here, once, rather than per recipient.
        const templates = await listTemplates(interaction.guild.id, form.form_id).catch(() => []);
        const ranked = rankTemplates(templates, answers, questions);

        deliverToRecipients(interaction.client, {
            recipients,
            embed: buildResponseEmbed({
                guild: interaction.guild, guildId: interaction.guild.id,
                formName: form.form_name, answers, submitter
            }),
            components: inserted?.insertId
                ? buildReplyComponents(inserted.insertId, ranked)
                : [],
            formId: form.form_id,
            guildId: interaction.guild.id,
            submissionId: inserted?.insertId ?? null
        }).catch(e => logger.warn('[Form Submit] DM pass failed', { error: e.message }));
    }

    if (form.submit_channel_id) {
        try {
            const channel = await interaction.client.channels.fetch(form.submit_channel_id);
            await channel?.send({
                embeds: [buildResponseEmbed({
                    guild: interaction.guild, guildId: interaction.guild.id,
                    formName: form.form_name, answers, submitter
                })]
            });
        } catch (error) {
            logger.warn('[Form Submit] Could not post to submit channel', {
                formId: form.form_id, channelId: form.submit_channel_id, error: error.message });
        }
    }
}

export { sessionAnswers, saveAnswer };
