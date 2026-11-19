/*
 * Bet form on a betting poll (modal customId poll_bet_modal:<pollId>). The "Place a Bet" button
 * that opens it is handled by PollsManager.handleVote (the poll button fallback in
 * events/interactionCreate.js); the bet itself is core/polls-manager.js placeBet.
 */
import PollsManager from '../../core/polls-manager.js';
import logger from '../../utils/logger.js';

export async function handlePollBetSubmit(interaction) {
    try {
        const manager = interaction.client.pollsManager || new PollsManager(interaction.client);
        await manager.handleBetModal(interaction);
    } catch (error) {
        logger.error('[Poll Bet] Bet form failed', { error: error.message, customId: interaction.customId, userId: interaction.user?.id });
        const payload = { content: '❌ Your bet could not be placed — try again.', ephemeral: true };
        if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
        else await interaction.reply(payload).catch(() => {});
    }
}

export default handlePollBetSubmit;
