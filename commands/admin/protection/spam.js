import { EmbedBuilder, ChannelType } from 'discord.js';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { themeColor } from '../../../core/guild-theme.js';
import {
    addPattern, removePattern, setPatternEnabled, listPatterns, markPatternFalsePositive,
} from '../../../core/advanced-automod-manager.js';

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
        case 'pattern-add':
            return handlePatternAdd(interaction, guildId);
        case 'pattern-remove':
            return handlePatternRemove(interaction, guildId);
        case 'pattern-list':
            return handlePatternList(interaction, guildId);
        case 'pattern-toggle':
            return handlePatternToggle(interaction, guildId);
        case 'pattern-false-positive':
            return handlePatternFalsePositive(interaction, guildId);
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
        .setColor(themeColor(interaction.guildId, 'success'))
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
        .setColor(themeColor(interaction.guildId, 'primary'))
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

/**
 * Effectiveness of this server's custom patterns. Hits are recorded by
 * core/advanced-automod-manager.js whenever a pattern acts; misfires reported with
 * `pattern-false-positive` move a hit to the false-positive column.
 */
async function handlePatterns(interaction, guildId) {
    const rows = (await listPatterns(guildId))
        .filter(p => Number(p.true_positives) + Number(p.false_positives) > 0)
        .sort((a, b) => (Number(b.effectiveness_score) || 0) - (Number(a.effectiveness_score) || 0))
        .slice(0, 10);

    if (rows.length === 0) {
        return await interaction.reply({
            content: 'No pattern statistics yet. Add a pattern with `/protection spam pattern-add`; hits are counted each time one acts.',
            ephemeral: true
        });
    }

    const patternList = rows.map((p, i) => {
        const effectiveness = Math.round(Number(p.effectiveness_score) || 0);
        const emoji = effectiveness >= 70 ? '🟢' : effectiveness >= 40 ? '🟡' : '🔴';
        const lastHit = p.last_hit_at ? ` | last <t:${Math.floor(new Date(p.last_hit_at).getTime() / 1000)}:R>` : '';
        return `${emoji} **${i + 1}.** #${p.id} ${previewPattern(p.pattern)} (${p.pattern_type})\n└ Effectiveness: ${effectiveness}% | TP: ${p.true_positives} | FP: ${p.false_positives}${lastHit}`;
    }).join('\n\n');

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle('📈 Pattern Effectiveness Rankings')
        .setDescription(patternList.substring(0, 4000))
        .setFooter({ text: 'TP = True Positives | FP = False Positives (report with pattern-false-positive)' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

/** Inline-code preview that cannot break out of its backticks. */
function previewPattern(pattern, max = 40) {
    const text = String(pattern).replace(/`/g, 'ˋ');
    return `\`${text.length > max ? `${text.substring(0, max)}…` : text}\``;
}

async function handlePatternAdd(interaction, guildId) {
    const type = interaction.options.getString('type', true);
    const pattern = interaction.options.getString('pattern', true);
    const action = interaction.options.getString('action') || 'delete';
    const reason = interaction.options.getString('reason');

    const result = await addPattern(guildId, type, pattern, action, reason, interaction.user.id);
    if (!result.ok) {
        return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'success'))
        .setTitle(`✅ Pattern #${result.id} added`)
        .addFields(
            { name: 'Type', value: type, inline: true },
            { name: 'Action', value: action, inline: true },
            { name: 'Pattern', value: previewPattern(result.value, 200), inline: false },
        )
        .setFooter({ text: 'Applies to new messages within a few seconds. Admins, the owner and automod-exempt roles/channels are never checked.' });
    if (reason) embed.addFields({ name: 'Reason', value: reason.substring(0, 200), inline: false });
    if (action === 'kick' || action === 'ban') {
        embed.setDescription('⚠️ This pattern removes members from the server. Test it with `delete` first if you are unsure.');
    }
    return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handlePatternRemove(interaction, guildId) {
    const id = interaction.options.getInteger('id', true);
    const removed = await removePattern(guildId, id);
    return interaction.reply({
        content: removed ? `🗑️ Pattern #${id} removed (and its statistics).` : `No pattern #${id} in this server. See \`/protection spam pattern-list\`.`,
        ephemeral: true
    });
}

async function handlePatternToggle(interaction, guildId) {
    const id = interaction.options.getInteger('id', true);
    const enabled = interaction.options.getBoolean('enabled', true);
    const changed = await setPatternEnabled(guildId, id, enabled, enabled ? null : `Disabled by ${interaction.user.tag}`);
    return interaction.reply({
        content: changed ? `Pattern #${id} is now **${enabled ? 'enabled' : 'disabled'}**.` : `No pattern #${id} in this server.`,
        ephemeral: true
    });
}

async function handlePatternFalsePositive(interaction, guildId) {
    const id = interaction.options.getInteger('id', true);
    const ok = await markPatternFalsePositive(guildId, id);
    return interaction.reply({
        content: ok
            ? `Recorded a false positive for pattern #${id}. If it keeps misfiring, disable it with \`/protection spam pattern-toggle id:${id} enabled:False\`.`
            : `No pattern #${id} in this server.`,
        ephemeral: true
    });
}

async function handlePatternList(interaction, guildId) {
    const rows = await listPatterns(guildId);
    if (rows.length === 0) {
        return interaction.reply({
            content: 'This server has no custom patterns. Add one with `/protection spam pattern-add`.',
            ephemeral: true
        });
    }

    const lines = rows.map(p => {
        const state = p.enabled ? '🟢' : '⚪';
        const note = !p.enabled && p.disabled_reason ? ` — ${p.disabled_reason}` : '';
        return `${state} **#${p.id}** ${p.pattern_type} → ${p.action}: ${previewPattern(p.pattern)} (${p.true_positives} hit${Number(p.true_positives) === 1 ? '' : 's'})${note}`;
    });

    // Stay inside one embed description (4096) even with 50 long patterns.
    let description = '';
    let shown = 0;
    for (const line of lines) {
        if (description.length + line.length + 1 > 3900) break;
        description += `${line}\n`;
        shown++;
    }
    if (shown < lines.length) description += `…and ${lines.length - shown} more`;

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle(`🧩 Custom automod patterns (${rows.length})`)
        .setDescription(description)
        .setFooter({ text: '🟢 enabled  ⚪ disabled · pattern-remove / pattern-toggle take the #id' });
    return interaction.reply({ embeds: [embed], ephemeral: true });
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
