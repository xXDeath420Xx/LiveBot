/**
 * Modal handler for joining a password-protected CAH lobby.
 * CustomId: `cah_pwjoin:<gameId>`
 */
import { getGame, STATES } from '../../core/cah-manager.js';

export async function handleCahPasswordJoin(interaction) {
    const [, gameId] = interaction.customId.split(':');
    const game = getGame(gameId);
    if (!game) return interaction.reply({ content: '❌ Game no longer exists.', ephemeral: true });
    if (game.state !== STATES.LOBBY) return interaction.reply({ content: '⚠️ Game already in progress.', ephemeral: true });
    const password = interaction.fields.getTextInputValue('password');
    const r = game.addPlayer({
        userId: interaction.user.id,
        platform: 'discord',
        displayName: interaction.user.displayName || interaction.user.username,
        password
    });
    if (!r.ok) {
        const msg = r.reason === 'wrong_password' ? '❌ Wrong password.' : `❌ \`${r.reason}\``;
        return interaction.reply({ content: msg, ephemeral: true });
    }
    return interaction.reply({ content: '✅ Joined.', ephemeral: true });
}
