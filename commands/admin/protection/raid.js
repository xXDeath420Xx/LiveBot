import { EmbedBuilder } from 'discord.js';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { themeColor } from '../../../core/guild-theme.js';
import { invalidateRaidConfig, getActive as getActiveLockdown } from '../../../core/raid-lockdown.js';

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
            case 'history':
                await handleHistory(interaction, guildId);
                break;
            case 'resolve':
                await handleResolve(interaction, guildId);
                break;
        }
    } catch (error) {
        logger.error('[RaidProtection Command] Error:', { error: error.message, stack: error.stack });

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
        `INSERT INTO raid_detection_config (guild_id, enabled) VALUES (?, TRUE)
         ON DUPLICATE KEY UPDATE enabled = TRUE`,
        [guildId]
    );
    invalidateRaidConfig(guildId);

    // The settings it now runs with, read back rather than hard-coded (the old text promised a mute and a
    // purge that the column defaults, alert only and no purge, never gave; H-660).
    const [[c]] = await pool.execute('SELECT * FROM raid_detection_config WHERE guild_id = ?', [guildId]);
    const timeout = `time out raiders for ${c?.mute_duration_minutes ?? 60} minutes`;
    const actionText = { mute: timeout, lockdown: timeout, kick: 'kick raiders', ban: 'ban raiders', alert: 'alert only, nobody is actioned' }[c?.action] || String(c?.action || 'alert');
    await interaction.reply({
        content: '🚨 **Raid Protection Enabled**\n\nThe server is now protected against coordinated mass-join raids.\n\n**Current settings:**\n'
            + `• Threshold: ${c?.join_threshold ?? 10} joins in ${c?.join_timeframe_seconds ?? 30} seconds\n`
            + `• New account age: ${c?.new_account_age_hours ?? 24} hours\n`
            + `• Action: ${actionText}\n`
            + `• Purge messages: ${c?.purge_messages ? 'on' : 'off'}\n\n`
            + 'Use `/protection raid config` to change them, or the Advanced protection page on the dashboard.\n'
            + 'To block every new join during a raid, use `/lockdown` (it can start automatically on a join spike).',
        ephemeral: true
    });

    logger.info('[RaidProtection] Enabled', { guildId });
}

async function handleDisable(interaction, guildId) {
    await pool.execute(
        `UPDATE raid_detection_config SET enabled = FALSE WHERE guild_id = ?`,
        [guildId]
    );
    invalidateRaidConfig(guildId);

    await interaction.reply({
        content: '⚠️ **Raid Protection Disabled**\n\nThe server is no longer protected against raids. Use `/protection raid enable` to re-enable.',
        ephemeral: true
    });

    logger.info('[RaidProtection] Disabled', { guildId });
}

async function handleConfig(interaction, guildId) {
    const joinThreshold = interaction.options.getInteger('join_threshold');
    const timeframe = interaction.options.getInteger('timeframe');
    const accountAge = interaction.options.getInteger('account_age');
    const accountRatio = interaction.options.getNumber('account_ratio');
    const action = interaction.options.getString('action');
    const alertChannel = interaction.options.getChannel('alert_channel');
    const muteDuration = interaction.options.getInteger('mute_duration');
    const purgeMessages = interaction.options.getBoolean('purge_messages');

    // Initialize config if not exists
    await pool.execute(
        `INSERT IGNORE INTO raid_detection_config (guild_id) VALUES (?)`,
        [guildId]
    );

    // Build update query
    const updates = [];
    const values = [];

    if (joinThreshold !== null) {
        updates.push('join_threshold = ?');
        values.push(joinThreshold);
    }
    if (timeframe !== null) {
        updates.push('join_timeframe_seconds = ?');
        values.push(timeframe);
    }
    if (accountAge !== null) {
        updates.push('new_account_age_hours = ?');
        values.push(accountAge);
    }
    if (accountRatio !== null) {
        updates.push('new_account_ratio = ?');
        values.push(accountRatio);
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
        `UPDATE raid_detection_config SET ${updates.join(', ')} WHERE guild_id = ?`,
        values
    );
    invalidateRaidConfig(guildId);

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'success'))
        .setTitle('✅ Raid Protection Configuration Updated')
        .setDescription('The following settings have been updated:');

    if (joinThreshold !== null) embed.addFields({ name: 'Join Threshold', value: `${joinThreshold}`, inline: true });
    if (timeframe !== null) embed.addFields({ name: 'Timeframe', value: `${timeframe}s`, inline: true });
    if (accountAge !== null) embed.addFields({ name: 'Account Age Filter', value: `${accountAge}h`, inline: true });
    if (accountRatio !== null) embed.addFields({ name: 'New Account Ratio', value: `${(accountRatio * 100).toFixed(0)}%`, inline: true });
    if (action !== null) embed.addFields({ name: 'Action', value: action.toUpperCase(), inline: true });
    if (alertChannel !== null) embed.addFields({ name: 'Alert Channel', value: `${alertChannel}`, inline: true });
    if (muteDuration !== null) embed.addFields({ name: 'Mute Duration', value: `${muteDuration} min`, inline: true });
    if (purgeMessages !== null) embed.addFields({ name: 'Purge Messages', value: purgeMessages ? 'Yes' : 'No', inline: true });

    await interaction.reply({ embeds: [embed], ephemeral: true });

    logger.info('[RaidProtection] Config updated', { guildId, updates });
}

