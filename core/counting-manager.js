import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

export async function handleSetup(interaction) {
    const channel = interaction.options.getChannel('channel');
    const startNum = interaction.options.getInteger('start') || 1;

    // Check if channel already exists
    const [[existing]] = await pool.execute(
        'SELECT * FROM counting_channels WHERE guild_id = ? AND channel_id = ?',
        [interaction.guild.id, channel.id]
    );

    if (existing) {
        await interaction.reply({
            content: `❌ ${channel} is already set up as a counting channel! Current count: **${existing.current_count}**`,
            ephemeral: true
        });
        return;
    }

    // Create counting channel
    await pool.execute(
        `INSERT INTO counting_channels (guild_id, channel_id, current_count, highest_count, last_user_id, reset_count, is_active)
         VALUES (?, ?, ?, ?, NULL, 0, TRUE)`,
        [interaction.guild.id, channel.id, startNum - 1, 0]
    );

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Counting Channel Setup')
        .setDescription(`${channel} has been set up as a counting channel!`)
        .addFields(
            { name: '🔢 Starting Number', value: `${startNum}`, inline: true },
            { name: '📜 Rules', value: '• Count in order\n• No double counting\n• No skipping numbers\n• Wrong number = reset!', inline: false }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });

    // Send initial message in counting channel
    try {
        const rulesEmbed = new EmbedBuilder()
            .setColor('#3498db')
            .setTitle('🔢 Counting Game')
            .setDescription(`Welcome to the counting channel! Start counting from **${startNum}**`)
            .addFields(
                { name: '📜 Rules', value: '• Count in sequential order\n• One number per person\n• No double counting by the same user\n• Wrong number resets to 0!\n• Have fun!', inline: false }
            )
            .setFooter({ text: 'Good luck!' });

        await channel.send({ embeds: [rulesEmbed] });
    } catch (error) {
        logger.error('[Counting] Failed to send rules message:', { error: error.message });
    }
}

export async function handleDisable(interaction) {
    const channel = interaction.options.getChannel('channel');

    const [[existing]] = await pool.execute(
        'SELECT * FROM counting_channels WHERE guild_id = ? AND channel_id = ? AND is_active = TRUE',
        [interaction.guild.id, channel.id]
    );

    if (!existing) {
        await interaction.reply({
            content: `❌ ${channel} is not set up as a counting channel.`,
            ephemeral: true
        });
        return;
    }

    await pool.execute(
        'UPDATE counting_channels SET is_active = FALSE WHERE guild_id = ? AND channel_id = ?',
        [interaction.guild.id, channel.id]
    );

    await interaction.reply({
        content: `✅ Counting has been disabled in ${channel}.`,
        ephemeral: false
    });
}

