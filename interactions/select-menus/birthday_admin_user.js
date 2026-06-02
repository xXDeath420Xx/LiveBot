import { PermissionFlagsBits, StringSelectMenuBuilder, ActionRowBuilder } from 'discord.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * 'bday:adminuser' — admin picked a member. Re-check admin, then present a month
 * dropdown whose customId carries the chosen target user id.
 */
export async function handleBirthdayAdminUserSelect(interaction) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Administrators only.', ephemeral: true });
    }
    const targetUserId = interaction.values[0];
    const monthSelect = new StringSelectMenuBuilder()
        .setCustomId(`bday:adminmonth:${targetUserId}`)
        .setPlaceholder('Choose the birth month')
        .addOptions(MONTHS.map((name, i) => ({ label: name, value: String(i + 1) })));

    await interaction.update({
        content: `Setting birthday for <@${targetUserId}> — choose the month:`,
        components: [new ActionRowBuilder().addComponents(monthSelect)],
    });
}