async function handleStatus(interaction, guildId) {
    const [rows] = await pool.execute(
        `SELECT * FROM raid_detection_config WHERE guild_id = ?`,
        [guildId]
    );

    if (rows.length === 0 || !rows[0].enabled) {
        return await interaction.reply({
            content: '⚠️ Raid Protection is currently **disabled**.\n\nUse `/protection raid enable` to enable protection.'
                + ((await getActiveLockdown(guildId)) ? '\n\n🚨 **A join lockdown is running** — see `/lockdown status`.' : '\nThe join lockdown, its auto-trigger and same-name floods are under `/lockdown`.'),
            ephemeral: true
        });
    }

    const config = rows[0];
    const alertChannel = config.alert_channel_id
        ? await interaction.guild.channels.fetch(config.alert_channel_id).catch(() => 'Not set')
        : 'Not set';

    // Check for active raid
    const manager = interaction.client.raidDetectionManager;
    const activeRaid = manager?.activeRaids.get(guildId);

    const embed = new EmbedBuilder()
        .setColor(activeRaid ? 0xff0000 : 0x3498db)
        .setTitle('🚨 Raid Protection Status')
        .setDescription(activeRaid
            ? '**⚠️ ACTIVE RAID DETECTED**\nUse `/protection raid resolve` to clear.'
            : 'Current raid protection configuration:')
        .addFields(
            { name: 'Status', value: '✅ Enabled', inline: true },
            { name: 'Action', value: (config.action || 'mute').toUpperCase(), inline: true },
            { name: 'Alert Channel', value: typeof alertChannel === 'string' ? alertChannel : alertChannel.toString(), inline: true },
            { name: 'Join Threshold', value: `${config.join_threshold} joins`, inline: true },
            { name: 'Timeframe', value: `${config.join_timeframe_seconds}s`, inline: true },
            { name: 'Account Age Filter', value: `< ${config.new_account_age_hours}h`, inline: true },
            { name: 'New Account Ratio', value: `${(config.new_account_ratio * 100).toFixed(0)}%`, inline: true },
            { name: 'Mute Duration', value: `${config.mute_duration_minutes} min`, inline: true },
            { name: 'Purge Messages', value: config.purge_messages ? 'Yes' : 'No', inline: true }
        )
        .setFooter({ text: 'Use /protection raid config to modify settings' })
        .setTimestamp();

    const lockdown = await getActiveLockdown(guildId);
    embed.addFields({
        name: 'Join Lockdown',
        value: lockdown
            ? `🚨 Running until <t:${Math.floor(new Date(lockdown.ends_at).getTime() / 1000)}:R> (${lockdown.action}) — \`/lockdown status\``
            : 'Off — `/lockdown start`, the auto-trigger and same-name floods are under `/lockdown`',
        inline: false
    });

    if (activeRaid) {
        embed.addFields({
            name: 'Active Raid Info',
            value: `Started: <t:${Math.floor(activeRaid.startTime / 1000)}:R>\nAffected Users: ${activeRaid.affectedUsers.length}`,
            inline: false
        });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleHistory(interaction, guildId) {
    const [rows] = await pool.execute(
        `SELECT * FROM raid_incidents WHERE guild_id = ? ORDER BY detected_at DESC LIMIT 10`,
        [guildId]
    );

    if (rows.length === 0) {
        return await interaction.reply({
            content: 'No raid incidents recorded for this server.',
            ephemeral: true
        });
    }

    const incidents = rows.map((r, i) => {
        const date = new Date(r.detected_at).toLocaleString();
        const status = r.resolved_at ? '✅ Resolved' : '🔴 Active';
        return `**${i + 1}.** ${status} | ${date}\n└ ${r.join_count} joins (${r.new_account_count} new accounts) | Action: ${r.action_taken}`;
    }).join('\n\n');

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle('📋 Raid Incident History')
        .setDescription(incidents)
        .setFooter({ text: `Showing last ${rows.length} incidents` });

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleResolve(interaction, guildId) {
    const manager = interaction.client.raidDetectionManager;

    if (!manager) {
        return await interaction.reply({
            content: 'Raid detection manager not initialized.',
            ephemeral: true
        });
    }

    const activeRaid = manager.activeRaids.get(guildId);

    if (!activeRaid) {
        return await interaction.reply({
            content: 'No active raid to resolve.',
            ephemeral: true
        });
    }

    // Update incident in database
    if (activeRaid.incidentId) {
        await pool.execute(
            `UPDATE raid_incidents SET resolved_at = NOW(), resolved_by = ? WHERE id = ?`,
            [interaction.user.id, activeRaid.incidentId]
        );
    }

    // Clear active raid
    manager.activeRaids.delete(guildId);

    await interaction.reply({
        content: `✅ **Raid Resolved**\n\nThe active raid incident has been marked as resolved.\nAffected users: ${activeRaid.affectedUsers.length}`,
        ephemeral: true
    });

    logger.info('[RaidProtection] Manually resolved', { guildId, resolvedBy: interaction.user.id });
}
