import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { displayNameFor } from '../../utils/display-name.js';
import { themeColor } from '../../core/guild-theme.js';

export async function handleSet(interaction) {
    const birthdayManager = interaction.client.birthdayManager;

    if (!birthdayManager) {
        return interaction.reply({ content: 'The birthday system is not available.', ephemeral: true });
    }

    const dateString = interaction.options.getString('date');
    const year = interaction.options.getInteger('year'); // null if omitted

    const match = dateString.match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) {
        return interaction.reply({
            content: 'Invalid date format! Please use MM-DD format (e.g., 03-15 for March 15).',
            ephemeral: true
        });
    }

    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);

    await interaction.deferReply({ ephemeral: true });

    try {
        await birthdayManager.setBirthday(interaction.user.id, interaction.guild.id, month, day, year);

        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                           'July', 'August', 'September', 'October', 'November', 'December'];

        await interaction.editReply({
            content: `Your birthday has been set to ${monthNames[month - 1]} ${day}${year ? ', ' + year : ''}!`
        });
    } catch (error) {
        await interaction.editReply({
            content: `Failed to set birthday: ${error.message}`
        });
    }
}

export async function handleRemove(interaction) {
    const birthdayManager = interaction.client.birthdayManager;

    if (!birthdayManager) {
        return interaction.reply({ content: 'The birthday system is not available.', ephemeral: true });
    }

    const target = interaction.options.getUser('user') || interaction.user;
    const isSelf = target.id === interaction.user.id;

    if (!isSelf && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
            content: 'You need Administrator permission to remove another member\'s birthday.',
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });

    const success = await birthdayManager.removeBirthday(target.id, interaction.guild.id);
    const who = isSelf ? 'Your' : `${displayNameFor(target, interaction.guild)}'s`;

    if (success) {
        await interaction.editReply({ content: `${who} birthday has been removed from the system.` });
    } else {
        await interaction.editReply({ content: `No birthday was stored for ${isSelf ? 'you' : displayNameFor(target, interaction.guild)}, so there was nothing to remove.` });
    }
}

export async function handleView(interaction) {
    const birthdayManager = interaction.client.birthdayManager;

    if (!birthdayManager) {
        return interaction.reply({ content: 'The birthday system is not available.', ephemeral: true });
    }

    const user = interaction.options.getUser('user') || interaction.user;

    await interaction.deferReply({ ephemeral: true });

    const birthday = await birthdayManager.getBirthday(user.id, interaction.guild.id);

    if (!birthday) {
        return interaction.editReply({
            content: `${displayNameFor(user, interaction.guild)} doesn't have a birthday set.`
        });
    }

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                       'July', 'August', 'September', 'October', 'November', 'December'];

    const embed = new EmbedBuilder()
        .setColor('#FF69B4')
        .setTitle(`${displayNameFor(user, interaction.guild)}'s Birthday`)
        .setDescription(`${monthNames[birthday.month - 1]} ${birthday.day}${birthday.year ? ` (${birthday.year})` : ''}`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

export async function handleList(interaction) {
    const birthdayManager = interaction.client.birthdayManager;

    if (!birthdayManager) {
        return interaction.reply({ content: 'The birthday system is not available.', ephemeral: true });
    }

    const days = interaction.options.getInteger('days') || 7;

    await interaction.deferReply();

    const upcomingBirthdays = await birthdayManager.getUpcomingBirthdays(interaction.guild.id, days);

    if (upcomingBirthdays.length === 0) {
        return interaction.editReply({ content: `No birthdays in the next ${days} days.` });
    }

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                       'July', 'August', 'September', 'October', 'November', 'December'];

    const embed = new EmbedBuilder()
        .setColor('#FF69B4')
        .setTitle(`Upcoming Birthdays (Next ${days} Days)`)
        .setFooter({ text: `${interaction.guild.name} Birthdays` })
        .setTimestamp();

    let description = '';

    for (const birthday of upcomingBirthdays) {
        try {
            const user = await interaction.client.users.fetch(birthday.userId).catch(() => null);
            const username = displayNameFor(user, interaction.guild);
            let dateStr = `${monthNames[birthday.month - 1]} ${birthday.day}`;
            // The year is optional — only shown by members who chose to give one.
            if (birthday.year) {
                dateStr += `, ${birthday.year}`;
                if (birthday.turningAge) dateStr += ` — turning ${birthday.turningAge}`;
            }
            const daysText = birthday.daysUntil === 0 ? 'Today!' :
                            birthday.daysUntil === 1 ? 'Tomorrow' :
                            `in ${birthday.daysUntil} days`;

            description += `**${username}** - ${dateStr} (${daysText})\n`;
        } catch (error) {
            // Skip if user can't be fetched
        }
    }

    embed.setDescription(description || 'No upcoming birthdays found.');

    await interaction.editReply({ embeds: [embed] });
}

