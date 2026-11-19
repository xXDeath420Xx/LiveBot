import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { createTicket } from '../buttons/ticket_create.js';
import { collectFormAnswers, validateFormAnswers, MODAL_FIELD_LIMIT } from '../../core/form-questions.js';

/**
 * Handle ticket form modal submission
 * @param {ModalSubmitInteraction} interaction
 */
export async function handleTicketFormSubmit(interaction) {
    try {
        // Extract form ID and panel ID from custom ID
        // Format: ticket_form_submit_{formId}_{panelId}
        const parts = interaction.customId.split('_');
        const formId = parts[3];
        const panelId = parts[4] || null;

        // Read back exactly the questions the modal was built from — same ordering, same limit —
        // so a select/picker answer is decoded as a select and not fetched as a text input.
        const [questions] = await pool.execute(
            `SELECT * FROM ticket_form_questions WHERE form_id = ?
              ORDER BY question_order ASC, question_id ASC LIMIT ${MODAL_FIELD_LIMIT}`,
            [formId]
        );

        const responses = collectFormAnswers(interaction, questions);

        const problems = validateFormAnswers(responses, questions);
        if (problems.length > 0) {
            await interaction.reply({
                content: `Your ticket wasn't created:\n${problems.map(p => `\u2022 ${p}`).join('\n')}\n\nClick the button again to retry.`,
                ephemeral: true
            });
            return;
        }

        // Create the ticket with form responses and panel config
        await createTicket(interaction, JSON.stringify(responses), formId, panelId);

    } catch (error) {
        logger.error('[Ticket Form Submit Error]', error);
        await interaction.reply({
            content: 'An error occurred while submitting your form. Please try again later.',
            ephemeral: true
        }).catch(() => {});
    }
}

export default handleTicketFormSubmit;
