/**
 * Ask a form one question at a time, in an ephemeral message.
 *
 * THE POINT OF THIS FILE. A Discord modal caps a field heading at 45 characters and its help text
 * at 100, and holds five fields. A long question — a consent clause, a rules acknowledgement —
 * simply cannot be shown in one. Every arrangement of label/description is just a different place
 * to hide part of the sentence.
 *
 * A message has none of those limits: 4096 characters of embed description, 25 options of 100
 * characters each in a select menu, and as many steps as you like. So the form is asked as a
 * sequence of ephemeral messages the member steps through. The question is always shown in full.
 *
 * Free-text answers still need a modal — it is the only way Discord lets someone type — but that
 * modal now carries ONE field, and the question it is asking is already on screen in full behind
 * it, so its short heading costs nothing.
 */
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    EmbedBuilder,
    ModalBuilder,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle,
    UserSelectMenuBuilder
} from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';
import { TYPES, isValidType, parseOptions } from './form-questions.js';

/** A message embed description. Vastly larger than a modal's 100. */
const DESCRIPTION_LIMIT = 4096;
/** Select option label limit IN A MESSAGE — 100, unlike the 45 a modal imposes. */
const OPTION_LABEL_LIMIT = 100;
/** An abandoned attempt is cleared after this long so it cannot resume weeks later. */
const SESSION_TTL_HOURS = 24;

const truncate = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''));

export async function loadForm(guildId, formId) {
    const [forms] = await pool.execute(
        'SELECT * FROM ticket_forms WHERE form_id = ? AND guild_id = ?', [formId, guildId]);
    if (forms.length === 0) return null;
    const [questions] = await pool.execute(
        `SELECT * FROM ticket_form_questions WHERE form_id = ?
          ORDER BY question_order ASC, question_id ASC`, [formId]);
    return { form: forms[0], questions };
}

/** Start a session, or resume the one already in flight. */
export async function openSession(guildId, formId, userId) {
    await pool.execute(
        'DELETE FROM form_sessions WHERE updated_at < DATE_SUB(NOW(), INTERVAL ? HOUR)',
        [SESSION_TTL_HOURS]).catch(() => {});

    const [existing] = await pool.execute(
        'SELECT * FROM form_sessions WHERE form_id = ? AND user_id = ?', [formId, userId]);
    if (existing.length > 0) return existing[0];

    const [result] = await pool.execute(
        'INSERT INTO form_sessions (form_id, guild_id, user_id, step, answers) VALUES (?, ?, ?, 0, ?)',
        [formId, guildId, userId, '{}']);
    const [[row]] = await pool.execute(
        'SELECT * FROM form_sessions WHERE session_id = ?', [result.insertId]);
    return row;
}

export async function getSession(sessionId, userId) {
    const [rows] = await pool.execute(
        'SELECT * FROM form_sessions WHERE session_id = ? AND user_id = ?', [sessionId, userId]);
    return rows[0] || null;
}

export function sessionAnswers(session) {
    try { return JSON.parse(session.answers || '{}'); } catch { return {}; }
}

export async function saveAnswer(session, questionId, value) {
    const answers = sessionAnswers(session);
    answers[String(questionId)] = value;
    await pool.execute('UPDATE form_sessions SET answers = ? WHERE session_id = ?',
        [JSON.stringify(answers), session.session_id]);
    session.answers = JSON.stringify(answers);
    return answers;
}

export async function setStep(session, step) {
    await pool.execute('UPDATE form_sessions SET step = ? WHERE session_id = ?', [step, session.session_id]);
    session.step = step;
}

export async function closeSession(sessionId) {
    await pool.execute('DELETE FROM form_sessions WHERE session_id = ?', [sessionId]).catch(() => {});
}

/** How an already-given answer reads back on the review step. */
function displayAnswer(question, raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    if (Array.isArray(raw)) return raw.join(', ');
    return String(raw);
}

/**
 * Render one step of the flow.
 *
 * The question goes in the embed description at full length. The control underneath answers it.
 * Nothing here truncates a question below 4096 characters, which no realistic question reaches.
 */
