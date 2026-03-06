import { EmbedBuilder } from 'discord.js';
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
            case 'whitelist':
                await handleWhitelist(interaction, guildId);
                break;
        }
    } catch (error) {
        logger.error('[AntiNuke Command] Error:', { error: error.message, stack: error.stack });

        const reply = { content: `Error: ${error.message}`, ephemeral: true };
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(reply);
        } else {
            await interaction.reply(reply);
        }
    }
}

// ENABLE
async function handleEnable(interaction, guildId) {
    await pool.execute(
        `INSERT INTO anti_nuke_config (guild_id, enabled) VALUES (?, TRUE)
         ON DUPLICATE KEY UPDATE enabled = TRUE`,
        [guildId]
    );

    await interaction.reply({
        content: '🛡️ **Anti-Nuke Protection Enabled**\n\nThe server is now protected against mass deletions, bans, and kicks.\n\nUse `/protection antinuke config` to customize thresholds and actions.',
        ephemeral: true
    });

    logger.info('[AntiNuke] Enabled', { guildId });
}

// DISABLE
async function handleDisable(interaction, guildId) {
    await pool.execute(
        `UPDATE anti_nuke_config SET enabled = FALSE WHERE guild_id = ?`,
        [guildId]
    );

    await interaction.reply({
        content: '⚠️ **Anti-Nuke Protection Disabled**\n\nThe server is no longer protected. Use `/protection antinuke enable` to re-enable protection.',
        ephemeral: true
    });

    logger.info('[AntiNuke] Disabled', { guildId });
}

// CONFIG
async function handleConfig(interaction, guildId) {
    const maxChannelDeletes = interaction.options.getInteger('max_channel_deletes');
    const maxRoleDeletes = interaction.options.getInteger('max_role_deletes');
    const maxBans = interaction.options.getInteger('max_bans');
    const action = interaction.options.getString('action');
    const alertChannel = interaction.options.getChannel('alert_channel');

    // Initialize config if not exists
    await pool.execute(
        `INSERT IGNORE INTO anti_nuke_config (guild_id) VALUES (?)`,
        [guildId]
    );

    // Build update query
    const updates = [];
    const values = [];

    if (maxChannelDeletes !== null) {
        updates.push('max_channel_deletes = ?');
        values.push(maxChannelDeletes);
    }
    if (maxRoleDeletes !== null) {
        updates.push('max_role_deletes = ?');
        values.push(maxRoleDeletes);
    }
    if (maxBans !== null) {
        updates.push('max_kick_bans = ?');
        values.push(maxBans);
    }
    if (action !== null) {
        updates.push('action_on_trigger = ?');
        values.push(action);
    }
    if (alertChannel !== null) {
        updates.push('alert_channel_id = ?');
        values.push(alertChannel.id);
    }

    if (updates.length === 0) {
        return await interaction.reply({
            content: 'Please specify at least one setting to configure!',
            ephemeral: true
        });
    }

    values.push(guildId);

    await pool.execute(
        `UPDATE anti_nuke_config SET ${updates.join(', ')} WHERE guild_id = ?`,
        values
    );

    const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('✅ Anti-Nuke Configuration Updated')
        .setDescription('The following settings have been updated:');

    if (maxChannelDeletes !== null) embed.addFields({ name: 'Max Channel Deletes', value: `${maxChannelDeletes}`, inline: true });
    if (maxRoleDeletes !== null) embed.addFields({ name: 'Max Role Deletes', value: `${maxRoleDeletes}`, inline: true });
    if (maxBans !== null) embed.addFields({ name: 'Max Bans/Kicks', value: `${maxBans}`, inline: true });
    if (action !== null) embed.addFields({ name: 'Action on Trigger', value: action.toUpperCase(), inline: true });
    if (alertChannel !== null) embed.addFields({ name: 'Alert Channel', value: `${alertChannel}`, inline: true });

    await interaction.reply({ embeds: [embed], ephemeral: true });

    logger.info('[AntiNuke] Config updated', { guildId, updates });
}

