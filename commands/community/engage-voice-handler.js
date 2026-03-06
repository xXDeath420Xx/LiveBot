import { EmbedBuilder } from 'discord.js';

export async function handleStats(interaction) {
    const voiceActivityManager = interaction.client.voiceActivityManager;

    if (!voiceActivityManager) {
        return interaction.reply({
            content: 'Voice activity tracking is not available.',
            ephemeral: true
        });
    }

    const user = interaction.options.getUser('user') || interaction.user;
    const period = interaction.options.getString('period') || 'all';

    await interaction.deferReply();

    const stats = await voiceActivityManager.getVoiceActivityStats(
        interaction.guild.id,
        user.id,
        period
    );

    const periodText = period === 'all' ? 'All Time' :
                      period === 'daily' ? 'Daily' :
                      period === 'weekly' ? 'Weekly' : 'Monthly';

    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`${user.username}'s Voice Stats (${periodText})`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
            { name: 'Total Time', value: voiceActivityManager.formatDuration(stats.total_time), inline: true },
            { name: 'Sessions', value: `${stats.session_count}`, inline: true },
            {
                name: 'Average Session',
                value: stats.session_count > 0
                    ? voiceActivityManager.formatDuration(Math.floor(stats.total_time / stats.session_count))
                    : '0m',
                inline: true
            }
        )
        .setFooter({ text: `${interaction.guild.name} Voice Activity` })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

export async function handleLeaderboard(interaction) {
    const voiceActivityManager = interaction.client.voiceActivityManager;

    if (!voiceActivityManager) {
        return interaction.reply({
            content: 'Voice activity tracking is not available.',
            ephemeral: true
        });
    }

    const period = interaction.options.getString('period') || 'all';

    await interaction.deferReply();

    const topUsers = await voiceActivityManager.getTopVoiceUsers(
        interaction.guild.id,
        10,
        period
    );

    if (topUsers.length === 0) {
        return interaction.editReply({
            content: 'No voice activity data available for this period.',
            ephemeral: true
        });
    }

    const periodText = period === 'all' ? 'All Time' :
                      period === 'daily' ? 'Daily' :
                      period === 'weekly' ? 'Weekly' : 'Monthly';

    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`Voice Activity Leaderboard (${periodText})`)
        .setFooter({ text: `${interaction.guild.name} Voice Activity` })
        .setTimestamp();

    let description = '';

    for (let i = 0; i < topUsers.length; i++) {
        const userData = topUsers[i];
        const rank = i + 1;
        const medal = rank === 1 ? ':first_place:' : rank === 2 ? ':second_place:' : rank === 3 ? ':third_place:' : `${rank}.`;

        try {
            const user = await interaction.client.users.fetch(userData.user_id).catch(() => null);
            const username = user ? user.username : `Unknown User`;
            const timeFormatted = voiceActivityManager.formatDuration(userData.total_time);

            description += `${medal} **${username}** - ${timeFormatted} (${userData.sessions} sessions)\n`;
        } catch (error) {
            description += `${medal} Unknown User - ${voiceActivityManager.formatDuration(userData.total_time)}\n`;
        }
    }

    embed.setDescription(description);

    await interaction.editReply({ embeds: [embed] });
}

export async function handleChannels(interaction) {
    const voiceActivityManager = interaction.client.voiceActivityManager;

    if (!voiceActivityManager) {
        return interaction.reply({
            content: 'Voice activity tracking is not available.',
            ephemeral: true
        });
    }

    const period = interaction.options.getString('period') || 'all';

    await interaction.deferReply();

    const topChannels = await voiceActivityManager.getTopVoiceChannels(
        interaction.guild.id,
        10,
        period
    );

    if (topChannels.length === 0) {
        return interaction.editReply({
            content: 'No voice channel activity data available for this period.',
            ephemeral: true
        });
    }

    const periodText = period === 'all' ? 'All Time' :
                      period === 'daily' ? 'Daily' :
                      period === 'weekly' ? 'Weekly' : 'Monthly';

    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`Most Active Voice Channels (${periodText})`)
        .setFooter({ text: `${interaction.guild.name} Voice Activity` })
        .setTimestamp();

    let description = '';

    for (let i = 0; i < topChannels.length; i++) {
        const channelData = topChannels[i];
        const rank = i + 1;

        try {
            const channel = await interaction.guild.channels.fetch(channelData.channel_id).catch(() => null);
            const channelName = channel ? channel.name : `Unknown Channel`;
            const timeFormatted = voiceActivityManager.formatDuration(channelData.total_time);

            description += `**${rank}.** ${channel ? `<#${channel.id}>` : channelName} - ${timeFormatted} (${channelData.session_count} sessions)\n`;
        } catch (error) {
            description += `**${rank}.** Unknown Channel - ${voiceActivityManager.formatDuration(channelData.total_time)}\n`;
        }
    }

    embed.setDescription(description);

    await interaction.editReply({ embeds: [embed] });
}
