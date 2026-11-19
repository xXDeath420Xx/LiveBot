import { PermissionFlagsBits } from 'discord.js';

/**
 * 'bday:adminremoveuser' — admin picked a member to remove. Re-check admin (the
 * ephemeral picker outlives the click, so never trust the earlier check alone),
 * then delete the stored birthday.
 */
export async function handleBirthdayAdminRemoveUserSelect(interaction) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Administrators only.', ephemeral: true });
    }
    const birthdayManager = interaction.client.birthdayManager;
    if (!birthdayManager) {
        return interaction.reply({ content: 'The birthday system is not available.', ephemeral: true });
    }

    const targetUserId = interaction.values[0];
    await interaction.deferUpdate();

    const removed = await birthdayManager.removeBirthday(targetUserId, interaction.guild.id);
    await interaction.editReply({
        content: removed
            ? `Removed <@${targetUserId}>'s birthday from the system.`
            : `<@${targetUserId}> doesn't have a birthday stored, so there was nothing to remove.`,
        components: [],
    });
}
