import { EmbedBuilder, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import pool from '../../utils/db.js';
import { ticketLabel } from '../../core/ticket-number.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { logFeatureEvent, userLabel } from '../../core/feature-log.js';

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
        const ticketId = parseInt(parts[3], 10);
        const rating = parseInt(parts[4], 10);
        const comment = interaction.fields.getTextInputValue('comment') || null;

        if (!Number.isInteger(ticketId) || !Number.isInteger(rating) || rating < 1 || rating > 5) {
            logger.warn('[Ticket Feedback] Malformed feedback modal id', { customId: interaction.customId });
            await interaction.reply({ content: 'That feedback form is no longer valid.', ephemeral: true });
            return;
        }

        // The rating DM is sent from a ticket's close; only its owner gets one. Check the ticket
        // still exists and is theirs before recording anything against it.
        const [[ticket]] = await pool.execute(
            'SELECT id, guild_id, user_id, ticket_number FROM tickets WHERE id = ?',
            [ticketId]
        );
        if (!ticket || ticket.user_id !== interaction.user.id) {
            logger.warn('[Ticket Feedback] Feedback for unknown ticket or from a non-owner', {
                ticketId, userId: interaction.user.id, found: !!ticket
            });
            await interaction.reply({ content: 'That ticket could not be found, so the feedback was not saved.', ephemeral: true });
            return;
        }

        // ticket_feedback holds one row per ticket; rating again replaces the earlier answer.
        await pool.execute(
            `INSERT INTO ticket_feedback (ticket_id, user_id, rating, comment)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), rating = VALUES(rating),
                 comment = VALUES(comment), submitted_at = CURRENT_TIMESTAMP`,
            [ticketId, interaction.user.id, rating, comment]
        );

        const embed = new EmbedBuilder()
            .setColor(themeColor(ticket.guild_id, 'primary'))
            .setTitle('Thank You for Your Feedback!')
            .setDescription(`Your rating: ${'⭐'.repeat(rating)}\n\nWe appreciate your feedback and will use it to improve our support.`)
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });

        logger.info(`Feedback received for ticket #${ticketId}: ${rating}/5`, {
            ticketId,
            guildId: ticket.guild_id,
            rating,
            hasComment: !!comment,
            category: 'tickets'
        });

        // A DM interaction has no guild: resolve the ticket's server from this bot's cache
        void logFeatureEvent(() => (interaction.client.guilds.cache.get(ticket.guild_id)), 'tickets.feedback', () => ({
            title: '⭐ Ticket Feedback',
            fields: [
                ['Ticket', ticketLabel(ticket)], ['Member', userLabel(interaction.user)], ['Rating', `${'⭐'.repeat(rating)} (${rating}/5)`],
                ['Comment', comment ? comment.slice(0, 500) : null, false],
            ],
        }));

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
