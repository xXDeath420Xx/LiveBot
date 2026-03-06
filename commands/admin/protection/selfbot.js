import { EmbedBuilder, ChannelType } from 'discord.js';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

export async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    try {
        switch (subcommand) {
            case 'enable':
                await handleEnable(interaction, guildId);
                break;
            case 'disable':
                await handleDisable(interaction, guildId);
                break;
            case 'config':
                await handleConfig(interaction, guildId);
                break;
            case 'status':
                await handleStatus(interaction, guildId);
                break;
            case 'exempt':
                await handleExempt(interaction, guildId);
                break;
            case 'check':
                await handleCheck(interaction, guildId);
                break;
            case 'history':
                await handleHistory(interaction, guildId);
                break;
        }
    } catch (error) {
        logger.error('[SelfbotDetection Command] Error:', { error: error.message, stack: error.stack });

        const reply = { content: `Error: ${error.message}`, ephemeral: true };
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(reply);
        } else {
            await interaction.reply(reply);
        }
    }
}

async function handleEnable(interaction, guildId) {
    await pool.execute(
        `INSERT INTO selfbot_detection_config (guild_id, enabled) VALUES (?, TRUE)
         ON DUPLICATE KEY UPDATE enabled = TRUE`,
        [guildId]
    );

    await interaction.reply({
        content: '🤖 **Self-Bot Detection Enabled**\n\nThe server now monitors for automated user behavior.\n\n**Detection Signals:**\n• Inhuman response times (<50ms)\n• Message bursts (20+ messages/second)\n• Regular message intervals\n• API-like behavior patterns\n\nUse `/protection selfbot config` to customize settings.',
        ephemeral: true
    });

    logger.info('[SelfbotDetection] Enabled', { guildId });
}

async function handleDisable(interaction, guildId) {
    await pool.execute(
        `UPDATE selfbot_detection_config SET enabled = FALSE WHERE guild_id = ?`,
        [guildId]
    );

    await interaction.reply({
        content: '⚠️ **Self-Bot Detection Disabled**\n\nThe server is no longer monitoring for automated behavior.',
        ephemeral: true
    });

    logger.info('[SelfbotDetection] Disabled', { guildId });
}

async function handleConfig(interaction, guildId) {
    const minResponseTime = interaction.options.getInteger('min_response_time');
    const burstThreshold = interaction.options.getInteger('burst_threshold');
    const burstWindow = interaction.options.getInteger('burst_window');
    const patternThreshold = interaction.options.getInteger('pattern_threshold');
    const action = interaction.options.getString('action');
    const alertChannel = interaction.options.getChannel('alert_channel');
    const muteDuration = interaction.options.getInteger('mute_duration');
    const purgeMessages = interaction.options.getBoolean('purge_messages');

    // Initialize config if not exists
    await pool.execute(
        `INSERT IGNORE INTO selfbot_detection_config (guild_id) VALUES (?)`,
        [guildId]
    );

    // Build update query
    const updates = [];
    const values = [];

    if (minResponseTime !== null) {
        updates.push('min_response_time_ms = ?');
        values.push(minResponseTime);
    }
    if (burstThreshold !== null) {
        updates.push('message_burst_threshold = ?');
        values.push(burstThreshold);
    }
    if (burstWindow !== null) {
        updates.push('message_burst_window_ms = ?');
        values.push(burstWindow);
    }
    if (patternThreshold !== null) {
        updates.push('pattern_threshold = ?');
        values.push(patternThreshold);
    }
    if (action !== null) {
        updates.push('action = ?');
        values.push(action);
    }
    if (alertChannel !== null) {
        updates.push('alert_channel_id = ?');
        values.push(alertChannel.id);
    }
    if (muteDuration !== null) {
        updates.push('mute_duration_minutes = ?');
        values.push(muteDuration);
    }
    if (purgeMessages !== null) {
        updates.push('purge_messages = ?');
        values.push(purgeMessages);
    }

    if (updates.length === 0) {
        return await interaction.reply({
            content: 'Please specify at least one setting to configure!',
            ephemeral: true
        });
    }

    values.push(guildId);

    await pool.execute(
        `UPDATE selfbot_detection_config SET ${updates.join(', ')} WHERE guild_id = ?`,
        values
    );

    const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('✅ Self-Bot Detection Configuration Updated')
        .setDescription('The following settings have been updated:');

    if (minResponseTime !== null) embed.addFields({ name: 'Min Response Time', value: `${minResponseTime}ms`, inline: true });
    if (burstThreshold !== null) embed.addFields({ name: 'Burst Threshold', value: `${burstThreshold} msgs`, inline: true });
    if (burstWindow !== null) embed.addFields({ name: 'Burst Window', value: `${burstWindow}ms`, inline: true });
    if (patternThreshold !== null) embed.addFields({ name: 'Pattern Threshold', value: `${patternThreshold}`, inline: true });
    if (action !== null) embed.addFields({ name: 'Action', value: action.toUpperCase(), inline: true });
    if (alertChannel !== null) embed.addFields({ name: 'Alert Channel', value: `${alertChannel}`, inline: true });
    if (muteDuration !== null) embed.addFields({ name: 'Mute Duration', value: `${muteDuration} min`, inline: true });
    if (purgeMessages !== null) embed.addFields({ name: 'Purge Messages', value: purgeMessages ? 'Yes' : 'No', inline: true });

    await interaction.reply({ embeds: [embed], ephemeral: true });

    logger.info('[SelfbotDetection] Config updated', { guildId, updates });
}

