const { EmbedBuilder } = require('discord.js');
const db = require('../../utils/db');
const logger = require('../../utils/logger');

module.exports = {
    customId: /^ticket_feedback_(\d+)_(\d)$/,
    async execute(interaction) {
        const match = interaction.customId.match(/^ticket_feedback_(\d+)_(\d)$/);
        const ticketId = parseInt(match[1]);
        const rating = parseInt(match[2]);

        try {
            // Check if feedback has already been submitted
            const [[existingFeedback]] = await db.execute('SELECT * FROM ticket_feedback WHERE ticket_id = ?', [ticketId]);
            if (existingFeedback) {
                return interaction.reply({ content: 'You have already submitted feedback for this ticket.', ephemeral: true });
            }

            await db.execute(
                'INSERT INTO ticket_feedback (ticket_id, user_id, rating) VALUES (?, ?, ?)',
                [ticketId, interaction.user.id, rating]
            );

            const newEmbed = EmbedBuilder.from(interaction.message.embeds[0])
                .setDescription(`Your ticket in **${interaction.guild?.name || 'a server'}** has been closed. A transcript has been saved for your records.\n\n**Thank you for your feedback!** You rated this support interaction **${rating} out of 5 stars**.`)

            // Disable the buttons after feedback is given
            const disabledRow = new ActionRowBuilder();
            for (let i = 1; i <= 5; i++) {
                disabledRow.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`ticket_feedback_${ticketId}_${i}`)
                        .setLabel('⭐'.repeat(i))
                        .setStyle(i === rating ? ButtonStyle.Success : ButtonStyle.Secondary)
                        .setDisabled(true)
                );
            }

            await interaction.update({ embeds: [newEmbed], components: [disabledRow] });

            logger.info(`Received ${rating}-star feedback for ticket #${ticketId} from ${interaction.user.tag}.`, { category: 'tickets' });

        } catch (error) {
            if (error.code === 'ER_NO_SUCH_TABLE') {
                return interaction.reply({ content: 'The database tables for this feature have not been created yet. Please ask the bot owner to update the schema.', ephemeral: true });
            }
            logger.error('Error processing ticket feedback:', error);
            await interaction.reply({ content: 'An error occurred while submitting your feedback.', ephemeral: true });
        }
    },
};