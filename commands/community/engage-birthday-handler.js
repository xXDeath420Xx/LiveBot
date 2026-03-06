import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';

export async function handleSet(interaction) {
    const birthdayManager = interaction.client.birthdayManager;

    if (!birthdayManager) {
        return interaction.reply({ content: 'The birthday system is not available.', ephemeral: true });
    }

    const dateString = interaction.options.getString('date');

    const match = dateString.match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) {
        return interaction.reply({
            content: 'Invalid date format! Please use MM-DD format (e.g., 03-15 for March 15).',
            ephemeral: true
        });
    }

    const month = parseInt(match[1]);
    const day = parseInt(match[2]);

    if (month < 1 || month > 12 || day < 1 || day > 31) {
        return interaction.reply({
            content: 'Invalid date! Month must be 1-12 and day must be 1-31.',
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        await birthdayManager.setBirthday(interaction.user.id, interaction.guild.id, month, day);

        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                           'July', 'August', 'September', 'October', 'November', 'December'];

        await interaction.editReply({
            content: `Your birthday has been set to ${monthNames[month - 1]} ${day}!`
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

    await interaction.deferReply({ ephemeral: true });

    const success = await birthdayManager.removeBirthday(interaction.user.id, interaction.guild.id);

    if (success) {
        await interaction.editReply({ content: 'Your birthday has been removed from the system.' });
    } else {
        await interaction.editReply({ content: 'Failed to remove your birthday. You may not have one set.' });
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
            content: `${user.username} doesn't have a birthday set.`
        });
    }

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                       'July', 'August', 'September', 'October', 'November', 'December'];

    const embed = new EmbedBuilder()
        .setColor('#FF69B4')
        .setTitle(`${user.username}'s Birthday`)
        .setDescription(`${monthNames[birthday.month - 1]} ${birthday.day}`)
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
            const username = user ? user.username : 'Unknown User';
            const dateStr = `${monthNames[birthday.month - 1]} ${birthday.day}`;
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

    const success = await birthdayManager.configureBirthdays(
        interaction.guild.id,
        channel.id,
        true,
        role ? role.id : null,
        message
    );

    if (success) {
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('Birthday System Configured')
            .setDescription('Birthday announcements have been set up successfully!')
            .addFields(
                { name: 'Announcement Channel', value: `<#${channel.id}>`, inline: true }
            );

        if (role) {
            embed.addFields({ name: 'Birthday Role', value: `${role}`, inline: true });
        }

        if (message) {
            embed.addFields({ name: 'Custom Message', value: message, inline: false });
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
