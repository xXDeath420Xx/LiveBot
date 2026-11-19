import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import PollsManager from '../../core/polls-manager.js';

/**
 * Handle poll write-in submission
 * Stores the custom answer and allows others to vote on it
 */
export async function handlePollWriteInSubmit(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        // Extract poll ID from custom ID
        const pollId = interaction.customId.replace('poll_write_in_submit_', '');
        const answer = interaction.fields.getTextInputValue('write_in_answer').trim();

        if (!answer || answer.length === 0) {
            await interaction.editReply({ content: 'Please provide a valid answer.' });
            return;
        }

        // Get poll from database
        const [[poll]] = await pool.execute(
            'SELECT * FROM polls WHERE id = ? AND status = "active"',
            [pollId]
        );

        if (!poll) {
            await interaction.editReply({ content: 'This poll is no longer active.' });
            return;
        }

        if (!poll.allow_write_in) {
            await interaction.editReply({ content: 'Write-in answers are not enabled for this poll.' });
            return;
        }

        // Get existing write-in answers
        let writeInAnswers = [];
        if (poll.write_in_answers) {
            try {
                writeInAnswers = JSON.parse(poll.write_in_answers);
            } catch (e) {
                logger.error('[Poll Write-In] Error parsing write_in_answers:', e);
                writeInAnswers = [];
            }
        }

        // Check if user already submitted a write-in
        const existingIndex = writeInAnswers.findIndex(w => w.user_id === interaction.user.id);

        if (existingIndex >= 0) {
            // Update existing write-in
            writeInAnswers[existingIndex].answer = answer;
            writeInAnswers[existingIndex].updated_at = new Date().toISOString();
        } else {
            // Add new write-in
            writeInAnswers.push({
                user_id: interaction.user.id,
                answer: answer,
                created_at: new Date().toISOString()
            });
        }

        // Save to database
        await pool.execute(
            'UPDATE polls SET write_in_answers = ? WHERE id = ?',
            [JSON.stringify(writeInAnswers), pollId]
        );

        logger.info(`[Poll Write-In] User ${interaction.user.tag} submitted write-in for poll ${pollId}`, {
            pollId,
            userId: interaction.user.id,
            answer,
            guildId: poll.guild_id
        });

        // Redraw through the polls manager — the same renderer votes and edits use
        const manager = interaction.client.pollsManager || new PollsManager(interaction.client);
        const votes = {};
        for (const [userId, v] of Object.entries(poll.votes ? JSON.parse(poll.votes) : {})) votes[userId] = [].concat(v);
        await manager.renderPoll(poll, votes, writeInAnswers);

        await interaction.editReply({
            content: `✅ Your answer "${answer}" has been added to the poll! Other users can now vote on it.`
        });

    } catch (error) {
        logger.error('[Poll Write-In Submit Error]', error);
        await interaction.editReply({
            content: 'An error occurred while submitting your answer.'
        }).catch(() => {});
    }
}
