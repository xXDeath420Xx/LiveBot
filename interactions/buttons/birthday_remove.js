import { PermissionFlagsBits, UserSelectMenuBuilder, ActionRowBuilder } from 'discord.js';

/**
 * 'bday:removeself' — any member clearing their own birthday from the panel.
 */
export async function handleBirthdayRemoveSelf(interaction) {
    const birthdayManager = interaction.client.birthdayManager;
    if (!birthdayManager) {
        return interaction.reply({ content: 'The birthday system is not available.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const removed = await birthdayManager.removeBirthday(interaction.user.id, interaction.guild.id);
    await interaction.editReply({
        content: removed
            ? 'Your birthday has been removed from the system.'
            : 'You don\'t have a birthday stored, so there was nothing to remove.',
    });
}

/**
 * 'bday:adminremove' — admin-only entry point. Verifies Administrator, then shows
 * an ephemeral member picker (UserSelectMenu, customId 'bday:adminremoveuser').
 */
export async function handleBirthdayAdminRemoveStart(interaction) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Only administrators can remove another member\'s birthday.', ephemeral: true });
    }
    const picker = new UserSelectMenuBuilder()
        .setCustomId('bday:adminremoveuser')
        .setPlaceholder('Pick the member whose birthday to remove')
        .setMinValues(1).setMaxValues(1);

    await interaction.reply({
        content: 'Select the member whose birthday should be removed:',
        components: [new ActionRowBuilder().addComponents(picker)],
        ephemeral: true,
    });
}
