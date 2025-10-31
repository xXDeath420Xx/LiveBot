import type { Client } from 'discord.js';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import db from '../utils/db';
import logger from '../utils/logger';

interface BackupData {
    guildSettings: any | null;
    channelSettings: any[];
    automodRules: any[];
    automodHeatConfig: any | null;
    antiNukeConfig: any | null;
    joinGateConfig: any | null;
    welcomeSettings: any | null;
    customCommands: any[];
    ticketConfig: any | null;
    autoPublisherConfig: any | null;
    autorolesConfig: any | null;
    logConfig: any | null;
    redditFeeds: any[];
    youtubeFeeds: any[];
    twitterFeeds: any[];
    moderationConfig: any | null;
    escalationRules: any[];
    roleRewards: any[];
    tempChannelConfig: any | null;
    antiRaidConfig: any | null;
    tags: any[];
    starboardConfig: any | null;
    reactionRolePanels: any[];
    reactionRoleMappings: any[];
}

interface Backup extends RowDataPacket {
    id: number;
    guild_id: string;
    snapshot_name: string;
    backup_data: string;
    created_at: Date;
}

async function createBackup(guildId: string, snapshotName: string, client: Client): Promise<number> {
    logger.info(`Creating backup with name: ${snapshotName}`, { guildId, category: 'backup' });
    try {
        const [guildSettings] = await db.execute<RowDataPacket[]>('SELECT * FROM guilds WHERE guild_id = ?', [guildId]);
        const [channelSettings] = await db.execute<RowDataPacket[]>('SELECT * FROM channel_settings WHERE guild_id = ?', [guildId]);
        const [automodRules] = await db.execute<RowDataPacket[]>('SELECT * FROM automod_rules WHERE guild_id = ?', [guildId]);
        const [automodHeatConfig] = await db.execute<RowDataPacket[]>('SELECT * FROM automod_heat_config WHERE guild_id = ?', [guildId]);
        const [antiNukeConfig] = await db.execute<RowDataPacket[]>('SELECT * FROM antinuke_config WHERE guild_id = ?', [guildId]);
        const [joinGateConfig] = await db.execute<RowDataPacket[]>('SELECT * FROM join_gate_config WHERE guild_id = ?', [guildId]);
        const [welcomeSettings] = await db.execute<RowDataPacket[]>('SELECT * FROM welcome_settings WHERE guild_id = ?', [guildId]);
        const [customCommands] = await db.execute<RowDataPacket[]>('SELECT * FROM custom_commands WHERE guild_id = ?', [guildId]);
        const [ticketConfig] = await db.execute<RowDataPacket[]>('SELECT * FROM ticket_config WHERE guild_id = ?', [guildId]);
        const [autoPublisherConfig] = await db.execute<RowDataPacket[]>('SELECT * FROM auto_publisher_config WHERE guild_id = ?', [guildId]);
        const [autorolesConfig] = await db.execute<RowDataPacket[]>('SELECT * FROM autoroles_config WHERE guild_id = ?', [guildId]);
        const [logConfig] = await db.execute<RowDataPacket[]>('SELECT * FROM log_config WHERE guild_id = ?', [guildId]);
        const [redditFeeds] = await db.execute<RowDataPacket[]>('SELECT * FROM reddit_feeds WHERE guild_id = ?', [guildId]);
        const [youtubeFeeds] = await db.execute<RowDataPacket[]>('SELECT * FROM youtube_feeds WHERE guild_id = ?', [guildId]);
        const [twitterFeeds] = await db.execute<RowDataPacket[]>('SELECT * FROM twitter_feeds WHERE guild_id = ?', [guildId]);
        const [moderationConfig] = await db.execute<RowDataPacket[]>('SELECT * FROM moderation_config WHERE guild_id = ?', [guildId]);
        const [escalationRules] = await db.execute<RowDataPacket[]>('SELECT * FROM escalation_rules WHERE guild_id = ?', [guildId]);
        const [roleRewards] = await db.execute<RowDataPacket[]>('SELECT * FROM role_rewards WHERE guild_id = ?', [guildId]);
        const [tempChannelConfig] = await db.execute<RowDataPacket[]>('SELECT * FROM temp_channel_config WHERE guild_id = ?', [guildId]);
        const [antiRaidConfig] = await db.execute<RowDataPacket[]>('SELECT * FROM anti_raid_config WHERE guild_id = ?', [guildId]);
        const [tags] = await db.execute<RowDataPacket[]>('SELECT * FROM tags WHERE guild_id = ?', [guildId]);
        const [starboardConfig] = await db.execute<RowDataPacket[]>('SELECT * FROM starboard_config WHERE guild_id = ?', [guildId]);
        const [reactionRolePanels] = await db.execute<RowDataPacket[]>('SELECT * FROM reaction_role_panels WHERE guild_id = ?', [guildId]);
        const [reactionRoleMappings] = await db.execute<RowDataPacket[]>('SELECT rrm.* FROM reaction_role_mappings rrm JOIN reaction_role_panels rrp ON rrm.panel_id = rrp.id WHERE rrp.guild_id = ?', [guildId]);

        const backupData: BackupData = {
            guildSettings: guildSettings[0] || null,
            channelSettings,
            automodRules,
            automodHeatConfig: automodHeatConfig[0] || null,
            antiNukeConfig: antiNukeConfig[0] || null,
            joinGateConfig: joinGateConfig[0] || null,
            welcomeSettings: welcomeSettings[0] || null,
            customCommands,
            ticketConfig: ticketConfig[0] || null,
            autoPublisherConfig: autoPublisherConfig[0] || null,
            autorolesConfig: autorolesConfig[0] || null,
            logConfig: logConfig[0] || null,
            redditFeeds,
            youtubeFeeds,
            twitterFeeds,
            moderationConfig: moderationConfig[0] || null,
            escalationRules,
            roleRewards,
            tempChannelConfig: tempChannelConfig[0] || null,
            antiRaidConfig: antiRaidConfig[0] || null,
            tags,
            starboardConfig: starboardConfig[0] || null,
            reactionRolePanels,
            reactionRoleMappings
        };

        const [result] = await db.execute<ResultSetHeader>(
            'INSERT INTO server_backups (guild_id, snapshot_name, backup_data) VALUES (?, ?, ?)',
            [guildId, snapshotName, JSON.stringify(backupData)]
        );
        logger.info(`Backup ${result.insertId} created successfully.`, { guildId, category: 'backup' });
        return result.insertId;
    } catch (error: any) {
        logger.error('Error creating backup.', { guildId, category: 'backup', error: error.stack });
        throw error;
    }
}

