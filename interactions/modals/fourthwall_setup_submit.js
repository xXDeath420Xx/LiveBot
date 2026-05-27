import logger from '../../utils/logger.js';

export async function handleFourthwallSetupSubmit(interaction) {
    if (!interaction.memberPermissions?.has('ManageGuild')) {
        return interaction.reply({ content: 'Requires Manage Server permission', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const handle = interaction.fields.getTextInputValue('handle').trim();
    const apiUser = interaction.fields.getTextInputValue('api_user').trim();
    const apiPass = interaction.fields.getTextInputValue('api_pass').trim();
    const storefrontToken = (interaction.fields.getTextInputValue('storefront_token') || '').trim() || null;

    if (!/^[a-z0-9-]{1,100}$/i.test(handle)) {
        return interaction.editReply('Shop handle must be alphanumeric/dashes only.');
    }

    try {
        const mgr = interaction.client.fourthwallManager;
        if (!mgr) throw new Error('Fourthwall manager not initialized');
        const result = await mgr.connectShop({
            guildId: interaction.guildId,
            shopHandle: handle,
            apiUser, apiPass, storefrontToken,
            connectedBy: interaction.user.id
        });
        await interaction.editReply(
            `✓ Connected **${result.shopName || handle}** (registered ${result.registeredEvents} webhook subscriptions).\n` +
            `Configure routing with \`/fourthwall route\` or via the dashboard.`
        );
    } catch (err) {
        logger.error('[FW Setup Modal] failed', { err: err.message });
        await interaction.editReply(`Connection failed: ${err.message}`);
    }
}
