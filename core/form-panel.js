/**
 * The one place a form panel message is built, posted and kept current.
 *
 * ONE RENDERER. The reaction-role feature learned this the hard way: three separate copies of
 * "draw the panel" drifted apart until create, edit and repost each produced a different message.
 * Everything here — first post, an edit, an automatic refresh after a question changed — goes
 * through buildPanelMessage, so a panel cannot disagree with itself.
 *
 * WHY REFRESH IS AUTOMATIC. A panel lists the form's questions in full, so editing ANY of them
 * makes an already-posted panel wrong. Leaving that to a button somebody has to remember to press
 * is how a server ends up advertising questions it no longer asks, so syncPanelsForForm runs on
 * every change to the form or its questions.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { TYPES, isValidType, parseOptions } from './form-questions.js';

/** Load a form plus its questions, ordered exactly as the modal will ask them. */
export async function loadFormWithQuestions(guildId, formId) {
    const [forms] = await pool.execute(
        'SELECT * FROM ticket_forms WHERE form_id = ? AND guild_id = ?', [formId, guildId]);
    if (forms.length === 0) return null;
    const [questions] = await pool.execute(
        `SELECT * FROM ticket_form_questions WHERE form_id = ?
          ORDER BY question_order ASC, question_id ASC`, [formId]);
    return { form: forms[0], questions };
}

/** Discord's ceilings on an embed. Exceeding any of them rejects the whole message. */
const EMBED_FIELD_LIMIT = 25;
const FIELD_VALUE_LIMIT = 1024;
const EMBED_TOTAL_LIMIT = 6000;
/** Headroom left for the title, description and footer around the question list. */
const LIST_BUDGET = 4800;

/**
 * "What you will be asked" — every question in full, with its choices, for the panel message.
 *
 * This is the one place a member sees the whole form before deciding to start it. It exists on its
 * own merits now rather than as compensation for a modal, so it lists questions in full and stops
 * cleanly at Discord's limits instead of letting a long form silently fail to post: an embed is
 * capped at 25 fields, 1024 characters per field and 6000 overall, and breaching any of them
 * rejects the entire message.
 */
export function questionListFields(questions) {
    const fields = [{ name: '\u200b', value: '**What you will be asked**' }];
    let budget = LIST_BUDGET - fields[0].value.length;

    for (const [index, q] of questions.entries()) {
        if (fields.length >= EMBED_FIELD_LIMIT - 1 || budget <= 0) {
            fields.push({
                name: '\u200b',
                value: `…and ${questions.length - index} more question${questions.length - index === 1 ? '' : 's'}.`
            });
            break;
        }

        const type = isValidType(q.question_type) ? q.question_type : 'text';
        const choices = parseOptions(q.question_options);
        const parts = [String(q.question_text ?? '').trim()];
        if (choices.length) parts.push(choices.map(c => `• ${c}`).join('\n'));
        if (!Number(q.is_required ?? 1)) parts.push('*Optional*');

        const name = `${index + 1}. ${q.field_label || TYPES[type]?.label || type}`.slice(0, 256);
        const value = parts.join('\n\n').slice(0, FIELD_VALUE_LIMIT);
        budget -= name.length + value.length;
        fields.push({ name, value });
    }
    return fields;
}

/**
 * The message payload for a panel. Pure — no Discord calls — so it is trivially testable and
 * identical for every caller.
 */
export function buildPanelMessage({ form, questions, panel }) {
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(String(panel?.panel_title || form.form_name).slice(0, 256))
        .setDescription(String(
            panel?.panel_description || form.form_description ||
            'Click the button below to fill out this form'
        ).slice(0, 4096))
        .setTimestamp();

    if (questions.length) {
        embed.setFooter({ text: `${questions.length} question${questions.length === 1 ? '' : 's'}` });
        if (Number(form.show_questions_on_panel ?? 1)) {
            embed.addFields(...questionListFields(questions));
        }
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`form_open_${form.form_id}`)
            .setLabel(String(panel?.button_text || 'Open Form').slice(0, 80))
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📝')
    );

    return { embeds: [embed], components: [row] };
}

/**
 * Push a panel row to Discord: edit its message if it still exists, otherwise post a new one.
 *
 * A message that has been deleted in Discord comes back as an error here. That is NOT a failure —
 * it is the normal way a panel gets removed — so the row's message_id is cleared and a fresh
 * message is posted, which is what makes Repost work without a separate code path.
 *
 * @returns {Promise<{messageId: string|null, reposted: boolean, error: string|null}>}
 */
export async function pushPanel(client, panel, { form, questions }) {
    const payload = buildPanelMessage({ form, questions, panel });

    const channel = await client.channels.fetch(panel.channel_id).catch(() => null);
    if (!channel) {
        return { messageId: null, reposted: false, error: 'channel not found' };
    }

    if (panel.message_id) {
        const existing = await channel.messages.fetch(panel.message_id).catch(() => null);
        if (existing) {
            // Ownership, not `existing.editable`. That getter folds in channel.viewable, which can
            // be false on a freshly fetched channel for reasons unrelated to whether this client
            // may edit the message — and a false negative here silently deletes and re-posts a
            // perfectly good panel, losing its position in the channel.
            if (existing.author?.id === client.user?.id) {
                await existing.edit(payload);
                return { messageId: existing.id, reposted: false, error: null };
            }
            // Genuinely someone else's message: replace it rather than patch it.
            await existing.delete().catch(() => {});
        }
    }

    const sent = await channel.send(payload);
    return { messageId: sent.id, reposted: Boolean(panel.message_id), error: null };
}

/** Persist the outcome of a push back onto the row. */
async function recordPush(panelId, result) {
    await pool.execute(
        'UPDATE form_panels SET message_id = ? WHERE panel_id = ?',
        [result.messageId, panelId]
    ).catch(() => {});
}

/**
 * Bring every posted panel for a form back in line with the form's current content.
 * Best-effort by design: called from routes that have already succeeded at their real job, so a
 * panel that cannot be updated must never turn a successful save into a failure.
 *
 * @returns {Promise<{updated: number, failed: number}>}
 */
export async function syncPanelsForForm(client, guildId, formId) {
    let updated = 0;
    let failed = 0;
    try {
        const [panels] = await pool.execute(
            'SELECT * FROM form_panels WHERE guild_id = ? AND form_id = ?', [guildId, formId]);
        if (panels.length === 0) return { updated, failed };

        const loaded = await loadFormWithQuestions(guildId, formId);
        if (!loaded || !client) return { updated, failed: panels.length };

        for (const panel of panels) {
            try {
                const result = await pushPanel(client, panel, loaded);
                if (result.error) { failed++; continue; }
                await recordPush(panel.panel_id, result);
                updated++;
            } catch (error) {
                failed++;
                logger.warn('[Form Panel] Could not sync panel', {
                    panelId: panel.panel_id, formId, error: error.message
                });
            }
        }
        if (updated) logger.info(`[Form Panel] Synced ${updated} posted panel(s) for form ${formId}`);
    } catch (error) {
        logger.warn('[Form Panel] Sync pass failed', { formId, guildId, error: error.message });
    }
    return { updated, failed };
}
