import {
    ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder,
    StringSelectMenuBuilder,
} from 'discord.js';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * 'bday:open' — the panel's "Set my birthday" button. Opens one modal holding
 * month, day and optional year.
 *
 * This replaces the panel's month dropdown. A dropdown on a persistent message
 * keeps showing the month the member picked, and Discord only fires a select
 * interaction when the value CHANGES — so anyone who closed the modal, or got a
 * "Day must be..." error, could not pick that same month again. Nothing reached
 * the bot, nothing was logged; the panel just looked dead. A button fires every
 * time.
 */
export async function handleBirthdayOpen(interaction) {
    const modal = new ModalBuilder()
        .setCustomId('bday:modal:self')
        .setTitle('Set your birthday');

    const month = new LabelBuilder()
        .setLabel('Birth month')
        .setStringSelectMenuComponent(new StringSelectMenuBuilder()
            .setCustomId('month')
            .setPlaceholder('Select your birth month')
            .setRequired(true)
            .setMinValues(1).setMaxValues(1)
            .addOptions(MONTH_NAMES.map((name, i) => ({ label: name, value: String(i + 1) }))));

    const day = new LabelBuilder()
        .setLabel('Day (1-31)')
        .setTextInputComponent(new TextInputBuilder()
            .setCustomId('day')
            .setStyle(TextInputStyle.Short)
            .setMinLength(1).setMaxLength(2).setRequired(true)
            .setPlaceholder('e.g. 15'));

    const year = new LabelBuilder()
        .setLabel('Birth year (optional)')
        .setDescription('Shows your age on your birthday')
        .setTextInputComponent(new TextInputBuilder()
            .setCustomId('year')
            .setStyle(TextInputStyle.Short)
            .setMinLength(0).setMaxLength(4).setRequired(false)
            .setPlaceholder('e.g. 1998'));

    modal.addLabelComponents(month, day, year);
    await interaction.showModal(modal);
}
