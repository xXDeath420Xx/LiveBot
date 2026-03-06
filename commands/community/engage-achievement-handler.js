import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';

export async function handleList(interaction) {
    const achievementManager = interaction.client.achievementManager;

    if (!achievementManager) {
        return interaction.reply({ content: '\u274c Achievement system is not available.', ephemeral: true });
    }

    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const category = interaction.options.getString('category');
    const isOwnProfile = targetUser.id === interaction.user.id;

    const achievements = await achievementManager.getUserAchievements(
        targetUser.id,
        interaction.guild.id,
        category
    );

    if (achievements.length === 0) {
        return interaction.editReply({
            content: category
                ? `No achievements found in the ${category} category.`
                : 'No achievements available.'
        });
    }

    // Group by category
    const grouped = achievements.reduce((acc, achievement) => {
        if (!acc[achievement.category]) {
            acc[achievement.category] = [];
        }
        acc[achievement.category].push(achievement);
        return acc;
    }, {});

    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`${isOwnProfile ? 'Your' : `${targetUser.username}'s`} Achievements${category ? ` (${category})` : ''}`)
        .setAuthor({
            name: targetUser.username,
            iconURL: targetUser.displayAvatarURL()
        })
        .setTimestamp();

    const completed = achievements.filter(a => a.completed).length;
    const totalPoints = achievements
        .filter(a => a.completed)
        .reduce((sum, a) => sum + a.points, 0);

    embed.setDescription(
        `**Progress:** ${completed}/${achievements.length} completed\n` +
        `**Total Points:** ${totalPoints.toLocaleString()} pts`
    );

    const categoryEmoji = {
        social: '\ud83d\udc65',
        economy: '\ud83d\udcb0',
        rpg: '\u2694\ufe0f',
        music: '\ud83c\udfb5',
        fun: '\ud83c\udfae',
        gaming: '\ud83d\udd79\ufe0f',
        special: '\u2b50'
    };

    for (const [cat, achs] of Object.entries(grouped)) {
        const achievementList = achs.slice(0, 5).map(a => {
            const status = a.completed ? '\u2705' : '\u274c';
            const progress = a.progress || 0;
            const required = a.requirement_value || 0;
            const progressBar = a.completed
                ? '\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588'
                : '\u2591'.repeat(9).substring(0, Math.floor((progress / required) * 9)) + '\u2591'.repeat(9 - Math.floor((progress / required) * 9));

            return `${status} ${a.icon_emoji || ''} **${a.name}** (${a.points} pts)\n` +
                   `\u2514 ${a.description}` +
                   (a.completed ? '' : `\n\u2514 Progress: ${progress}/${required} ${progressBar}`);
        }).join('\n\n');

        const categoryName = `${categoryEmoji[cat] || ''} ${cat.charAt(0).toUpperCase() + cat.slice(1)} (${achs.filter(a => a.completed).length}/${achs.length})`;

        if (achievementList) {
            embed.addFields({
                name: categoryName,
                value: achievementList.length > 1024 ? achievementList.substring(0, 1021) + '...' : achievementList,
                inline: false
            });
        }
    }

    return interaction.editReply({ embeds: [embed] });
}

