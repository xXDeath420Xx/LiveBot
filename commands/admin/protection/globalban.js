import { EmbedBuilder } from 'discord.js';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import configCache from '../../../utils/configCache.js';

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
    }
}

async function handleEnable(interaction, guildId) {
    await pool.execute(
        `INSERT INTO global_ban_config (guild_id, enabled) VALUES (?, TRUE)
         ON DUPLICATE KEY UPDATE enabled = TRUE`,
        [guildId]
    );

    configCache.invalidate('global_ban_config', guildId);

    await interaction.reply({
        content: '**Global Ban Protection Enabled**\n\nThis server now participates in the shared global ban database.\n\n**Defaults:**\n\u2022 Critical/High severity: Auto-ban\n\u2022 Medium severity: Auto-kick\n\u2022 Low severity: Alert only\n\u2022 Check on join: Enabled\n\nUse `/protection globalban config` to customize actions and set an alert channel.',
        ephemeral: true
    });

    logger.info('[GlobalBan] Enabled', { guildId });
}

async function handleDisable(interaction, guildId) {
    await pool.execute(
        `UPDATE global_ban_config SET enabled = FALSE WHERE guild_id = ?`,
        [guildId]
    );

    configCache.invalidate('global_ban_config', guildId);

    await interaction.reply({
        content: '**Global Ban Protection Disabled**\n\nThis server will no longer enforce global bans. Existing moderation actions still contribute to the shared database.',
        ephemeral: true
    });

    logger.info('[GlobalBan] Disabled', { guildId });
}

async function handleConfig(interaction, guildId) {
    const actionCritical = interaction.options.getString('action_critical');
    const actionHigh = interaction.options.getString('action_high');
    const actionMedium = interaction.options.getString('action_medium');
    const actionLow = interaction.options.getString('action_low');
    const alertChannel = interaction.options.getChannel('alert_channel');
    const checkOnMessage = interaction.options.getBoolean('check_on_message');
    const autoAggregate = interaction.options.getBoolean('auto_aggregate');

    // Ensure row exists
    await pool.execute(
        `INSERT IGNORE INTO global_ban_config (guild_id) VALUES (?)`,
        [guildId]
    );

    const updates = [];
    const values = [];

    if (actionCritical !== null) { updates.push('action_critical = ?'); values.push(actionCritical); }
    if (actionHigh !== null) { updates.push('action_high = ?'); values.push(actionHigh); }
    if (actionMedium !== null) { updates.push('action_medium = ?'); values.push(actionMedium); }
    if (actionLow !== null) { updates.push('action_low = ?'); values.push(actionLow); }
    if (alertChannel !== null) { updates.push('alert_channel_id = ?'); values.push(alertChannel.id); }
    if (checkOnMessage !== null) { updates.push('check_on_message = ?'); values.push(checkOnMessage ? 1 : 0); }
    if (autoAggregate !== null) { updates.push('auto_aggregate_opt_in = ?'); values.push(autoAggregate ? 1 : 0); }

    if (updates.length === 0) {
        return await interaction.reply({ content: 'Please specify at least one setting to configure.', ephemeral: true });
    }

    values.push(guildId);
    await pool.execute(`UPDATE global_ban_config SET ${updates.join(', ')} WHERE guild_id = ?`, values);

    configCache.invalidate('global_ban_config', guildId);

    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('Global Ban Configuration Updated');

    if (actionCritical !== null) embed.addFields({ name: 'Critical Action', value: actionCritical.toUpperCase(), inline: true });
    if (actionHigh !== null) embed.addFields({ name: 'High Action', value: actionHigh.toUpperCase(), inline: true });
    if (actionMedium !== null) embed.addFields({ name: 'Medium Action', value: actionMedium.toUpperCase(), inline: true });
    if (actionLow !== null) embed.addFields({ name: 'Low Action', value: actionLow.toUpperCase(), inline: true });
    if (alertChannel !== null) embed.addFields({ name: 'Alert Channel', value: `${alertChannel}`, inline: true });
    if (checkOnMessage !== null) embed.addFields({ name: 'Check on Message', value: checkOnMessage ? 'Enabled' : 'Disabled', inline: true });
    if (autoAggregate !== null) embed.addFields({ name: 'Auto-Aggregate', value: autoAggregate ? 'Opted In' : 'Opted Out', inline: true });

    await interaction.reply({ embeds: [embed], ephemeral: true });
    logger.info('[GlobalBan] Config updated', { guildId, updates });
}

async function handleStatus(interaction, guildId) {
    const [rows] = await pool.execute(`SELECT * FROM global_ban_config WHERE guild_id = ?`, [guildId]);

    if (rows.length === 0 || !rows[0].enabled) {
        return await interaction.reply({
            content: 'Global Ban Protection is currently **disabled**.\n\nUse `/protection globalban enable` to enable.',
            ephemeral: true
        });
    }

    const config = rows[0];
    const alertChannel = config.alert_channel_id
        ? `<#${config.alert_channel_id}>`
        : 'Not set';

    const manager = interaction.client.globalBanManager;
    const cacheSize = manager ? manager.banCache.size : 0;

    const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('Global Ban Protection Status')
        .addFields(
            { name: 'Status', value: 'Enabled', inline: true },
            { name: 'Alert Channel', value: alertChannel, inline: true },
            { name: 'Ban Cache', value: `${cacheSize} entries`, inline: true },
            { name: 'Critical', value: (config.action_critical || 'ban').toUpperCase(), inline: true },
            { name: 'High', value: (config.action_high || 'ban').toUpperCase(), inline: true },
            { name: 'Medium', value: (config.action_medium || 'kick').toUpperCase(), inline: true },
            { name: 'Low', value: (config.action_low || 'alert').toUpperCase(), inline: true },
            { name: 'Check on Join', value: config.check_on_join ? 'Yes' : 'No', inline: true },
            { name: 'Check on Message', value: config.check_on_message ? 'Yes' : 'No', inline: true },
            { name: 'Auto-Aggregate', value: config.auto_aggregate_opt_in ? 'Opted In' : 'Opted Out', inline: true }
        )
        .setFooter({ text: 'Use /protection globalban config to modify settings' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}
