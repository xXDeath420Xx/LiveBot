import { PermissionFlagsBits } from 'discord.js';
import { validateBirthday, parseIntStrict } from '../../core/birthday-helpers.js';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Handles 'bday:modal:self:<month>' and 'bday:modal:admin:<userId>:<month>'.
 * Parses Day + optional Year, validates, and writes via the birthday manager.
 */
export async function handleBirthdaySetModal(interaction) {
    const birthdayManager = interaction.client.birthdayManager;
    if (!birthdayManager) {
        return interaction.reply({ content: 'The birthday system is not available.', ephemeral: true });
    }

    const parts = interaction.customId.split(':'); // ['bday','modal',scope,...]
    const scope = parts[2];
    let targetUserId, month;
    if (scope === 'admin') {
        targetUserId = parts[3];
        month = parseInt(parts[4], 10);
        if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Administrators only.', ephemeral: true });
        }
    } else {
        targetUserId = interaction.user.id;
        month = parseInt(parts[3], 10);
    }

    const day = parseIntStrict(interaction.fields.getTextInputValue('day'));
    const yearRaw = interaction.fields.getTextInputValue('year');
    const year = yearRaw && yearRaw.trim() ? parseIntStrict(yearRaw) : null;

    if (day === null) {
        return interaction.reply({ content: 'Day must be a number (e.g. 15).', ephemeral: true });
    }
    if (yearRaw && yearRaw.trim() && year === null) {
        return interaction.reply({ content: 'Year must be a 4-digit number (e.g. 1998), or leave it blank.', ephemeral: true });
    }
    const check = validateBirthday(month, day, year);
    if (!check.ok) {
        return interaction.reply({ content: check.error, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    try {
        await birthdayManager.setBirthday(targetUserId, interaction.guild.id, month, day, year);
        const who = scope === 'admin' ? `<@${targetUserId}>'s` : 'Your';
        await interaction.editReply({ content: `${who} birthday is set to ${MONTH_NAMES[month - 1]} ${day}${year ? ', ' + year : ''}! 🎂` });
    } catch (error) {
        await interaction.editReply({ content: `Failed to set birthday: ${error.message}` });
    }
}
