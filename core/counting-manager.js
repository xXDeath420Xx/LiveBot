import { EmbedBuilder, MessageFlags } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

export async function handleSetup(interaction) {
    const channel = interaction.options.getChannel('channel');
    const startNum = interaction.options.getInteger('start') || 1;

    // A disabled row must not block re-setup — it's the normal way a channel is retired.
    const [[existing]] = await pool.execute(
        'SELECT * FROM counting_channels WHERE guild_id = ? AND channel_id = ?',
        [interaction.guild.id, channel.id]
    );

    if (existing && existing.is_active) {
        await interaction.reply({
            content: `❌ ${channel} is already set up as a counting channel! Current count: **${existing.current_count}**\n` +
                'Use `/arcade counting setcount` to change the number, or `disable` first.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // `current_count` holds the LAST number posted, so the next expected is start.
    if (existing) {
        await pool.execute(
            `UPDATE counting_channels
                SET current_count = ?, highest_count = GREATEST(highest_count, ?),
                    last_user_id = NULL, is_active = TRUE
              WHERE guild_id = ? AND channel_id = ?`,
            [startNum - 1, startNum - 1, interaction.guild.id, channel.id]
        );
    } else {
        await pool.execute(
            `INSERT INTO counting_channels (guild_id, channel_id, current_count, highest_count, last_user_id, reset_count, is_active)
             VALUES (?, ?, ?, ?, NULL, 0, TRUE)`,
            [interaction.guild.id, channel.id, startNum - 1, startNum - 1]
        );
    }

    const cfg = await getChannelConfig(interaction.guild.id, channel.id);
    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Counting Channel Setup')
        .setDescription(`${channel} has been set up as a counting channel!`)
        .addFields(
            { name: '🔢 Next Number', value: `${startNum}`, inline: true },
            { name: '⚙️ Mode', value: describeMode(cfg), inline: false }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

/** Human-readable summary of a channel's ruleset. */
export function describeMode(cfg) {
    const lines = [
        cfg.fail_mode === 'delete'
            ? '• Wrong number → **deleted**, count never resets'
            : '• Wrong number → **count resets to 0**',
        cfg.allow_same_user ? '• Same person may count twice in a row' : '• No counting twice in a row',
    ];
    if (cfg.fail_mode === 'delete' && cfg.delete_chatter) lines.push('• Non-numeric chatter is deleted');
    if (cfg.react_on_valid) lines.push('• Reacts ✅ on a valid count');
    if (cfg.announce_milestones) lines.push('• Announces milestones');
    return lines.join('\n');
}

/** Read a channel's row with its behaviour flags. Returns null when not configured. */
export async function getChannelConfig(guildId, channelId) {
    const [[row]] = await pool.execute(
        'SELECT * FROM counting_channels WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);
    return row || null;
}

/** Change the ruleset. `fields` keys are validated against a fixed allow-list. */
export async function setMode(guildId, channelId, fields) {
    const ALLOWED = new Set(['fail_mode', 'allow_same_user', 'react_on_valid', 'announce_milestones', 'delete_chatter']);
    const keys = Object.keys(fields).filter(k => ALLOWED.has(k));
    if (!keys.length) return false;
    const sql = keys.map(k => `${k} = ?`).join(', ');
    const [r] = await pool.execute(
        `UPDATE counting_channels SET ${sql} WHERE guild_id = ? AND channel_id = ?`,
        [...keys.map(k => fields[k]), guildId, channelId]);
    return r.affectedRows > 0;
}

/**
 * Seed the count without resetting stats — used when taking a channel over from another
 * bot at the exact number it left off on.
 */
export async function setCount(guildId, channelId, lastNumber, lastUserId = null) {
    const [r] = await pool.execute(
        `UPDATE counting_channels
            SET current_count = ?, highest_count = GREATEST(highest_count, ?), last_user_id = ?
          WHERE guild_id = ? AND channel_id = ?`,
        [lastNumber, lastNumber, lastUserId, guildId, channelId]);
    return r.affectedRows > 0;
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

    const [[channel]] = await pool.execute(
        'SELECT * FROM counting_channels WHERE guild_id = ? AND channel_id = ? AND is_active = TRUE',
        [message.guild.id, message.channel.id]
    );
    if (!channel) return false;

    const deleteMode = channel.fail_mode === 'delete';
    const content = message.content.trim();
    const numberMatch = content.match(/^(\d+)$/);

    if (!numberMatch) {
        // Chatter. Legacy mode ignores it; delete mode may sweep it if configured.
        if (deleteMode && channel.delete_chatter) {
            await message.delete().catch(() => {});
            return true;
        }
        return false;
    }

    const number = parseInt(numberMatch[1], 10);
    const expectedNumber = Number(channel.current_count) + 1;
    const sameUser = !channel.allow_same_user && channel.last_user_id === message.author.id;
    const wrong = number !== expectedNumber;

    if (wrong || sameUser) {
        return handleBadCount(message, channel, { number, expectedNumber, sameUser, deleteMode });
    }

    // Correct. Guard the advance on the count we read: two people posting `expected` at the
    // same moment must not both succeed, or the count would advance once for two ✅.
    const [adv] = await pool.execute(
        `UPDATE counting_channels
            SET current_count = ?, highest_count = GREATEST(highest_count, ?), last_user_id = ?
          WHERE guild_id = ? AND channel_id = ? AND current_count = ?
            AND (last_user_id IS NULL OR last_user_id <> ? OR ? = 1)`,
        [number, number, message.author.id, message.guild.id, message.channel.id,
         channel.current_count, message.author.id, channel.allow_same_user ? 1 : 0]
    );
    if (adv.affectedRows !== 1) {
        // Someone beat us to this number by microseconds — treat it as a bad count.
        const [[fresh]] = await pool.execute(
            'SELECT * FROM counting_channels WHERE guild_id = ? AND channel_id = ?',
            [message.guild.id, message.channel.id]);
        return handleBadCount(message, fresh || channel, {
            number, expectedNumber: Number(fresh?.current_count ?? channel.current_count) + 1,
            sameUser: false, deleteMode,
        });
    }

    if (channel.react_on_valid) await message.react('✅').catch(() => {});
    await updateCountingStats(message.guild.id, message.channel.id, message.author.id, true, number);

    if (channel.announce_milestones && isMilestone(number)) {
        const milestoneEmbed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('🎉 Milestone Reached!')
            .setDescription(`Congratulations! You've reached **${number}**!`)
            .setTimestamp();
        await message.channel.send({ embeds: [milestoneEmbed] }).catch(() => {});

        try {
            const [[economyConfig]] = await pool.execute(
                'SELECT enabled FROM economy_config WHERE guild_id = ?', [message.guild.id]);
            if (economyConfig && economyConfig.enabled) {
                await pool.execute(
                    'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
                    [number, number, message.guild.id, message.author.id]);
                await message.channel.send(`💰 ${message.author} earned **${number} coins** for reaching the milestone!`).catch(() => {});
            }
        } catch { /* economy not set up */ }

        if (number > Number(channel.highest_count)) {
            const recordEmbed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('🏆 NEW RECORD!')
                .setDescription(`A new counting record has been set: **${number}**!`)
                .setFooter({ text: `Previous record: ${channel.highest_count}` })
                .setTimestamp();
            await message.channel.send({ embeds: [recordEmbed] }).catch(() => {});
        }
    }
    return true;
}

/**
 * A wrong number, or a double-count.
 *   delete mode → remove the message; the count is untouched and anyone may retry.
 *   reset mode  → wipe the count and say so (the original behaviour).
 */
async function handleBadCount(message, channel, { number, expectedNumber, sameUser, deleteMode }) {
    await updateCountingStats(message.guild.id, message.channel.id, message.author.id, false, Number(channel.current_count));

    if (deleteMode) {
        // Silent by design: no reply, no reaction, no reset. Deleting is the whole feedback.
        await message.delete().catch(() => {});
        return true;
    }

    await message.react('❌').catch(() => {});
    await pool.execute(
        'UPDATE counting_channels SET current_count = 0, last_user_id = NULL, reset_count = reset_count + 1 WHERE guild_id = ? AND channel_id = ?',
        [message.guild.id, message.channel.id]
    );

    const resetEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('🔄 Count Reset!')
        .setDescription(sameUser
            ? `${message.author} counted twice in a row! Count reset to **0**.`
            : 'Wrong number! Count reset to **0**.')
        .addFields(
            { name: 'Failed At', value: `${channel.current_count}`, inline: true },
            { name: 'Expected', value: `${expectedNumber}`, inline: true },
            { name: 'Got', value: `${number}`, inline: true },
            { name: 'Next Number', value: '1', inline: true }
        )
        .setTimestamp();
    await message.channel.send({ embeds: [resetEmbed] }).catch(() => {});
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
