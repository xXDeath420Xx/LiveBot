import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Handles both the self month dropdown (customId 'bday:month') and the admin
 * month dropdown ('bday:adminmonth:<userId>'). Opens a modal asking for Day +
 * optional Year; the modal's customId carries the scope, target, and month.
 */
export async function handleBirthdayMonthSelect(interaction) {
    const month = parseInt(interaction.values[0], 10); // 1-12
    const id = interaction.customId;
    let modalCustomId;
    if (id.startsWith('bday:adminmonth:')) {
        const targetUserId = id.slice('bday:adminmonth:'.length);
        modalCustomId = `bday:modal:admin:${targetUserId}:${month}`;
    } else {
        modalCustomId = `bday:modal:self:${month}`;
    }

    const modal = new ModalBuilder()
        .setCustomId(modalCustomId)
        .setTitle(`Birthday — ${MONTH_NAMES[month - 1]}`);

    const dayInput = new TextInputBuilder()
        .setCustomId('day')
        .setLabel('Day (1-31)')
        .setStyle(TextInputStyle.Short)
        .setMinLength(1).setMaxLength(2).setRequired(true)
        .setPlaceholder('e.g. 15');

    const yearInput = new TextInputBuilder()
        .setCustomId('year')
        .setLabel('Birth year (optional — shows age)')
        .setStyle(TextInputStyle.Short)
        .setMinLength(0).setMaxLength(4).setRequired(false)
        .setPlaceholder('e.g. 1998');

    modal.addComponents(
        new ActionRowBuilder().addComponents(dayInput),
        new ActionRowBuilder().addComponents(yearInput)
    );
    await interaction.showModal(modal);
}
