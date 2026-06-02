import { PermissionFlagsBits, UserSelectMenuBuilder, ActionRowBuilder } from 'discord.js';

/**
 * 'bday:adminstart' — admin-only entry point. Verifies Administrator, then shows
 * an ephemeral member picker (UserSelectMenu, customId 'bday:adminuser').
 */
export async function handleBirthdayAdminStart(interaction) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Only administrators can set birthdays for other members.', ephemeral: true });
    }
    const picker = new UserSelectMenuBuilder()
        .setCustomId('bday:adminuser')
        .setPlaceholder('Pick the member whose birthday to set')
        .setMinValues(1).setMaxValues(1);

    await interaction.reply({
        content: 'Select the member, then choose their birth month:',
        components: [new ActionRowBuilder().addComponents(picker)],
        ephemeral: true,
    });
}