export async function handleReset(interaction) {
    const channel = interaction.options.getChannel('channel') || interaction.channel;

    const [[existing]] = await pool.execute(
        'SELECT * FROM counting_channels WHERE guild_id = ? AND channel_id = ? AND is_active = TRUE',
        [interaction.guild.id, channel.id]
    );

    if (!existing) {
        await interaction.reply({
            content: `❌ ${channel} is not set up as a counting channel.`,
            ephemeral: true
        });
        return;
    }

    await pool.execute(
        `UPDATE counting_channels
         SET current_count = 0, last_user_id = NULL, reset_count = reset_count + 1
         WHERE guild_id = ? AND channel_id = ?`,
        [interaction.guild.id, channel.id]
    );

    const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle('🔄 Count Reset')
        .setDescription(`The count in ${channel} has been manually reset by ${interaction.user}!`)
        .addFields(
            { name: 'Previous Count', value: `${existing.current_count}`, inline: true },
            { name: 'New Count', value: `0`, inline: true },
            { name: 'Total Resets', value: `${existing.reset_count + 1}`, inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

export async function handleStats(interaction) {
    const channel = interaction.options.getChannel('channel') || interaction.channel;

    const [[stats]] = await pool.execute(
        'SELECT * FROM counting_channels WHERE guild_id = ? AND channel_id = ?',
        [interaction.guild.id, channel.id]
    );

    if (!stats) {
        await interaction.reply({
            content: `❌ ${channel} is not set up as a counting channel.`,
            ephemeral: true
        });
        return;
    }

    // Get top contributors
    const [contributors] = await pool.execute(
        `SELECT user_id, valid_counts, invalid_counts
         FROM counting_stats
         WHERE guild_id = ? AND channel_id = ?
         ORDER BY valid_counts DESC
         LIMIT 5`,
        [interaction.guild.id, channel.id]
    );

    const embed = new EmbedBuilder()
        .setColor('#3498db')
        .setTitle(`🔢 Counting Statistics - ${channel.name}`)
        .addFields(
            { name: '📊 Current Count', value: `${stats.current_count}`, inline: true },
            { name: '🏆 Highest Count', value: `${stats.highest_count}`, inline: true },
            { name: '🔄 Total Resets', value: `${stats.reset_count}`, inline: true },
            { name: '✅ Status', value: stats.is_active ? '🟢 Active' : '🔴 Inactive', inline: true }
        );

    if (stats.last_user_id) {
        embed.addFields({ name: '👤 Last Counter', value: `<@${stats.last_user_id}>`, inline: true });
    }

    if (contributors.length > 0) {
        let contributorsText = '';
        for (let i = 0; i < contributors.length; i++) {
            const user = await interaction.client.users.fetch(contributors[i].user_id).catch(() => null);
            const username = user ? user.username : 'Unknown User';
            const accuracy = contributors[i].valid_counts + contributors[i].invalid_counts > 0
                ? Math.round((contributors[i].valid_counts / (contributors[i].valid_counts + contributors[i].invalid_counts)) * 100)
                : 0;

            contributorsText += `${i + 1}. **${username}** - ${contributors[i].valid_counts} counts (${accuracy}% accuracy)\n`;
        }
        embed.addFields({ name: '🌟 Top Contributors', value: contributorsText, inline: false });
    }

    embed.setFooter({ text: `Channel ID: ${channel.id}` });
    embed.setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

export async function handleLeaderboard(interaction) {
    const channel = interaction.options.getChannel('channel') || interaction.channel;

    const [[channelData]] = await pool.execute(
        'SELECT * FROM counting_channels WHERE guild_id = ? AND channel_id = ?',
        [interaction.guild.id, channel.id]
    );

    if (!channelData) {
        await interaction.reply({
            content: `❌ ${channel} is not set up as a counting channel.`,
            ephemeral: true
        });
        return;
    }

    const [topCounters] = await pool.execute(
        `SELECT user_id, valid_counts, invalid_counts, longest_streak, current_streak
         FROM counting_stats
         WHERE guild_id = ? AND channel_id = ?
         ORDER BY valid_counts DESC
         LIMIT 10`,
        [interaction.guild.id, channel.id]
    );

    if (topCounters.length === 0) {
        await interaction.reply({
            content: '❌ No counting statistics available yet!',
            ephemeral: true
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`🏆 Counting Leaderboard - ${channel.name}`)
        .setDescription('Top 10 counters in this channel');

    let description = '';
    for (let i = 0; i < topCounters.length; i++) {
        const user = await interaction.client.users.fetch(topCounters[i].user_id).catch(() => null);
        const username = user ? user.username : 'Unknown User';
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const accuracy = topCounters[i].valid_counts + topCounters[i].invalid_counts > 0
            ? Math.round((topCounters[i].valid_counts / (topCounters[i].valid_counts + topCounters[i].invalid_counts)) * 100)
            : 0;

        description += `${medal} **${username}**\n`;
        description += `   📊 ${topCounters[i].valid_counts} counts | 💯 ${accuracy}% accuracy | 🔥 ${topCounters[i].longest_streak} streak\n`;
    }

    embed.setDescription(description);
    embed.setFooter({ text: `Total counters: ${topCounters.length} | Current count: ${channelData.current_count}` });

    await interaction.reply({ embeds: [embed] });
}

// Message handler for counting
export async function handleMessage(message) {
    if (message.author.bot) return false;
    if (!message.guild) return false;

    // Check if message is in a counting channel
    const [[channel]] = await pool.execute(
        'SELECT * FROM counting_channels WHERE guild_id = ? AND channel_id = ? AND is_active = TRUE',
        [message.guild.id, message.channel.id]
    );

    if (!channel) return false;

    // Check if message is a number
    const content = message.content.trim();
    const numberMatch = content.match(/^(\d+)$/);

    if (!numberMatch) {
        // Not a pure number, ignore
        return false;
    }

    const number = parseInt(numberMatch[1]);
    const expectedNumber = channel.current_count + 1;

    // Check if correct number
    if (number === expectedNumber) {
        // Check if same user as last
        if (channel.last_user_id === message.author.id) {
            await message.react('❌');
            await message.reply("❌ You can't count twice in a row!");

            // Reset count
            await pool.execute(
                'UPDATE counting_channels SET current_count = 0, last_user_id = NULL, reset_count = reset_count + 1 WHERE guild_id = ? AND channel_id = ?',
                [message.guild.id, message.channel.id]
            );

            // Update stats
            await updateCountingStats(message.guild.id, message.channel.id, message.author.id, false, 0);

            const resetEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('🔄 Count Reset!')
                .setDescription(`${message.author} counted twice in a row! Count reset to **0**.`)
                .addFields(
                    { name: 'Failed At', value: `${channel.current_count}`, inline: true },
                    { name: 'Next Number', value: '1', inline: true }
                )
                .setTimestamp();

            await message.channel.send({ embeds: [resetEmbed] });

            return true;
        }

        // Correct number!
        await message.react('✅');

        const newCount = channel.current_count + 1;
        const newHighest = Math.max(newCount, channel.highest_count);

        await pool.execute(
            'UPDATE counting_channels SET current_count = ?, highest_count = ?, last_user_id = ? WHERE guild_id = ? AND channel_id = ?',
            [newCount, newHighest, message.author.id, message.guild.id, message.channel.id]
        );

        // Update user stats
        await updateCountingStats(message.guild.id, message.channel.id, message.author.id, true, newCount);

        // Milestone messages - only for specific milestones
        if (isMilestone(newCount)) {
            const milestoneEmbed = new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle('🎉 Milestone Reached!')
                .setDescription(`Congratulations! You've reached **${newCount}**!`)
                .setTimestamp();

            await message.channel.send({ embeds: [milestoneEmbed] });

            // Award economy coins for milestone
            try {
                const [[economyConfig]] = await pool.execute(
                    'SELECT enabled FROM economy_config WHERE guild_id = ?',
                    [message.guild.id]
                );

                if (economyConfig && economyConfig.enabled) {
                    const reward = newCount; // 100 coins for 100, 200 for 200, etc.

                    await pool.execute(
                        'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
                        [reward, reward, message.guild.id, message.author.id]
                    );

                    await message.channel.send(`💰 ${message.author} earned **${reward} coins** for reaching the milestone!`);
                }
            } catch (error) {
                // Economy not set up, skip
            }
        }

        // New record - only announce if it's a milestone
        if (newCount > channel.highest_count && isMilestone(newCount)) {
            const recordEmbed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('🏆 NEW RECORD!')
                .setDescription(`A new counting record has been set: **${newCount}**!`)
                .setFooter({ text: `Previous record: ${channel.highest_count}` })
                .setTimestamp();

            await message.channel.send({ embeds: [recordEmbed] });
        }

    } else {
        // Wrong number!
        await message.react('❌');
        await message.reply(`❌ Wrong number! Expected **${expectedNumber}** but got **${number}**.`);

        // Reset count
        await pool.execute(
            'UPDATE counting_channels SET current_count = 0, last_user_id = NULL, reset_count = reset_count + 1 WHERE guild_id = ? AND channel_id = ?',
            [message.guild.id, message.channel.id]
        );

        // Update stats
        await updateCountingStats(message.guild.id, message.channel.id, message.author.id, false, channel.current_count);

        const resetEmbed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('🔄 Count Reset!')
            .setDescription(`Wrong number! Count reset to **0**.`)
            .addFields(
                { name: 'Failed At', value: `${channel.current_count}`, inline: true },
                { name: 'Expected', value: `${expectedNumber}`, inline: true },
                { name: 'Got', value: `${number}`, inline: true },
                { name: 'Next Number', value: '1', inline: true }
            )
            .setFooter({ text: `Counting will resume from 1` })
            .setTimestamp();

        await message.channel.send({ embeds: [resetEmbed] });
    }

    return true;
}

/**
 * Check if a number is a milestone worth announcing
 * Milestones: 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000, etc.
 */
function isMilestone(number) {
    if (number < 25) return false;

    // Check against milestone pattern: 25, 50, then multiples of 100, 200, 500
    const milestones = [25, 50];

    // Generate milestones: 100, 200, 500, 1000, 2000, 5000, 10000, etc.
    for (let multiplier = 1; multiplier <= 1000000; multiplier *= 10) {
        milestones.push(100 * multiplier);
        milestones.push(200 * multiplier);
        milestones.push(500 * multiplier);
    }

    return milestones.includes(number);
}

async function updateCountingStats(guildId, channelId, userId, wasValid, countReached) {
    try {
        const [[stats]] = await pool.execute(
            'SELECT * FROM counting_stats WHERE guild_id = ? AND channel_id = ? AND user_id = ?',
            [guildId, channelId, userId]
        );

        if (stats) {
            const newStreak = wasValid ? stats.current_streak + 1 : 0;
            const newLongest = Math.max(newStreak, stats.longest_streak);

            await pool.execute(
                `UPDATE counting_stats
                 SET valid_counts = valid_counts + ?,
                     invalid_counts = invalid_counts + ?,
                     current_streak = ?,
                     longest_streak = ?,
                     highest_count_reached = GREATEST(highest_count_reached, ?)
                 WHERE guild_id = ? AND channel_id = ? AND user_id = ?`,
                [wasValid ? 1 : 0, wasValid ? 0 : 1, newStreak, newLongest, countReached, guildId, channelId, userId]
            );
        } else {
            await pool.execute(
                `INSERT INTO counting_stats (guild_id, channel_id, user_id, valid_counts, invalid_counts, current_streak, longest_streak, highest_count_reached)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [guildId, channelId, userId, wasValid ? 1 : 0, wasValid ? 0 : 1, wasValid ? 1 : 0, wasValid ? 1 : 0, countReached]
            );
        }
    } catch (error) {
        logger.error('[Counting] Error updating stats:', { error: error.message });
    }
}