// STATUS
async function handleStatus(interaction, guildId) {
    const [rows] = await pool.execute(
        `SELECT * FROM anti_nuke_config WHERE guild_id = ?`,
        [guildId]
    );

    if (rows.length === 0 || !rows[0].enabled) {
        return await interaction.reply({
            content: '⚠️ Anti-Nuke protection is currently **disabled**.\n\nUse `/protection antinuke enable` to enable protection.',
            ephemeral: true
        });
    }

    const config = rows[0];
    const alertChannel = config.alert_channel_id
        ? await interaction.guild.channels.fetch(config.alert_channel_id).catch(() => 'Not set')
        : 'Not set';

    // Get whitelist count
    const [whitelistRows] = await pool.execute(
        `SELECT COUNT(*) as count FROM anti_nuke_whitelist WHERE guild_id = ?`,
        [guildId]
    );

    const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('🛡️ Anti-Nuke Protection Status')
        .setDescription('Current anti-nuke configuration:')
        .addFields(
            { name: 'Status', value: '✅ Enabled', inline: true },
            { name: 'Action on Trigger', value: config.action_on_trigger.toUpperCase(), inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Max Channel Deletes', value: `${config.max_channel_deletes}`, inline: true },
            { name: 'Max Role Deletes', value: `${config.max_role_deletes}`, inline: true },
            { name: 'Max Bans/Kicks', value: `${config.max_kick_bans}`, inline: true },
            { name: 'Alert Channel', value: typeof alertChannel === 'string' ? alertChannel : alertChannel.toString(), inline: true },
            { name: 'Whitelisted Users', value: `${whitelistRows[0].count}`, inline: true }
        )
        .setFooter({ text: 'Use /protection antinuke config to modify settings' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

// WHITELIST
async function handleWhitelist(interaction, guildId) {
    const action = interaction.options.getString('action');
    const user = interaction.options.getUser('user');

    if (action === 'list') {
        const [rows] = await pool.execute(
            `SELECT user_id FROM anti_nuke_whitelist WHERE guild_id = ?`,
            [guildId]
        );

        if (rows.length === 0) {
            return await interaction.reply({
                content: 'No users are currently whitelisted.',
                ephemeral: true
            });
        }

        const userList = [];
        for (const row of rows) {
            const member = await interaction.guild.members.fetch(row.user_id).catch(() => null);
            userList.push(member ? member.user.tag : `Unknown User (${row.user_id})`);
        }

        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle('📋 Anti-Nuke Whitelist')
            .setDescription(`**${rows.length}** whitelisted user${rows.length !== 1 ? 's' : ''}:\n\n${userList.join('\n')}`);

        return await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (!user) {
        return await interaction.reply({
            content: 'Please specify a user to add or remove!',
            ephemeral: true
        });
    }

    if (action === 'add') {
        await pool.execute(
            `INSERT IGNORE INTO anti_nuke_whitelist (guild_id, user_id) VALUES (?, ?)`,
            [guildId, user.id]
        );

        await interaction.reply({
            content: `✅ Added **${user.tag}** to the anti-nuke whitelist.\n\nThis user will not trigger anti-nuke protection.`,
            ephemeral: true
        });

        logger.info('[AntiNuke] Added to whitelist', { guildId, userId: user.id });

    } else if (action === 'remove') {
        const [result] = await pool.execute(
            `DELETE FROM anti_nuke_whitelist WHERE guild_id = ? AND user_id = ?`,
            [guildId, user.id]
        );

        if (result.affectedRows === 0) {
            return await interaction.reply({
                content: `**${user.tag}** is not on the whitelist.`,
                ephemeral: true
            });
        }

        await interaction.reply({
            content: `✅ Removed **${user.tag}** from the anti-nuke whitelist.`,
            ephemeral: true
        });

        logger.info('[AntiNuke] Removed from whitelist', { guildId, userId: user.id });
    }
}