export async function handleSetup(interaction) {
    const birthdayManager = interaction.client.birthdayManager;

    if (!birthdayManager) {
        return interaction.reply({ content: 'The birthday system is not available.', ephemeral: true });
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
            content: 'You need the **Manage Server** permission to use this command.',
            ephemeral: true
        });
    }

    const channel = interaction.options.getChannel('channel');
    const role = interaction.options.getRole('role');
    const message = interaction.options.getString('message');

    if (!channel.isTextBased()) {
        return interaction.reply({
            content: 'The birthday announcement channel must be a text channel.',
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });

    // Options left out keep what is saved (a role or message set on the dashboard, say).
    const success = await birthdayManager.configureBirthdays(
        interaction.guild.id,
        channel.id,
        true,
        role ? role.id : undefined,
        message ?? undefined
    );
    const saved = success ? await birthdayManager.getConfig(interaction.guild.id) : null;

    if (success) {
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setTitle('Birthday System Configured')
            .setDescription('Birthday announcements have been set up successfully!')
            .addFields(
                { name: 'Announcement Channel', value: `<#${channel.id}>`, inline: true }
            );

        const roleId = role?.id || saved?.birthday_role_id;
        if (roleId) {
            embed.addFields({ name: 'Birthday Role', value: `<@&${roleId}>`, inline: true });
        }

        const template = message || saved?.message_template;
        if (template) {
            embed.addFields({ name: 'Custom Message', value: String(template).slice(0, 1024), inline: false });
        }

        await interaction.editReply({ embeds: [embed] });
    } else {
        await interaction.editReply({
            content: 'Failed to configure birthday system. Please try again later.'
        });
    }
}

export async function handleDisable(interaction) {
    const birthdayManager = interaction.client.birthdayManager;

    if (!birthdayManager) {
        return interaction.reply({ content: 'The birthday system is not available.', ephemeral: true });
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
            content: 'You need the **Manage Server** permission to use this command.',
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });

    const success = await birthdayManager.disableBirthdays(interaction.guild.id);

    if (success) {
        await interaction.editReply({ content: 'Birthday announcements have been disabled.' });
    } else {
        await interaction.editReply({ content: 'Failed to disable birthday announcements.' });
    }
}

export async function handleSetFor(interaction) {
    const birthdayManager = interaction.client.birthdayManager;
    if (!birthdayManager) {
        return interaction.reply({ content: 'The birthday system is not available.', ephemeral: true });
    }
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'You need Administrator permission to set birthdays for others.', ephemeral: true });
    }

    const target = interaction.options.getUser('user');
    const dateString = interaction.options.getString('date');
    const year = interaction.options.getInteger('year');

    const match = dateString.match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) {
        return interaction.reply({ content: 'Invalid date format! Use MM-DD (e.g., 03-15).', ephemeral: true });
    }
    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);

    await interaction.deferReply({ ephemeral: true });
    try {
        await birthdayManager.setBirthday(target.id, interaction.guild.id, month, day, year);
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                           'July', 'August', 'September', 'October', 'November', 'December'];
        await interaction.editReply({ content: `Set ${displayNameFor(target, interaction.guild)}'s birthday to ${monthNames[month - 1]} ${day}${year ? ', ' + year : ''}.` });
    } catch (error) {
        await interaction.editReply({ content: `Failed to set birthday: ${error.message}` });
    }
}

export async function handlePanel(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'You need Administrator permission to post a birthday panel.', ephemeral: true });
    }
    const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = await import('discord.js');

    const channel = interaction.options.getChannel('channel') || interaction.channel;
    if (!channel?.isTextBased?.()) {
        return interaction.reply({ content: 'Please choose a text channel.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setColor('#FF69B4')
        .setTitle('🎂 Set Your Birthday')
        .setDescription([
            'Press **Set my birthday**, pick your month, and enter your day (and optionally your year, which shows your age on your birthday). No commands needed!',
            '',
            'Got it wrong? Just press **Set my birthday** again — the new date **replaces** the old one.',
            'Want off the list entirely? Use **Remove my birthday**.',
        ].join('\n'));

    // A button, not a month dropdown: a dropdown on a persistent message keeps the month a
    // member picked, and re-picking the same month fires no interaction — so anyone who
    // closed the modal or hit a validation error was stuck. See interactions/buttons/birthday_open.js.
    const setButton = new ButtonBuilder()
        .setCustomId('bday:open')
        .setLabel('Set my birthday')
        .setEmoji('🎂')
        .setStyle(ButtonStyle.Primary);

    const removeSelfButton = new ButtonBuilder()
        .setCustomId('bday:removeself')
        .setLabel('Remove my birthday')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger);

    const adminButton = new ButtonBuilder()
        .setCustomId('bday:adminstart')
        .setLabel('Set for a member')
        .setEmoji('🔧')
        .setStyle(ButtonStyle.Secondary);

    const adminRemoveButton = new ButtonBuilder()
        .setCustomId('bday:adminremove')
        .setLabel('Remove for a member')
        .setEmoji('🔧')
        .setStyle(ButtonStyle.Secondary);

    try {
        await channel.send({
            embeds: [embed],
            components: [
                new ActionRowBuilder().addComponents(setButton, removeSelfButton),
                new ActionRowBuilder().addComponents(adminButton, adminRemoveButton),
            ],
        });
        await interaction.reply({ content: `Birthday panel posted in ${channel}.`, ephemeral: true });
    } catch (error) {
        await interaction.reply({ content: `Failed to post panel: ${error.message}`, ephemeral: true });
    }
}