export function renderStep({ form, questions, session, guildId }) {
    const answers = sessionAnswers(session);
    const total = questions.length;
    const atReview = session.step >= total;

    if (atReview) {
        const embed = new EmbedBuilder()
            .setColor(themeColor(guildId, 'primary'))
            .setTitle(truncate(`Review — ${form.form_name}`, 256))
            .setDescription('Check your answers, then submit.');
        for (const q of questions) {
            const shown = displayAnswer(q, answers[String(q.question_id)]);
            embed.addFields({
                name: truncate(q.field_label || q.question_text, 256),
                value: truncate(shown || '*Not answered*', 1024)
            });
        }
        const nav = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`formq_back_${session.session_id}`)
                .setLabel('Back').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`formq_submit_${session.session_id}`)
                .setLabel('Submit').setStyle(ButtonStyle.Success).setEmoji('✅')
        );
        return { embeds: [embed], components: [nav] };
    }

    const question = questions[session.step];
    const type = isValidType(question.question_type) ? question.question_type : 'text';
    const required = question.is_required === undefined ? true : Boolean(question.is_required);
    const current = answers[String(question.question_id)];

    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'primary'))
        .setAuthor({ name: truncate(form.form_name, 256) })
        .setTitle(`Question ${session.step + 1} of ${total}`)
        // THE WHOLE QUESTION, verbatim. This is the line the modal could never manage.
        .setDescription(truncate(String(question.question_text), DESCRIPTION_LIMIT))
        .setFooter({ text: required ? 'Required' : 'Optional — you can skip this' });

    if (question.placeholder) {
        embed.addFields({ name: 'Hint', value: truncate(question.placeholder, 1024) });
    }
    const shown = displayAnswer(question, current);
    if (shown) embed.addFields({ name: 'Your answer', value: truncate(shown, 1024) });

    const rows = [];
    const id = `formq_sel_${session.session_id}_${question.question_id}`;

    if (type === 'select' || type === 'multiselect') {
        const options = parseOptions(question.question_options);
        if (options.length > 0) {
            const chosen = Array.isArray(current) ? current : (current ? [current] : []);
            rows.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(id)
                    .setPlaceholder(type === 'multiselect' ? 'Choose any that apply' : 'Choose one')
                    .setMinValues(0)
                    .setMaxValues(type === 'multiselect' ? options.length : 1)
                    .addOptions(options.map((o, index) => {
                        const option = new StringSelectMenuOptionBuilder()
                            // 100 characters here, not the modal's 45 — most choices fit whole.
                            .setLabel(truncate(o, OPTION_LABEL_LIMIT))
                            .setValue(`o${index}`)
                            .setDefault(chosen.includes(o));
                        return option;
                    }))
            ));
        }
    } else if (type === 'user') {
        rows.push(new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder().setCustomId(id).setPlaceholder('Pick a member').setMinValues(0).setMaxValues(1)));
    } else if (type === 'role') {
        rows.push(new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder().setCustomId(id).setPlaceholder('Pick a role').setMinValues(0).setMaxValues(1)));
    } else if (type === 'channel') {
        rows.push(new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder().setCustomId(id).setPlaceholder('Pick a channel').setMinValues(0).setMaxValues(1)));
    } else {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`formq_txt_${session.session_id}_${question.question_id}`)
                .setLabel(shown ? 'Change your answer' : 'Type your answer')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('✏️')
        ));
    }

    const nav = new ActionRowBuilder();
    nav.addComponents(new ButtonBuilder()
        .setCustomId(`formq_back_${session.session_id}`)
        .setLabel('Back').setStyle(ButtonStyle.Secondary).setDisabled(session.step === 0));
    nav.addComponents(new ButtonBuilder()
        .setCustomId(`formq_next_${session.session_id}`)
        .setLabel(session.step === total - 1 ? 'Review' : 'Next')
        .setStyle(ButtonStyle.Secondary));
    rows.push(nav);

    return { embeds: [embed], components: rows };
}

/**
 * The one-field modal used for free text.
 * Its heading can be short and generic because the question itself is already on screen, in full,
 * in the message that opened it.
 */
export function buildTextModal(session, question) {
    const type = isValidType(question.question_type) ? question.question_type : 'text';
    const input = new TextInputBuilder()
        .setCustomId('answer')
        .setLabel(truncate(question.field_label || 'Your answer', 45))
        .setStyle(type === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(Boolean(question.is_required));
    if (question.placeholder) input.setPlaceholder(truncate(question.placeholder, 100));
    else if (type === 'number') input.setPlaceholder('Enter a number');

    return new ModalBuilder()
        .setCustomId(`formq_mod_${session.session_id}_${question.question_id}`)
        .setTitle(truncate(`Question ${session.step + 1}`, 45))
        .addComponents(new ActionRowBuilder().addComponents(input));
}

/**
 * Turn the stored per-question answers into the { questionText: answer } shape everything
 * downstream (storage, the DM, the channel embed) already expects.
 */
export function finalAnswers(questions, session) {
    const raw = sessionAnswers(session);
    const out = {};
    for (const q of questions) {
        const value = raw[String(q.question_id)];
        out[q.question_text] = Array.isArray(value) ? value.join(', ') : (value ?? '');
    }
    return out;
}

/** Which required questions are still blank. Empty means the form is ready to submit. */
export function missingRequired(questions, session) {
    const raw = sessionAnswers(session);
    return questions.filter(q => {
        if (!Number(q.is_required ?? 1)) return false;
        const value = raw[String(q.question_id)];
        return value === undefined || value === null || value === '' ||
            (Array.isArray(value) && value.length === 0);
    });
}

export { logger };
