import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import logger from '../../utils/logger.js';
import {
    isSuggestionStaff, getSuggestionConfig, approveSuggestion, rejectSuggestion,
} from '../../core/suggestion-review.js';

/**
 * The Approve / Reject buttons on a suggestion's review card (core/suggestion-review.js).
 * customIds: sgr:approve:<id>, sgr:reject:<id>; Reject opens sgr:rejectmodal:<id> for the reason,
 * which /engage suggest reject also requires.
 */
export async function handleSuggestionReviewButton(interaction) {
    const [, action, rawId] = interaction.customId.split(':');
    const suggestionId = Number.parseInt(rawId, 10);
    try {
        const config = await getSuggestionConfig(interaction.guildId);
        if (!isSuggestionStaff(interaction.member, config)) {
            await interaction.reply({ content: 'You need **Manage Server** or the suggestions staff role to review suggestions.', ephemeral: true });
            return;
        }

        if (action === 'reject') {
            const modal = new ModalBuilder()
                .setCustomId(`sgr:rejectmodal:${suggestionId}`)
                .setTitle(`Reject suggestion #${suggestionId}`)
                .addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('reason')
                        .setLabel('Reason (sent to the member)')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                        .setMaxLength(1000)
                ));
            await interaction.showModal(modal);
            return;
        }

        await interaction.deferReply({ ephemeral: true });
        const result = await approveSuggestion({
            client: interaction.client, guild: interaction.guild, suggestionId, reviewerId: interaction.user.id,
        });
        await interaction.editReply({
            content: result.ok ? `Suggestion #${suggestionId} approved${result.posted ? ' and posted for voting' : ''}.` : result.error,
        });
    } catch (err) {
        logger.error('[Suggestions] Review button failed', { guildId: interaction.guildId, suggestionId, error: err.message });
        const say = interaction.deferred ? 'editReply' : 'reply';
        await interaction[say]({ content: 'Something went wrong. Try again, or use the dashboard.', ephemeral: true }).catch(() => {});
    }
}

export async function handleSuggestionRejectModal(interaction) {
    const suggestionId = Number.parseInt(interaction.customId.split(':')[2], 10);
    try {
        const config = await getSuggestionConfig(interaction.guildId);
        if (!isSuggestionStaff(interaction.member, config)) {
            await interaction.reply({ content: 'You need **Manage Server** or the suggestions staff role to review suggestions.', ephemeral: true });
            return;
        }
        await interaction.deferReply({ ephemeral: true });
        const reason = interaction.fields.getTextInputValue('reason').trim();
        const result = await rejectSuggestion({
            client: interaction.client, guild: interaction.guild, suggestionId, reviewerId: interaction.user.id, reason,
        });
        await interaction.editReply({ content: result.ok ? `Suggestion #${suggestionId} rejected.` : result.error });
    } catch (err) {
        logger.error('[Suggestions] Reject modal failed', { guildId: interaction.guildId, suggestionId, error: err.message });
        const say = interaction.deferred ? 'editReply' : 'reply';
        await interaction[say]({ content: 'Something went wrong. Try again, or use the dashboard.', ephemeral: true }).catch(() => {});
    }
}
