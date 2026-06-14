/**
 * Modal submit for `/buymeacoffee link`. The key is entered in a private form (not a
 * visible command option) and validated + stored encrypted, per-user. customId: bmc_link_submit.
 */
import { MessageFlags } from 'discord.js';
import logger from '../../utils/logger.js';

export async function handleBmcLinkSubmit(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const manager = interaction.client.buymeacoffeeManager;
    if (!manager) {
        return interaction.editReply('Buy Me a Coffee is still initializing — try again in a moment.');
    }
    const key = (interaction.fields.getTextInputValue('api_key') || '').trim();
    try {
        const { accountId } = await manager.linkUser(interaction.user.id, key);
        return interaction.editReply(
            `✅ Linked${accountId ? ` (account \`${accountId}\`)` : ''}! ` +
            'Now run `/buymeacoffee announce` in any server to choose where your new supporters are announced.'
        );
    } catch (err) {
        logger.error('[BMC] link modal failed', { err: err.message });
        return interaction.editReply(`🚫 ${err.message}`);
    }
}

export default handleBmcLinkSubmit;
