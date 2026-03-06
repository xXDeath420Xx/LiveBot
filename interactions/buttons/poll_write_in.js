import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

/**
 * Handle poll write-in button click
 * Shows a modal for users to submit their custom answer
 */
export async function handlePollWriteIn(interaction) {
    try {
        const messageId = interaction.message.id;

        // Get poll from database
        const [[poll]] = await pool.execute(
            'SELECT * FROM polls WHERE message_id = ? AND status = "active"',
            [messageId]
        );

        if (!poll) {
            await interaction.reply({
                content: 'This poll is no longer active.',
                ephemeral: true
            });
            return;
        }

        if (!poll.allow_write_in) {
            await interaction.reply({
                content: 'Write-in answers are not enabled for this poll.',
                ephemeral: true
            });
            return;
        }

        // Create modal
        const modal = new ModalBuilder()
            .setCustomId(`poll_write_in_submit_${poll.id}`)
            .setTitle('Submit Your Answer');

        const answerInput = new TextInputBuilder()
            .setCustomId('write_in_answer')
            .setLabel('Your Custom Answer')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter your answer here...')
            .setRequired(true)
            .setMaxLength(100);

        const row = new ActionRowBuilder().addComponents(answerInput);
        modal.addComponents(row);

        await interaction.showModal(modal);

    } catch (error) {
        logger.error('[Poll Write-In Button Error]', error);
        await interaction.reply({
            content: 'An error occurred while processing your request.',
            ephemeral: true
        }).catch(() => {});
    }
}

export default handlePollWriteIn;
