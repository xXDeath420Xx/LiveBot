/**
 * Select-menu handler for CAH card picks. CustomId: `cah_pick:<gameId>`.
 *
 * Discord StringSelectMenu preserves the user's selection ORDER in `values[]`,
 * which is critical for pick-N black cards where the order fills in blanks.
 *
 * If the player picked any blank cards (negative id), we open a modal to
 * collect the custom text(s) before submitting. Otherwise we submit
 * immediately.
 */
import {
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder
} from 'discord.js';
import { getGame } from '../../core/cah-manager.js';
import logger from '../../utils/logger.js';

// Stash pending picks while we collect blank-card text via modal
const pendingPicks = new Map();   // `${userId}:${gameId}` -> { ids: number[], blankIndexes: number[] }

export async function handleCahPick(interaction) {
    const [, gameId] = interaction.customId.split(':');
    const game = getGame(gameId);
    if (!game) return interaction.reply({ content: '❌ Game no longer exists.', ephemeral: true });

    const ids = interaction.values.map(v => parseInt(v, 10));
    const blankIdx = ids.map((id, i) => id < 0 ? i : -1).filter(i => i >= 0);

    if (blankIdx.length === 0) {
        const r = game.submitCards(interaction.user.id, ids);
        if (!r.ok) return interaction.reply({ content: `❌ \`${r.reason}\``, ephemeral: true });
        return interaction.update({ content: '✅ Submitted. Waiting on others.', embeds: [], components: [] });
    }

    // Stash and ask the player to fill in the blanks
    const key = `${interaction.user.id}:${gameId}`;
    pendingPicks.set(key, { ids, blankIndexes: blankIdx });

    const modal = new ModalBuilder()
        .setCustomId(`cah_blank:${gameId}`)
        .setTitle('Fill in your blank card(s)');
    blankIdx.slice(0, 5).forEach(i => {
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId(`blank_${i}`)
                    .setLabel(`Card #${i + 1} answer`)
                    .setStyle(TextInputStyle.Short)
                    .setMinLength(1)
                    .setMaxLength(200)
                    .setRequired(true)
            )
        );
    });
    return interaction.showModal(modal);
}

export function consumePending(userId, gameId) {
    const key = `${userId}:${gameId}`;
    const pending = pendingPicks.get(key);
    pendingPicks.delete(key);
    return pending;
}