export async function handleProgress(interaction) {
    const achievementManager = interaction.client.achievementManager;

    if (!achievementManager) {
        return interaction.reply({ content: '\u274c Achievement system is not available.', ephemeral: true });
    }

    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const isOwnProfile = targetUser.id === interaction.user.id;

    const achievements = await achievementManager.getUserAchievements(
        targetUser.id,
        interaction.guild.id
    );

    const inProgress = achievements.filter(a =>
        !a.completed && a.progress > 0 && a.requirement_value
    ).sort((a, b) => {
        const aPercent = (a.progress / a.requirement_value) * 100;
        const bPercent = (b.progress / b.requirement_value) * 100;
        return bPercent - aPercent;
    }).slice(0, 10);

    if (inProgress.length === 0) {
        return interaction.editReply({
            content: `${isOwnProfile ? 'You have' : `${targetUser.username} has`} no achievements in progress.`
        });
    }

    const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle(`${isOwnProfile ? 'Your' : `${targetUser.username}'s`} Achievement Progress`)
        .setAuthor({
            name: targetUser.username,
            iconURL: targetUser.displayAvatarURL()
        })
        .setTimestamp();

    const progressList = inProgress.map(a => {
        const progress = a.progress || 0;
        const required = a.requirement_value;
        const percent = Math.floor((progress / required) * 100);
        const barLength = 10;
        const filled = Math.floor((progress / required) * barLength);
        const progressBar = '\u2588'.repeat(filled) + '\u2591'.repeat(barLength - filled);

        return `${a.icon_emoji || '\ud83c\udfc6'} **${a.name}** (${a.tier})\n` +
               `${a.description}\n` +
               `${progressBar} ${percent}% (${progress.toLocaleString()}/${required.toLocaleString()})`;
    }).join('\n\n');

    embed.setDescription(progressList);

    return interaction.editReply({ embeds: [embed] });
}

export async function handleLeaderboard(interaction) {
    const achievementManager = interaction.client.achievementManager;

    if (!achievementManager) {
        return interaction.reply({ content: '\u274c Achievement system is not available.', ephemeral: true });
    }

    await interaction.deferReply();

    const leaderboard = await achievementManager.getAchievementLeaderboard(interaction.guild.id, 10);

    if (leaderboard.length === 0) {
        return interaction.editReply({ content: 'No achievement data available yet!' });
    }

    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('\ud83c\udfc6 Achievement Leaderboard')
        .setDescription('Top achievement earners in this server')
        .setTimestamp();

    const leaderboardText = await Promise.all(
        leaderboard.map(async (entry, index) => {
            const user = await interaction.client.users.fetch(entry.user_id).catch(() => null);
            const username = user ? user.username : 'Unknown User';
            const medal = index === 0 ? '\ud83e\udd47' : index === 1 ? '\ud83e\udd48' : index === 2 ? '\ud83e\udd49' : `**${index + 1}.**`;

            return `${medal} **${username}**\n` +
                   `\u2514 ${entry.achievement_count} achievements | ${entry.total_points.toLocaleString()} points`;
        })
    );

    embed.setDescription(leaderboardText.join('\n\n'));

    return interaction.editReply({ embeds: [embed] });
}

export async function handleRecent(interaction) {
    const achievementManager = interaction.client.achievementManager;

    if (!achievementManager) {
        return interaction.reply({ content: '\u274c Achievement system is not available.', ephemeral: true });
    }

    await interaction.deferReply();

    const recent = await achievementManager.getRecentCompletions(interaction.guild.id, 10);

    if (recent.length === 0) {
        return interaction.editReply({ content: 'No achievements have been completed yet!' });
    }

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('\ud83c\udf89 Recently Completed Achievements')
        .setDescription('Latest achievement completions in this server')
        .setTimestamp();

    const recentText = await Promise.all(
        recent.map(async (entry) => {
            const user = await interaction.client.users.fetch(entry.user_id).catch(() => null);
            const username = user ? user.username : 'Unknown User';
            const timeAgo = Math.floor((Date.now() - new Date(entry.completed_at)) / 1000 / 60);
            const timeText = timeAgo < 60
                ? `${timeAgo}m ago`
                : timeAgo < 1440
                    ? `${Math.floor(timeAgo / 60)}h ago`
                    : `${Math.floor(timeAgo / 1440)}d ago`;

            return `${entry.icon_emoji || '\ud83c\udfc6'} **${entry.name}** (${entry.tier})\n` +
                   `\u2514 Completed by **${username}** ${timeText}`;
        })
    );

    embed.setDescription(recentText.join('\n\n'));

    return interaction.editReply({ embeds: [embed] });
}

export async function handleStats(interaction) {
    const achievementManager = interaction.client.achievementManager;

    if (!achievementManager) {
        return interaction.reply({ content: '\u274c Achievement system is not available.', ephemeral: true });
    }

    await interaction.deferReply();

    const stats = await achievementManager.getGuildAchievementStats(interaction.guild.id);

    if (!stats) {
        return interaction.editReply({ content: 'No achievement statistics available.' });
    }

    const embed = new EmbedBuilder()
        .setColor('#9B59B6')
        .setTitle('\ud83d\udcca Server Achievement Statistics')
        .addFields(
            { name: '\ud83d\udc65 Active Users', value: stats.active_users.toString(), inline: true },
            { name: '\ud83c\udfc6 Total Completions', value: stats.total_completions.toString(), inline: true },
            { name: '\u2b50 Unique Achievements', value: stats.unique_achievements_earned.toString(), inline: true }
        )
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

export async function handleInfo(interaction) {
    const achievementManager = interaction.client.achievementManager;

    if (!achievementManager) {
        return interaction.reply({ content: '\u274c Achievement system is not available.', ephemeral: true });
    }

    await interaction.deferReply();

    const searchName = interaction.options.getString('name').toLowerCase();

    const [achievements] = await pool.execute(
        'SELECT * FROM achievements WHERE LOWER(name) LIKE ? OR LOWER(achievement_key) LIKE ?',
        [`%${searchName}%`, `%${searchName}%`]
    );

    if (achievements.length === 0) {
        return interaction.editReply({
            content: `\u274c No achievement found matching "${searchName}".`
        });
    }

    const achievement = achievements[0];

    const [userProgress] = await pool.execute(
        `SELECT * FROM user_achievements
         WHERE user_id = ? AND guild_id = ? AND achievement_id = ?`,
        [interaction.user.id, interaction.guild.id, achievement.id]
    );

    const progress = userProgress.length > 0 ? userProgress[0] : null;

    const [globalStats] = await pool.execute(
        `SELECT * FROM achievement_stats
         WHERE guild_id = ? AND achievement_id = ?`,
        [interaction.guild.id, achievement.id]
    );

    const stats = globalStats.length > 0 ? globalStats[0] : null;

    const tierColors = {
        bronze: '#CD7F32',
        silver: '#C0C0C0',
        gold: '#FFD700',
        platinum: '#E5E4E2',
        diamond: '#B9F2FF'
    };

    const embed = new EmbedBuilder()
        .setColor(tierColors[achievement.tier] || '#FFD700')
        .setTitle(`${achievement.icon_emoji || '\ud83c\udfc6'} ${achievement.name}`)
        .setDescription(achievement.description)
        .addFields(
            { name: 'Category', value: achievement.category.charAt(0).toUpperCase() + achievement.category.slice(1), inline: true },
            { name: 'Tier', value: achievement.tier.charAt(0).toUpperCase() + achievement.tier.slice(1), inline: true },
            { name: 'Points', value: `${achievement.points} pts`, inline: true }
        );

    if (progress) {
        const progressPercent = achievement.requirement_value
            ? Math.floor((progress.progress / achievement.requirement_value) * 100)
            : 0;

        embed.addFields({
            name: 'Your Progress',
            value: progress.completed
                ? `\u2705 Completed ${progress.times_completed} time${progress.times_completed > 1 ? 's' : ''}`
                : `${progress.progress}/${achievement.requirement_value} (${progressPercent}%)`,
            inline: false
        });
    } else {
        embed.addFields({
            name: 'Your Progress',
            value: '\u274c Not started',
            inline: false
        });
    }

    if (stats) {
        const firstUser = await interaction.client.users.fetch(stats.first_completed_by).catch(() => null);
        embed.addFields({
            name: 'Server Statistics',
            value: `**Total Completions:** ${stats.total_completions}\n` +
                   `**First Completed By:** ${firstUser ? firstUser.username : 'Unknown'}`,
            inline: false
        });
    }

    return interaction.editReply({ embeds: [embed] });
}

export async function handleSetup(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
            content: '\u274c You need the **Manage Server** permission to configure the achievement system.',
            ephemeral: true
        });
    }

    const enabled = interaction.options.getBoolean('enabled');
    const announcementChannel = interaction.options.getChannel('announcement_channel');

    // If no options provided, show current config
    if (enabled === null && !announcementChannel) {
        const [rows] = await pool.execute(
            'SELECT * FROM achievement_config WHERE guild_id = ?',
            [interaction.guild.id]
        );

        const config = rows.length > 0 ? rows[0] : null;

        const embed = new EmbedBuilder()
            .setColor(config && config.enabled ? '#00FF00' : '#FF0000')
            .setTitle('\ud83c\udfc6 Achievement System Configuration')
            .setDescription(
                config && config.enabled
                    ? '\u2705 **Status:** Enabled - Users can earn achievements and receive notifications'
                    : '\u274c **Status:** Disabled - No achievement notifications will be sent'
            )
            .addFields(
                {
                    name: '\ud83d\udce2 Announcement Channel',
                    value: config && config.announcement_channel_id
                        ? `<#${config.announcement_channel_id}>`
                        : 'Not set (will use first available text channel)',
                    inline: true
                }
            )
            .setFooter({ text: 'Use /engage achievement setup to modify these settings' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    const [currentRows] = await pool.execute(
        'SELECT * FROM achievement_config WHERE guild_id = ?',
        [interaction.guild.id]
    );

    const currentConfig = currentRows.length > 0 ? currentRows[0] : { enabled: false, announcement_channel_id: null };

    const newEnabled = enabled !== null ? enabled : currentConfig.enabled;
    const newChannel = announcementChannel ? announcementChannel.id : (currentConfig.announcement_channel_id || null);

    if (currentRows.length > 0) {
        await pool.execute(
            `UPDATE achievement_config
             SET enabled = ?, announcement_channel_id = ?, updated_at = NOW()
             WHERE guild_id = ?`,
            [newEnabled, newChannel, interaction.guild.id]
        );
    } else {
        await pool.execute(
            `INSERT INTO achievement_config (guild_id, enabled, announcement_channel_id)
             VALUES (?, ?, ?)`,
            [interaction.guild.id, newEnabled, newChannel]
        );
    }

    const embed = new EmbedBuilder()
        .setColor(enabled === false ? '#FF0000' : '#00FF00')
        .setTitle(enabled === false ? '\u274c Achievement System Disabled' : '\u2705 Configuration Updated')
        .setDescription(
            enabled === false
                ? 'Achievement notifications have been disabled. Users can still view achievements, but won\'t receive notifications when completing them.'
                : enabled === true
                ? 'Achievement notifications have been enabled! Users will now be notified when they complete achievements.'
                : 'Achievement system configuration has been updated successfully.'
        )
        .setTimestamp();

    if (announcementChannel) {
        embed.addFields({
            name: '\ud83d\udce2 Announcement Channel',
            value: `Set to ${announcementChannel}`,
            inline: false
        });
    }

    return interaction.reply({ embeds: [embed], ephemeral: true });
}
