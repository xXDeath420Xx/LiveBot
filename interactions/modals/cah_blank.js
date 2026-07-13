/**
 * Modal handler for CAH blank-card text. CustomId: `cah_blank:<gameId>`.
 * Combines the modal text inputs with the pending picks stashed by the
 * select-menu handler, then submits to the engine.
 */
import { getGame } from '../../core/cah-manager.js';
import { consumePending } from '../select-menus/cah_pick.js';

export async function handleCahBlankSubmit(interaction) {
    const [, gameId] = interaction.customId.split(':');
    const game = getGame(gameId);
    if (!game) return interaction.reply({ content: '❌ Game no longer exists.', ephemeral: true });

    const pending = consumePending(interaction.user.id, gameId);
    if (!pending) return interaction.reply({ content: '❌ No pending pick — try clicking "View My Hand" again.', ephemeral: true });

    // Merge text into the picks array — preserve original order
    const picks = pending.ids.map((id, i) => {
        if (id < 0) {
            const text = interaction.fields.getTextInputValue(`blank_${i}`);
            return { id, text };
        }
        return { id };
    });

    const r = game.submitCards(interaction.user.id, picks);
    if (!r.ok) return interaction.reply({ content: `❌ \`${r.reason}\``, ephemeral: true });
    return interaction.reply({ content: '✅ Submitted with your custom answer. Waiting on others.', ephemeral: true });
}
