import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { createTicket } from '../buttons/ticket_create.js';

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

        // Get form questions to build response object
        const [questions] = await pool.execute(
            "SELECT question_id, question_text FROM ticket_form_questions WHERE form_id = ? ORDER BY question_id",
            [formId]
        );

        // Build responses object
        const responses = {};
        for (const question of questions) {
            const fieldValue = interaction.fields.getTextInputValue(`question_${question.question_id}`);
            responses[question.question_text] = fieldValue;
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
