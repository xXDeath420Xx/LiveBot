import { EmbedBuilder, ChannelType } from 'discord.js';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

export async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    switch (subcommand) {
        case 'enable':
            return handleEnable(interaction, guildId);
        case 'disable':
            return handleDisable(interaction, guildId);
        case 'config':
            return handleConfig(interaction, guildId);
        case 'status':
            return handleStatus(interaction, guildId);
        case 'user':
            return handleUserProfile(interaction, guildId);
        case 'patterns':
            return handlePatterns(interaction, guildId);
        case 'reset':
            return handleReset(interaction, guildId);
    }
}

async function handleEnable(interaction, guildId) {
    await pool.execute(
        `INSERT INTO adaptive_spam_config (guild_id, enabled) VALUES (?, TRUE)
         ON DUPLICATE KEY UPDATE enabled = TRUE`,
        [guildId]
    );

    await interaction.reply({
        content: '📊 **Adaptive Spam Detection Enabled**\n\nThe system now learns user behavior patterns and adapts detection.\n\n**Features:**\n• Cross-channel spam detection\n• Baseline behavior learning\n• New account score weighting\n• Pattern effectiveness tracking\n\nUse `/protection spam config` to customize settings.',
        ephemeral: true
    });

    logger.info('[AdaptiveSpam] Enabled', { guildId });
}

async function handleDisable(interaction, guildId) {
    await pool.execute(
        `UPDATE adaptive_spam_config SET enabled = FALSE WHERE guild_id = ?`,
        [guildId]
    );

    await interaction.reply({
        content: '⚠️ **Adaptive Spam Detection Disabled**\n\nThe adaptive learning system is now inactive. Existing automod rules still apply.',
        ephemeral: true
    });

    logger.info('[AdaptiveSpam] Disabled', { guildId });
}

async function handleConfig(interaction, guildId) {
    const crossChannelThreshold = interaction.options.getInteger('cross_channel_threshold');
    const crossChannelTimeframe = interaction.options.getInteger('cross_channel_timeframe');
    const deviationMultiplier = interaction.options.getNumber('deviation_multiplier');
    const newAccount7d = interaction.options.getNumber('new_account_7d');
    const newAccount24h = interaction.options.getNumber('new_account_24h');
    const action = interaction.options.getString('action');
    const alertChannel = interaction.options.getChannel('alert_channel');

    await pool.execute(
        `INSERT IGNORE INTO adaptive_spam_config (guild_id) VALUES (?)`,
        [guildId]
    );

    const updates = [];
    const values = [];

    if (crossChannelThreshold !== null) { updates.push('cross_channel_threshold = ?'); values.push(crossChannelThreshold); }
    if (crossChannelTimeframe !== null) { updates.push('cross_channel_timeframe_minutes = ?'); values.push(crossChannelTimeframe); }
    if (deviationMultiplier !== null) { updates.push('deviation_multiplier = ?'); values.push(deviationMultiplier); }
    if (newAccount7d !== null) { updates.push('new_account_multiplier_7d = ?'); values.push(newAccount7d); }
    if (newAccount24h !== null) { updates.push('new_account_multiplier_24h = ?'); values.push(newAccount24h); }
    if (action !== null) { updates.push('action = ?'); values.push(action); }
    if (alertChannel !== null) { updates.push('alert_channel_id = ?'); values.push(alertChannel.id); }

    if (updates.length === 0) {
        return await interaction.reply({ content: 'Please specify at least one setting to configure!', ephemeral: true });
    }

    values.push(guildId);
    await pool.execute(`UPDATE adaptive_spam_config SET ${updates.join(', ')} WHERE guild_id = ?`, values);

    const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('✅ Adaptive Spam Configuration Updated')
        .setDescription('The following settings have been updated:');

    if (crossChannelThreshold !== null) embed.addFields({ name: 'Cross-Channel Threshold', value: `${crossChannelThreshold} channels`, inline: true });
    if (crossChannelTimeframe !== null) embed.addFields({ name: 'Cross-Channel Timeframe', value: `${crossChannelTimeframe} min`, inline: true });
    if (deviationMultiplier !== null) embed.addFields({ name: 'Deviation Multiplier', value: `${deviationMultiplier}x`, inline: true });
    if (newAccount7d !== null) embed.addFields({ name: 'New Account (7d) Multiplier', value: `${newAccount7d}x`, inline: true });
    if (newAccount24h !== null) embed.addFields({ name: 'New Account (24h) Multiplier', value: `${newAccount24h}x`, inline: true });
    if (action !== null) embed.addFields({ name: 'Action', value: action.toUpperCase(), inline: true });
    if (alertChannel !== null) embed.addFields({ name: 'Alert Channel', value: `${alertChannel}`, inline: true });

    await interaction.reply({ embeds: [embed], ephemeral: true });
    logger.info('[AdaptiveSpam] Config updated', { guildId, updates });
}

