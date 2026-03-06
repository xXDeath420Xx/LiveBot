import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import SuggestionManager from '../../core/suggestion-manager.js';

/**
 * Handle suggestion upvote button clicks
 * @param {ButtonInteraction} interaction
 */
export async function handleSuggestionUpvote(interaction) {
    try {
        // Extract suggestion ID from custom ID
        const suggestionId = parseInt(interaction.customId.split('_')[2]);

        if (!suggestionId || isNaN(suggestionId)) {
            await interaction.reply({
                content: 'Invalid suggestion ID.',
                ephemeral: true
            });
            return;
        }

        // Verify suggestion exists
        const [suggestions] = await pool.execute(
            'SELECT * FROM suggestions WHERE id = ? AND guild_id = ?',
            [suggestionId, interaction.guild.id]
        );

        if (suggestions.length === 0) {
            await interaction.reply({
                content: 'Suggestion not found.',
                ephemeral: true
            });
            return;
        }

        const manager = new SuggestionManager(interaction.client);

        // Handle the vote
        const result = await manager.handleVote(
            suggestionId,
            interaction.user.id,
            interaction.guild.id,
            'upvote'
        );

        // Update vote counts
        const { upvotes, downvotes } = await manager.updateVoteCounts(suggestionId);

        // Update the message buttons
        const suggestion = suggestions[0];
        if (suggestion.message_id && suggestion.channel_id) {
            await manager.updateSuggestionMessage(
                interaction.guild,
                suggestion.channel_id,
                suggestion.message_id,
                suggestionId,
                upvotes,
                downvotes
            );
        }

        // Send response
        let responseMessage;
        if (result.action === 'removed') {
            responseMessage = 'Your upvote has been removed.';
        } else if (result.action === 'changed') {
            responseMessage = 'Changed your vote to upvote!';
        } else {
            responseMessage = 'Your upvote has been recorded!';
        }

        await interaction.reply({
            content: responseMessage,
            ephemeral: true
        });

    } catch (error) {
        logger.error('[Suggestion Upvote Button Error]', error);
        await interaction.reply({
            content: 'An error occurred while recording your vote. Please try again later.',
            ephemeral: true
        }).catch(() => {});
    }
}

export default handleSuggestionUpvote;