async function handleStatus(interaction, guildId) {
    const [rows] = await pool.execute(
        `SELECT * FROM selfbot_detection_config WHERE guild_id = ?`,
        [guildId]
    );

    if (rows.length === 0 || !rows[0].enabled) {
        return await interaction.reply({
            content: '⚠️ Self-Bot Detection is currently **disabled**.\n\nUse `/protection selfbot enable` to enable.',
            ephemeral: true
        });
    }

    const config = rows[0];
    const alertChannel = config.alert_channel_id
        ? await interaction.guild.channels.fetch(config.alert_channel_id).catch(() => 'Not set')
        : 'Not set';

    // Count exempt roles
    const exemptRoles = config.exempt_roles ? JSON.parse(config.exempt_roles).length : 0;

    // Get recent detection count
    const [detections] = await pool.execute(
        `SELECT COUNT(*) as count FROM selfbot_detections WHERE guild_id = ? AND detected_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
        [guildId]
    );

    const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('🤖 Self-Bot Detection Status')
        .setDescription('Current self-bot detection configuration:')
        .addFields(
            { name: 'Status', value: '✅ Enabled', inline: true },
            { name: 'Action', value: (config.action || 'mute').toUpperCase(), inline: true },
            { name: 'Alert Channel', value: typeof alertChannel === 'string' ? alertChannel : alertChannel.toString(), inline: true },
            { name: 'Min Response Time', value: `${config.min_response_time_ms}ms`, inline: true },
            { name: 'Burst Threshold', value: `${config.message_burst_threshold} msgs`, inline: true },
            { name: 'Burst Window', value: `${config.message_burst_window_ms}ms`, inline: true },
            { name: 'Pattern Threshold', value: `${config.pattern_threshold}`, inline: true },
            { name: 'Mute Duration', value: `${config.mute_duration_minutes} min`, inline: true },
            { name: 'Purge Messages', value: config.purge_messages ? 'Yes' : 'No', inline: true },
            { name: 'Exempt Roles', value: `${exemptRoles}`, inline: true },
            { name: 'Detections (7d)', value: `${detections[0].count}`, inline: true }
        )
        .setFooter({ text: 'Use /protection selfbot config to modify settings' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleExempt(interaction, guildId) {
    const action = interaction.options.getString('action');
    const role = interaction.options.getRole('role');

    // Get current config
    const [rows] = await pool.execute(
        `SELECT exempt_roles FROM selfbot_detection_config WHERE guild_id = ?`,
        [guildId]
    );

    let exemptRoles = [];
    if (rows.length > 0 && rows[0].exempt_roles) {
        exemptRoles = JSON.parse(rows[0].exempt_roles);
    }

    if (action === 'list') {
        if (exemptRoles.length === 0) {
            return await interaction.reply({
                content: 'No roles are currently exempt from self-bot detection.',
                ephemeral: true
            });
        }

        const roleList = exemptRoles.map(id => `<@&${id}>`).join('\n');

        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle('📋 Exempt Roles')
            .setDescription(`**${exemptRoles.length}** role${exemptRoles.length !== 1 ? 's' : ''} exempt from self-bot detection:\n\n${roleList}`);

        return await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (!role) {
        return await interaction.reply({
            content: 'Please specify a role to add or remove!',
            ephemeral: true
        });
    }

    if (action === 'add') {
        if (exemptRoles.includes(role.id)) {
            return await interaction.reply({
                content: `${role} is already exempt.`,
                ephemeral: true
            });
        }

        exemptRoles.push(role.id);

        await pool.execute(
            `INSERT INTO selfbot_detection_config (guild_id, exempt_roles) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE exempt_roles = ?`,
            [guildId, JSON.stringify(exemptRoles), JSON.stringify(exemptRoles)]
        );

        await interaction.reply({
            content: `✅ Added ${role} to exempt roles.\n\nUsers with this role will not trigger self-bot detection.`,
            ephemeral: true
        });

    } else if (action === 'remove') {
        const index = exemptRoles.indexOf(role.id);
        if (index === -1) {
            return await interaction.reply({
                content: `${role} is not in the exempt list.`,
                ephemeral: true
            });
        }

        exemptRoles.splice(index, 1);

        await pool.execute(
            `UPDATE selfbot_detection_config SET exempt_roles = ? WHERE guild_id = ?`,
            [JSON.stringify(exemptRoles), guildId]
        );

        await interaction.reply({
            content: `✅ Removed ${role} from exempt roles.`,
            ephemeral: true
        });
    }

    logger.info('[SelfbotDetection] Exempt roles updated', { guildId, action, roleId: role?.id });
}

async function handleCheck(interaction, guildId) {
    const user = interaction.options.getUser('user');
    const manager = interaction.client.selfbotDetectionManager;

    if (!manager) {
        return await interaction.reply({
            content: 'Self-bot detection manager not initialized.',
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });

    const result = await manager.manualCheck(guildId, user.id);

    const embed = new EmbedBuilder()
        .setColor(result.suspicious ? 0xff6600 : 0x00ff00)
        .setTitle(`🔍 Self-Bot Check: ${user.tag}`)
        .setThumbnail(user.displayAvatarURL())
        .addFields(
            { name: 'Status', value: result.suspicious ? '⚠️ Suspicious' : '✅ Normal', inline: true },
            { name: 'Messages Analyzed', value: `${result.messageCount}`, inline: true }
        );

    if (result.suspicionScore !== undefined) {
        embed.addFields({ name: 'Suspicion Score', value: `${result.suspicionScore}/100`, inline: true });
    }

    if (result.patterns && result.patterns.length > 0) {
        embed.addFields({ name: 'Detected Patterns', value: result.patterns.join(', '), inline: false });
    }

    if (result.reason) {
        embed.setDescription(result.reason);
    }

    await interaction.editReply({ embeds: [embed] });
}

async function handleHistory(interaction, guildId) {
    const user = interaction.options.getUser('user');

    let query = `SELECT * FROM selfbot_detections WHERE guild_id = ?`;
    const params = [guildId];

    if (user) {
        query += ` AND user_id = ?`;
        params.push(user.id);
    }

    query += ` ORDER BY detected_at DESC LIMIT 15`;

    const [rows] = await pool.execute(query, params);

    if (rows.length === 0) {
        return await interaction.reply({
            content: user
                ? `No self-bot detections recorded for ${user.tag}.`
                : 'No self-bot detections recorded for this server.',
            ephemeral: true
        });
    }

    const detections = rows.map((r, i) => {
        const date = new Date(r.detected_at).toLocaleString();
        return `**${i + 1}.** <@${r.user_id}> | ${r.detection_type}\n└ ${date} | Confidence: ${r.confidence_score}% | Action: ${r.action_taken}`;
    }).join('\n\n');

    const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(user ? `📋 Detection History: ${user.tag}` : '📋 Self-Bot Detection History')
        .setDescription(detections)
        .setFooter({ text: `Showing last ${rows.length} detections` });

    await interaction.reply({ embeds: [embed], ephemeral: true });
}