async function handleStatus(interaction, guildId) {
    const [rows] = await pool.execute(`SELECT * FROM adaptive_spam_config WHERE guild_id = ?`, [guildId]);

    if (rows.length === 0 || !rows[0].enabled) {
        return await interaction.reply({
            content: '⚠️ Adaptive Spam Detection is currently **disabled**.\n\nUse `/protection spam enable` to enable.',
            ephemeral: true
        });
    }

    const config = rows[0];
    const alertChannel = config.alert_channel_id
        ? await interaction.guild.channels.fetch(config.alert_channel_id).catch(() => 'Not set')
        : 'Not set';

    const [profileCount] = await pool.execute(`SELECT COUNT(*) as count FROM spam_profiles WHERE guild_id = ?`, [guildId]);
    const [crossChannelCount] = await pool.execute(`SELECT COUNT(*) as count FROM cross_channel_spam WHERE guild_id = ? AND flagged = TRUE`, [guildId]);

    const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('📊 Adaptive Spam Detection Status')
        .setDescription('Current adaptive spam configuration:')
        .addFields(
            { name: 'Status', value: '✅ Enabled', inline: true },
            { name: 'Action', value: (config.action || 'mute').toUpperCase(), inline: true },
            { name: 'Alert Channel', value: typeof alertChannel === 'string' ? alertChannel : alertChannel.toString(), inline: true },
            { name: 'Cross-Channel Threshold', value: `${config.cross_channel_threshold} channels`, inline: true },
            { name: 'Cross-Channel Timeframe', value: `${config.cross_channel_timeframe_minutes} min`, inline: true },
            { name: 'Deviation Multiplier', value: `${config.deviation_multiplier}x`, inline: true },
            { name: 'New Account (7d)', value: `${config.new_account_multiplier_7d}x`, inline: true },
            { name: 'New Account (24h)', value: `${config.new_account_multiplier_24h}x`, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Tracked Profiles', value: `${profileCount[0].count}`, inline: true },
            { name: 'Cross-Channel Flags', value: `${crossChannelCount[0].count}`, inline: true }
        )
        .setFooter({ text: 'Use /protection spam config to modify settings' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleUserProfile(interaction, guildId) {
    const user = interaction.options.getUser('user');
    const manager = interaction.client.adaptiveSpamManager;

    await interaction.deferReply({ ephemeral: true });

    let profile;
    if (manager) {
        profile = await manager.getUserProfile(guildId, user.id);
    } else {
        const [rows] = await pool.execute(`SELECT * FROM spam_profiles WHERE guild_id = ? AND user_id = ?`, [guildId, user.id]);
        profile = rows[0] || null;
    }

    if (!profile) {
        return await interaction.editReply({ content: `No spam profile found for ${user.tag}. They may not have any recent activity.` });
    }

    const embed = new EmbedBuilder()
        .setColor(profile.spam_score > 30 ? 0xff6600 : 0x00ff00)
        .setTitle(`📊 Spam Profile: ${user.tag}`)
        .setThumbnail(user.displayAvatarURL())
        .addFields(
            { name: 'Spam Score', value: `${profile.spam_score}/100`, inline: true },
            { name: 'Total Violations', value: `${profile.total_violations}`, inline: true },
            { name: 'Messages Analyzed', value: `${profile.messages_analyzed || 'N/A'}`, inline: true },
            { name: 'Baseline Msg Rate', value: `${Math.round(profile.baseline_msg_rate || 0)} msg/hr`, inline: true },
            { name: 'Baseline Deviation', value: `±${Math.round(profile.baseline_deviation || 0)}`, inline: true }
        );

    if (profile.last_violation_at) {
        embed.addFields({ name: 'Last Violation', value: `<t:${Math.floor(new Date(profile.last_violation_at).getTime() / 1000)}:R>`, inline: true });
    }

    if (profile.crossChannelSpam && profile.crossChannelSpam.length > 0) {
        const crossChannelInfo = profile.crossChannelSpam
            .slice(0, 3)
            .map(cc => `"${cc.message_preview?.substring(0, 30)}..." (${cc.channel_count} channels)`)
            .join('\n');
        embed.addFields({ name: 'Recent Cross-Channel Spam', value: crossChannelInfo, inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
}

async function handlePatterns(interaction, guildId) {
    const manager = interaction.client.adaptiveSpamManager;

    let patterns;
    if (manager) {
        patterns = await manager.getPatternEffectiveness(guildId, 10);
    } else {
        const [rows] = await pool.execute(
            `SELECT s.*, p.pattern, p.pattern_type FROM spam_patterns_stats s JOIN automod_patterns p ON s.pattern_id = p.id WHERE s.guild_id = ? ORDER BY s.effectiveness_score DESC LIMIT 10`,
            [guildId]
        );
        patterns = rows;
    }

    if (!patterns || patterns.length === 0) {
        return await interaction.reply({ content: 'No pattern statistics available yet. Patterns will be tracked as they catch spam.', ephemeral: true });
    }

    const patternList = patterns.map((p, i) => {
        const effectiveness = Math.round(p.effectiveness_score || 0);
        const emoji = effectiveness >= 70 ? '🟢' : effectiveness >= 40 ? '🟡' : '🔴';
        const preview = p.pattern.length > 30 ? p.pattern.substring(0, 30) + '...' : p.pattern;
        return `${emoji} **${i + 1}.** \`${preview}\` (${p.pattern_type})\n└ Effectiveness: ${effectiveness}% | TP: ${p.true_positives} | FP: ${p.false_positives}`;
    }).join('\n\n');

    const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('📈 Pattern Effectiveness Rankings')
        .setDescription(patternList)
        .setFooter({ text: 'TP = True Positives | FP = False Positives' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleReset(interaction, guildId) {
    const user = interaction.options.getUser('user');

    await pool.execute(`DELETE FROM spam_profiles WHERE guild_id = ? AND user_id = ?`, [guildId, user.id]);

    const manager = interaction.client.adaptiveSpamManager;
    if (manager) {
        manager.recentMessages.delete(`${guildId}_${user.id}`);
    }

    await interaction.reply({
        content: `✅ Reset spam profile for **${user.tag}**.\n\nTheir baseline will be recalculated from scratch.`,
        ephemeral: true
    });

    logger.info('[AdaptiveSpam] Profile reset', { guildId, userId: user.id, resetBy: interaction.user.id });
}