async function restoreBackup(backupId: number, client: Client): Promise<void> {
    let guildId = 'unknown';
    try {
        const [[backup]] = await db.execute<Backup[]>('SELECT * FROM server_backups WHERE id = ?', [backupId]);
        if (!backup) {
            throw new Error('Backup not found.');
        }
        guildId = backup.guild_id;
        logger.info(`Restoring backup ${backupId}.`, { guildId, category: 'backup' });

        const backupData: BackupData = JSON.parse(backup.backup_data);

        // Clear existing configurations for the guild
        await db.execute('DELETE FROM channel_settings WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM automod_rules WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM automod_heat_config WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM antinuke_config WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM join_gate_config WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM welcome_settings WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM custom_commands WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM ticket_config WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM auto_publisher_config WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM autoroles_config WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM log_config WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM reddit_feeds WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM youtube_feeds WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM twitter_feeds WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM moderation_config WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM escalation_rules WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM role_rewards WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM temp_channel_config WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM anti_raid_config WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM tags WHERE guild_id = ?', [guildId]);
        await db.execute('DELETE FROM starboard_config WHERE guild_id = ?', [guildId]);

        // Special handling for reaction roles as mappings depend on panels
        const [existingPanels] = await db.execute<RowDataPacket[]>('SELECT id FROM reaction_role_panels WHERE guild_id = ?', [guildId]);
        if (existingPanels.length > 0) {
            const panelIds = existingPanels.map((p: any) => p.id);
            await db.execute(`DELETE FROM reaction_role_mappings WHERE panel_id IN (?)`, [panelIds]);
            await db.execute('DELETE FROM reaction_role_panels WHERE guild_id = ?', [guildId]);
        }

        // Restore data
        if (backupData.guildSettings) {
            await db.execute(
                `INSERT INTO guilds (guild_id, welcome_message, welcome_channel_id, sticky_roles_enabled, leveling_enabled, leveling_xp_rate, leveling_xp_cooldown, leveling_ignored_channels, leveling_ignored_roles, panic_mode_enabled)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                                      welcome_message = VALUES(welcome_message),
                                      welcome_channel_id = VALUES(welcome_channel_id),
                                      sticky_roles_enabled = VALUES(sticky_roles_enabled),
                                      leveling_enabled = VALUES(leveling_enabled),
                                      leveling_xp_rate = VALUES(leveling_xp_rate),
                                      leveling_xp_cooldown = VALUES(leveling_xp_cooldown),
                                      leveling_ignored_channels = VALUES(leveling_ignored_channels),
                                      leveling_ignored_roles = VALUES(leveling_ignored_roles),
                                      panic_mode_enabled = VALUES(panic_mode_enabled)`,
                [
                    guildId, backupData.guildSettings.welcome_message, backupData.guildSettings.welcome_channel_id,
                    backupData.guildSettings.sticky_roles_enabled, backupData.guildSettings.leveling_enabled,
                    backupData.guildSettings.leveling_xp_rate, backupData.guildSettings.leveling_xp_cooldown,
                    backupData.guildSettings.leveling_ignored_channels, backupData.guildSettings.leveling_ignored_roles,
                    backupData.guildSettings.panic_mode_enabled
                ]
            );
        }

        for (const setting of backupData.channelSettings) {
            await db.execute('INSERT INTO channel_settings (guild_id, channel_id, setting_key, setting_value) VALUES (?, ?, ?, ?)', [guildId, setting.channel_id, setting.setting_key, setting.setting_value]);
        }

        for (const rule of backupData.automodRules) {
            await db.execute('INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes) VALUES (?, ?, ?, ?, ?)', [guildId, rule.filter_type, rule.config, rule.action, rule.action_duration_minutes]);
        }

        if (backupData.automodHeatConfig) {
            await db.execute(
                `INSERT INTO automod_heat_config (guild_id, heat_threshold, heat_decay_rate, action, action_duration_minutes, is_enabled)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                                      heat_threshold = VALUES(heat_threshold),
                                      heat_decay_rate = VALUES(heat_decay_rate),
                                      action = VALUES(action),
                                      action_duration_minutes = VALUES(action_duration_minutes),
                                      is_enabled = VALUES(is_enabled)`,
                [
                    guildId, backupData.automodHeatConfig.heat_threshold, backupData.automodHeatConfig.heat_decay_rate,
                    backupData.automodHeatConfig.action, backupData.automodHeatConfig.action_duration_minutes,
                    backupData.automodHeatConfig.is_enabled
                ]
            );
        }

        if (backupData.antiNukeConfig) {
            await db.execute(
                `INSERT INTO antinuke_config (guild_id, is_enabled, action, channel_threshold, role_threshold, ban_kick_threshold)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                                      is_enabled = VALUES(is_enabled),
                                      action = VALUES(action),
                                      channel_threshold = VALUES(channel_threshold),
                                      role_threshold = VALUES(role_threshold),
                                      ban_kick_threshold = VALUES(ban_kick_threshold)`,
                [
                    guildId, backupData.antiNukeConfig.is_enabled, backupData.antiNukeConfig.action,
                    backupData.antiNukeConfig.channel_threshold, backupData.antiNukeConfig.role_threshold,
                    backupData.antiNukeConfig.ban_kick_threshold
                ]
            );
        }

        if (backupData.joinGateConfig) {
            await db.execute(
                `INSERT INTO join_gate_config (guild_id, is_enabled, action, action_duration_minutes, min_account_age_days, block_default_avatar, verification_enabled, verification_role_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                                      is_enabled = VALUES(is_enabled), action = VALUES(action), action_duration_minutes = VALUES(action_duration_minutes),
                                      min_account_age_days = VALUES(min_account_age_days), block_default_avatar = VALUES(block_default_avatar),
                                      verification_enabled = VALUES(verification_enabled), verification_role_id = VALUES(verification_role_id)`,
                [
                    guildId, backupData.joinGateConfig.is_enabled, backupData.joinGateConfig.action,
                    backupData.joinGateConfig.action_duration_minutes, backupData.joinGateConfig.min_account_age_days,
                    backupData.joinGateConfig.block_default_avatar, backupData.joinGateConfig.verification_enabled,
                    backupData.joinGateConfig.verification_role_id
                ]
            );
        }

        if (backupData.welcomeSettings) {
            await db.execute(
                `INSERT INTO welcome_settings (guild_id, channel_id, message, card_enabled, card_background_url, card_title_text, card_subtitle_text, card_title_color, card_username_color, card_subtitle_color, goodbye_enabled, goodbye_channel_id, goodbye_message)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                                      channel_id=VALUES(channel_id), message=VALUES(message), card_enabled=VALUES(card_enabled),
                                      card_background_url=VALUES(card_background_url), card_title_text=VALUES(card_title_text),
                                      card_subtitle_text=VALUES(card_subtitle_text), card_title_color=VALUES(card_title_color),
                                      card_username_color=VALUES(card_username_color), card_subtitle_color=VALUES(card_subtitle_color),
                                      goodbye_enabled=VALUES(goodbye_enabled), goodbye_channel_id=VALUES(goodbye_channel_id), goodbye_message=VALUES(goodbye_message)`,
                [
                    guildId, backupData.welcomeSettings.channel_id, backupData.welcomeSettings.message,
                    backupData.welcomeSettings.card_enabled, backupData.welcomeSettings.card_background_url,
                    backupData.welcomeSettings.card_title_text, backupData.welcomeSettings.card_subtitle_text,
                    backupData.welcomeSettings.card_title_color, backupData.welcomeSettings.card_username_color,
                    backupData.welcomeSettings.card_subtitle_color, backupData.welcomeSettings.goodbye_enabled,
                    backupData.welcomeSettings.goodbye_channel_id, backupData.welcomeSettings.goodbye_message
                ]
            );
        }

        for (const command of backupData.customCommands) {
            await db.execute('INSERT INTO custom_commands (guild_id, command_name, response, action_type, action_content) VALUES (?, ?, ?, ?, ?)', [guildId, command.command_name, command.response, command.action_type, command.action_content]);
        }

        if (backupData.ticketConfig) {
            await db.execute(
                `INSERT INTO ticket_config (guild_id, panel_channel_id, ticket_category_id, support_role_id)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                                      panel_channel_id = VALUES(panel_channel_id),
                                      ticket_category_id = VALUES(ticket_category_id),
                                      support_role_id = VALUES(support_role_id)`,
                [guildId, backupData.ticketConfig.panel_channel_id, backupData.ticketConfig.ticket_category_id, backupData.ticketConfig.support_role_id]
            );
        }

        if (backupData.autoPublisherConfig) {
            await db.execute(
                'INSERT INTO auto_publisher_config (guild_id, is_enabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled)',
                [guildId, backupData.autoPublisherConfig.is_enabled]
            );
        }

        if (backupData.autorolesConfig) {
            await db.execute(
                'INSERT INTO autoroles_config (guild_id, is_enabled, roles_to_assign) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), roles_to_assign = VALUES(roles_to_assign)',
                [guildId, backupData.autorolesConfig.is_enabled, backupData.autorolesConfig.roles_to_assign]
            );
        }

        if (backupData.logConfig) {
            await db.execute(
                'INSERT INTO log_config (guild_id, log_channel_id, enabled_logs) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id), enabled_logs = VALUES(enabled_logs)',
                [guildId, backupData.logConfig.log_channel_id, backupData.logConfig.enabled_logs]
            );
        }

        for (const feed of backupData.redditFeeds) {
            await db.execute('INSERT INTO reddit_feeds (guild_id, subreddit, channel_id) VALUES (?, ?, ?)', [guildId, feed.subreddit, feed.channel_id]);
        }

        for (const feed of backupData.youtubeFeeds) {
            await db.execute('INSERT INTO youtube_feeds (guild_id, youtube_channel_id, discord_channel_id) VALUES (?, ?, ?)', [guildId, feed.youtube_channel_id, feed.discord_channel_id]);
        }

        for (const feed of backupData.twitterFeeds) {
            await db.execute('INSERT INTO twitter_feeds (guild_id, twitter_username, channel_id) VALUES (?, ?, ?)', [guildId, feed.twitter_username, feed.channel_id]);
        }

        if (backupData.moderationConfig) {
            await db.execute(
                'INSERT INTO moderation_config (guild_id, mod_log_channel_id, muted_role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE mod_log_channel_id = VALUES(mod_log_channel_id), muted_role_id = VALUES(muted_role_id)',
                [guildId, backupData.moderationConfig.mod_log_channel_id, backupData.moderationConfig.muted_role_id]
            );
        }

        for (const rule of backupData.escalationRules) {
            await db.execute('INSERT INTO escalation_rules (guild_id, infraction_count, time_period_hours, action, action_duration_minutes) VALUES (?, ?, ?, ?, ?)', [guildId, rule.infraction_count, rule.time_period_hours, rule.action, rule.action_duration_minutes]);
        }

        for (const reward of backupData.roleRewards) {
            await db.execute('INSERT INTO role_rewards (guild_id, level, role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)', [guildId, reward.level, reward.role_id]);
        }

        if (backupData.tempChannelConfig) {
            await db.execute(
                'INSERT INTO temp_channel_config (guild_id, creator_channel_id, category_id, naming_template) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE creator_channel_id = VALUES(creator_channel_id), category_id = VALUES(category_id), naming_template = VALUES(naming_template)',
                [guildId, backupData.tempChannelConfig.creator_channel_id, backupData.tempChannelConfig.category_id, backupData.tempChannelConfig.naming_template]
            );
        }

        if (backupData.antiRaidConfig) {
            await db.execute(
                'INSERT INTO anti_raid_config (guild_id, join_limit, time_period_seconds, action, is_enabled) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE join_limit = VALUES(join_limit), time_period_seconds = VALUES(time_period_seconds), action = VALUES(action), is_enabled = VALUES(is_enabled)',
                [guildId, backupData.antiRaidConfig.join_limit, backupData.antiRaidConfig.time_period_seconds, backupData.antiRaidConfig.action, backupData.antiRaidConfig.is_enabled]
            );
        }

        for (const tag of backupData.tags) {
            await db.execute('INSERT INTO tags (guild_id, tag_name, tag_content, creator_id) VALUES (?, ?, ?, ?)', [guildId, tag.tag_name, tag.tag_content, tag.creator_id]);
        }

        if (backupData.starboardConfig) {
            await db.execute(
                'INSERT INTO starboard_config (guild_id, channel_id, star_threshold) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), star_threshold = VALUES(star_threshold)',
                [guildId, backupData.starboardConfig.channel_id, backupData.starboardConfig.star_threshold]
            );
        }

        for (const panel of backupData.reactionRolePanels) {
            const [result] = await db.execute<ResultSetHeader>('INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, panel_mode) VALUES (?, ?, ?, ?, ?)', [guildId, panel.channel_id, panel.message_id, panel.panel_name, panel.panel_mode]);
            const newPanelId = result.insertId;
            const panelMappings = backupData.reactionRoleMappings.filter((m: any) => m.panel_id === panel.id);
            for (const mapping of panelMappings) {
                await db.execute('INSERT INTO reaction_role_mappings (panel_id, emoji_id, role_id) VALUES (?, ?, ?)', [newPanelId, mapping.emoji_id, mapping.role_id]);
            }
        }

        logger.info(`Backup ${backupId} restored successfully.`, { guildId, category: 'backup' });
    } catch (error: any) {
        logger.error(`Error restoring backup ${backupId}.`, { guildId, category: 'backup', error: error.stack });
        throw error;
    }
}

async function deleteBackup(backupId: number): Promise<void> {
    let guildId = 'unknown';
    try {
        const [[backup]] = await db.execute<Backup[]>('SELECT guild_id FROM server_backups WHERE id = ?', [backupId]);
        if (backup) {
            guildId = backup.guild_id;
        }
        await db.execute('DELETE FROM server_backups WHERE id = ?', [backupId]);
        logger.info(`Backup ${backupId} deleted successfully.`, { guildId, category: 'backup' });
    } catch (error: any) {
        logger.error(`Error deleting backup ${backupId}.`, { guildId, category: 'backup', error: error.stack });
        throw error;
    }
}

export { createBackup, restoreBackup, deleteBackup };
