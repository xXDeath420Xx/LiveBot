import { EmbedBuilder, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

/**
 * Handle ticket feedback button clicks
 * @param {ButtonInteraction} interaction
 */
export async function handleTicketFeedback(interaction) {
    try {
        // Extract ticket ID and rating from custom ID
        // Format: ticket_feedback_{ticketId}_{rating}
        const parts = interaction.customId.split('_');
        const ticketId = parts[2];
        const rating = parseInt(parts[3]);

        // Show modal for optional comment
        const modal = new ModalBuilder()
            .setCustomId(`ticket_feedback_comment_${ticketId}_${rating}`)
            .setTitle(`Feedback (${rating}/5 Stars)`);

        const commentInput = new TextInputBuilder()
            .setCustomId('comment')
            .setLabel('Additional Comments (Optional)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setPlaceholder('Tell us more about your experience...');

        const row = new ActionRowBuilder().addComponents(commentInput);
        modal.addComponents(row);

        await interaction.showModal(modal);

    } catch (error) {
        logger.error('[Ticket Feedback Button Error]', error);
        await interaction.reply({
            content: 'An error occurred while submitting your feedback.',
            ephemeral: true
        }).catch(() => {});
    }
}

/**
 * Handle feedback modal submission
 * @param {ModalSubmitInteraction} interaction
 */
export async function handleTicketFeedbackModal(interaction) {
    try {
        // Extract ticket ID and rating from custom ID
        // Format: ticket_feedback_comment_{ticketId}_{rating}
        const parts = interaction.customId.split('_');
        const ticketId = parts[3];
        const rating = parseInt(parts[4]);
        const comment = interaction.fields.getTextInputValue('comment') || null;

        // Update ticket with feedback
        await pool.execute(
            "UPDATE tickets SET feedback_rating = ?, feedback_comment = ? WHERE id = ?",
            [rating, comment, ticketId]
        );

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('Thank You for Your Feedback!')
            .setDescription(`Your rating: ${'⭐'.repeat(rating)}\n\nWe appreciate your feedback and will use it to improve our support.`)
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });

        logger.info(`Feedback received for ticket #${ticketId}: ${rating}/5`, {
            ticketId,
            rating,
            hasComment: !!comment,
            category: 'tickets'
        });

        // Remove buttons from original message
        await interaction.message.edit({ components: [] }).catch(() => {});

    } catch (error) {
        logger.error('[Ticket Feedback Modal Error]', error);
        await interaction.reply({
            content: 'An error occurred while submitting your feedback.',
            ephemeral: true
        }).catch(() => {});
    }
}

export default handleTicketFeedback;
