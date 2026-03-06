import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import configCache from '../utils/configCache.js';

/**
 * Raid Detection Manager - Detects and responds to coordinated mass-join attacks
 * Inspired by Sery Bot's hate raid protection
 */
class RaidDetectionManager {
    constructor(client) {
        this.client = client;

        // Max sizes to prevent unbounded growth
        this.MAX_GUILDS_TRACKED = 500;
        this.MAX_JOINS_PER_GUILD = 1000;

        // Track joins per guild
        // Format: Map<guildId, Array<{ userId, timestamp, accountAge, accountCreated }>>
        this.joinTracker = new Map();

        // Track active raids
        // Format: Map<guildId, { startTime, incidentId, affectedUsers: [], status: 'active'|'resolved' }>
        this.activeRaids = new Map();

        // Clean up old join entries every 30 seconds
        this.cleanupInterval = setInterval(() => this.cleanupOldJoins(), 30000);

        logger.info('[RaidDetection] Manager initialized');
    }

    /**
     * Stop the manager and cleanup (call on shutdown)
     */
    stop() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.joinTracker.clear();
        this.activeRaids.clear();
        logger.info('[RaidDetection] Manager stopped and cleaned up');
    }

    /**
     * Track a member join and check for raid conditions
     * @param {GuildMember} member - The member who joined
     */
    async trackJoin(member) {
        const { guild, user } = member;

        try {
            // Get config
            const config = await this.getConfig(guild.id);
            if (!config || !config.enabled) return;

            // Check if user has whitelisted role (returning member with role)
            if (config.whitelist_roles) {
                const whitelistRoles = JSON.parse(config.whitelist_roles || '[]');
                if (member.roles.cache.some(role => whitelistRoles.includes(role.id))) {
                    return;
                }
            }

            // Calculate account age in hours
            const accountAgeMs = Date.now() - user.createdTimestamp;
            const accountAgeHours = accountAgeMs / (1000 * 60 * 60);

            // Track this join
            this.addJoin(guild.id, {
                userId: user.id,
                timestamp: Date.now(),
                accountAgeHours,
                accountCreated: user.createdTimestamp
            });

            // Check for raid conditions
            await this.checkRaidConditions(guild, config);

        } catch (error) {
            logger.error('[RaidDetection] Error tracking join', {
                error: error.message,
                guildId: guild.id,
                userId: user.id
            });
        }
    }

    /**
     * Add a join to the tracker (with max size enforcement)
     */
    addJoin(guildId, joinData) {
        if (!this.joinTracker.has(guildId)) {
            // Enforce max guilds tracked
            if (this.joinTracker.size >= this.MAX_GUILDS_TRACKED) {
                const oldestKey = this.joinTracker.keys().next().value;
                this.joinTracker.delete(oldestKey);
            }
            this.joinTracker.set(guildId, []);
        }
        const joins = this.joinTracker.get(guildId);
        joins.push(joinData);
        // Enforce max joins per guild
        if (joins.length > this.MAX_JOINS_PER_GUILD) {
            joins.shift();
        }
    }

    /**
     * Get recent joins within the configured timeframe
     */
    getRecentJoins(guildId, timeframeSec) {
        const joins = this.joinTracker.get(guildId) || [];
        const cutoff = Date.now() - (timeframeSec * 1000);
        return joins.filter(join => join.timestamp >= cutoff);
    }

    /**
     * Check if raid conditions are met
     */
    async checkRaidConditions(guild, config) {
        const recentJoins = this.getRecentJoins(guild.id, config.join_timeframe_seconds);

        // Not enough joins to trigger
        if (recentJoins.length < config.join_threshold) return;

        // Calculate ratio of new accounts
        const newAccountCount = recentJoins.filter(
            join => join.accountAgeHours < config.new_account_age_hours
        ).length;
        const newAccountRatio = newAccountCount / recentJoins.length;

        // Check if ratio exceeds threshold
        if (newAccountRatio < config.new_account_ratio) return;

        // Already in an active raid?
        if (this.activeRaids.has(guild.id)) {
            const activeRaid = this.activeRaids.get(guild.id);
            if (activeRaid.status === 'active') {
                // Add new users to the existing raid
                const newUsers = recentJoins
                    .filter(j => !activeRaid.affectedUsers.includes(j.userId))
                    .map(j => j.userId);
                activeRaid.affectedUsers.push(...newUsers);
                return;
            }
        }

        // Trigger raid response
        await this.triggerRaidResponse(guild, config, recentJoins, newAccountCount);
    }

    /**
     * Trigger raid response actions
     */
    async triggerRaidResponse(guild, config, recentJoins, newAccountCount) {
        const affectedUserIds = recentJoins.map(j => j.userId);

        logger.warn('[RaidDetection] Raid detected!', {
            guildId: guild.id,
            joinCount: recentJoins.length,
            newAccountCount,
            affectedUsers: affectedUserIds
        });

        // Create incident record
        const incidentId = await this.createIncident(guild.id, recentJoins.length, newAccountCount, config.action);

        // Track active raid
        this.activeRaids.set(guild.id, {
            startTime: Date.now(),
            incidentId,
            affectedUsers: affectedUserIds,
            status: 'active'
        });

        // Execute actions on affected users
        const actionResults = await this.executeRaidActions(guild, config, affectedUserIds);

        // Send alert with action buttons
        await this.sendRaidAlert(guild, config, recentJoins, newAccountCount, incidentId, actionResults);

        // Clear the join tracker for this guild to prevent re-triggering
        this.joinTracker.set(guild.id, []);
    }

    /**
     * Execute raid response actions on affected users
     */
    async executeRaidActions(guild, config, userIds) {
        const results = {
            muted: 0,
            kicked: 0,
            banned: 0,
            purged: 0,
            failed: 0
        };

        for (const userId of userIds) {
            try {
                const member = await guild.members.fetch(userId).catch(() => null);
                if (!member) {
                    results.failed++;
                    continue;
                }

                // Skip guild owner
                if (member.id === guild.ownerId) continue;

                // Purge messages if enabled
                if (config.purge_messages) {
                    const purged = await this.purgeUserMessages(guild, userId, config.purge_limit);
                    results.purged += purged;
                }

                // Execute configured action
                switch (config.action) {
                    case 'mute':
                        if (member.moderatable) {
                            await member.timeout(
                                config.mute_duration_minutes * 60 * 1000,
                                'Raid Detection: Suspicious join pattern'
                            );
                            results.muted++;
                            await this.logInfractionForRaid(guild, member.user, 'mute', config.mute_duration_minutes);
                        }
                        break;

                    case 'kick':
                        if (member.kickable) {
                            await member.kick('Raid Detection: Suspicious join pattern');
                            results.kicked++;
                            await this.logInfractionForRaid(guild, member.user, 'kick');
                        }
                        break;

                    case 'ban':
                        if (member.bannable) {
                            await member.ban({
                                reason: 'Raid Detection: Suspicious join pattern',
                                deleteMessageSeconds: 86400
                            });
                            results.banned++;
                            await this.logInfractionForRaid(guild, member.user, 'ban');
                        }
                        break;

                    case 'lockdown':
                        // For lockdown, we mute the users but also enable server verification
                        if (member.moderatable) {
                            await member.timeout(
                                config.lockdown_duration_minutes * 60 * 1000,
                                'Raid Detection: Server lockdown'
                            );
                            results.muted++;
                        }
                        break;

                    case 'alert':
                        // Alert only, no action on users
                        break;
                }

            } catch (error) {
                logger.error('[RaidDetection] Error executing action on user', {
                    error: error.message,
                    userId,
                    guildId: guild.id
                });
                results.failed++;
            }
        }

        return results;
    }

    /**
     * Purge recent messages from a user across all channels
     */
    async purgeUserMessages(guild, userId, limit) {
        let totalPurged = 0;

        try {
            const textChannels = guild.channels.cache.filter(
                ch => ch.isTextBased() && !ch.isThread() && ch.viewable
            );

            for (const [, channel] of textChannels) {
                try {
                    const messages = await channel.messages.fetch({ limit: 100 });
                    const userMessages = messages.filter(
                        m => m.author.id === userId &&
                        Date.now() - m.createdTimestamp < 86400000 // Within 24 hours
                    );

                    if (userMessages.size > 0) {
                        const toDelete = userMessages.first(Math.min(userMessages.size, limit - totalPurged));
                        if (toDelete.length > 0) {
                            await channel.bulkDelete(toDelete, true).catch(() => {});
                            totalPurged += toDelete.length;
                        }
                    }

                    if (totalPurged >= limit) break;
                } catch {
                    // Skip channels we can't access
                }
            }
        } catch (error) {
            logger.error('[RaidDetection] Error purging messages', {
                error: error.message,
                userId,
                guildId: guild.id
            });
        }

        return totalPurged;
    }

    /**
     * Log an infraction for raid-related actions
     */
    async logInfractionForRaid(guild, user, actionType, durationMinutes = null) {
        try {
            const expiresAt = durationMinutes ? new Date(Date.now() + durationMinutes * 60000) : null;

            await pool.execute(
                `INSERT INTO infractions (guild_id, user_id, moderator_id, type, reason, duration_minutes, expires_at)
                 VALUES (?, ?, ?, 'RaidDetection', ?, ?, ?)`,
                [
                    guild.id,
                    user.id,
                    this.client.user.id,
                    `Automatic raid detection: ${actionType}`,
                    durationMinutes,
                    expiresAt
                ]
            );

            // Trigger escalation check
            const { checkEscalations } = await import('./escalation-manager.js');
            await checkEscalations(guild, user);

        } catch (error) {
            logger.error('[RaidDetection] Error logging infraction', {
                error: error.message,
                userId: user.id
            });
        }
    }

    /**
     * Create a raid incident record
     */
    async createIncident(guildId, joinCount, newAccountCount, actionTaken) {
        try {
            const [result] = await pool.execute(
                `INSERT INTO raid_incidents (guild_id, join_count, new_account_count, action_taken, affected_users)
                 VALUES (?, ?, ?, ?, ?)`,
                [guildId, joinCount, newAccountCount, actionTaken, JSON.stringify([])]
            );
            return result.insertId;
        } catch (error) {
            logger.error('[RaidDetection] Error creating incident', { error: error.message });
            return null;
        }
    }

    /**
     * Send raid alert with action buttons
     */
    async sendRaidAlert(guild, config, recentJoins, newAccountCount, incidentId, actionResults) {
        if (!config.alert_channel_id) return;

        const channel = await guild.channels.fetch(config.alert_channel_id).catch(() => null);
        if (!channel) return;

        const actionDescriptions = {
            'alert': 'Alert Only (No automatic action)',
            'mute': `Muted ${actionResults.muted} users`,
            'kick': `Kicked ${actionResults.kicked} users`,
            'ban': `Banned ${actionResults.banned} users`,
            'lockdown': `Lockdown: Muted ${actionResults.muted} users`
        };

        // List affected users (limit to first 10)
        const affectedList = recentJoins
            .slice(0, 10)
            .map(j => {
                const ageStr = j.accountAgeHours < 1
                    ? `${Math.round(j.accountAgeHours * 60)}m`
                    : j.accountAgeHours < 24
                        ? `${Math.round(j.accountAgeHours)}h`
                        : `${Math.round(j.accountAgeHours / 24)}d`;
                return `<@${j.userId}> (Account: ${ageStr} old)`;
            })
            .join('\n');

        const embed = new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle('🚨 RAID DETECTED')
            .setDescription(`A coordinated join raid has been detected and automatic actions have been taken.`)
            .addFields(
                { name: 'Joins Detected', value: `${recentJoins.length}`, inline: true },
                { name: 'New Accounts', value: `${newAccountCount} (${Math.round(newAccountCount / recentJoins.length * 100)}%)`, inline: true },
                { name: 'Timeframe', value: `${config.join_timeframe_seconds}s`, inline: true },
                { name: 'Action Taken', value: actionDescriptions[config.action] || config.action, inline: false },
                { name: 'Messages Purged', value: `${actionResults.purged}`, inline: true },
                { name: 'Failed Actions', value: `${actionResults.failed}`, inline: true },
                { name: 'Affected Users', value: affectedList || 'None', inline: false }
            )
            .setTimestamp()
            .setFooter({ text: `Incident ID: ${incidentId} | Raid Detection System` });

        if (recentJoins.length > 10) {
            embed.addFields({
                name: '\u200b',
                value: `*...and ${recentJoins.length - 10} more users*`
            });
        }

        // Create action buttons
        const buttons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`raid_kick_all_${incidentId}`)
                    .setLabel('Kick All')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('👢'),
                new ButtonBuilder()
                    .setCustomId(`raid_ban_all_${incidentId}`)
                    .setLabel('Ban All')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🔨'),
                new ButtonBuilder()
                    .setCustomId(`raid_false_positive_${incidentId}`)
                    .setLabel('False Positive')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('↩️'),
                new ButtonBuilder()
                    .setCustomId(`raid_resolve_${incidentId}`)
                    .setLabel('Resolve')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('✅')
            );

        await channel.send({ embeds: [embed], components: [buttons] }).catch(err =>
            logger.error('[RaidDetection] Error sending alert', { error: err.message })
        );
    }

    /**
     * Handle button interactions for raid alerts
     */
    async handleButtonInteraction(interaction) {
        const [action, ...rest] = interaction.customId.split('_').slice(1);
        const incidentId = rest.pop();

        // Check permissions
        if (!interaction.member.permissions.has('ModerateMembers')) {
            return interaction.reply({
                content: 'You need the Moderate Members permission to use these controls.',
                ephemeral: true
            });
        }

        const activeRaid = this.activeRaids.get(interaction.guild.id);

        switch (action) {
            case 'kick':
                await this.escalateRaidAction(interaction, incidentId, 'kick');
                break;

            case 'ban':
                await this.escalateRaidAction(interaction, incidentId, 'ban');
                break;

            case 'false':
                await this.handleFalsePositive(interaction, incidentId);
                break;

            case 'resolve':
                await this.resolveRaid(interaction, incidentId);
                break;
        }
    }

    /**
     * Escalate raid action to kick/ban all affected users
     */
    async escalateRaidAction(interaction, incidentId, actionType) {
        await interaction.deferReply({ ephemeral: true });

        const activeRaid = this.activeRaids.get(interaction.guild.id);
        if (!activeRaid) {
            return interaction.editReply('No active raid found for this server.');
        }

        let count = 0;
        for (const userId of activeRaid.affectedUsers) {
            try {
                const member = await interaction.guild.members.fetch(userId).catch(() => null);
                if (!member || member.id === interaction.guild.ownerId) continue;

                if (actionType === 'kick' && member.kickable) {
                    await member.kick(`Raid escalation by ${interaction.user.tag}`);
                    count++;
                } else if (actionType === 'ban' && member.bannable) {
                    await member.ban({
                        reason: `Raid escalation by ${interaction.user.tag}`,
                        deleteMessageSeconds: 86400
                    });
                    count++;
                }
            } catch {
                // Continue with next user
            }
        }

        // Update incident
        await pool.execute(
            `UPDATE raid_incidents SET action_taken = ?, resolved_by = ?, resolved_at = NOW() WHERE id = ?`,
            [`Escalated to ${actionType}: ${count} users`, interaction.user.id, incidentId]
        );

        // Update embed
        const message = interaction.message;
        const embed = EmbedBuilder.from(message.embeds[0])
            .setColor(0x00ff00)
            .addFields({ name: 'Escalated Action', value: `${actionType.toUpperCase()}: ${count} users by ${interaction.user.tag}` });

        await message.edit({ embeds: [embed], components: [] });
        await interaction.editReply(`Successfully ${actionType}ed ${count} users.`);

        // Clear active raid
        this.activeRaids.delete(interaction.guild.id);
    }

    /**
     * Handle false positive - unmute all affected users
     */
    async handleFalsePositive(interaction, incidentId) {
        await interaction.deferReply({ ephemeral: true });

        const activeRaid = this.activeRaids.get(interaction.guild.id);
        if (!activeRaid) {
            return interaction.editReply('No active raid found for this server.');
        }

        let count = 0;
        for (const userId of activeRaid.affectedUsers) {
            try {
                const member = await interaction.guild.members.fetch(userId).catch(() => null);
                if (!member) continue;

                // Remove timeout
                if (member.communicationDisabledUntil) {
                    await member.timeout(null, `False positive - cleared by ${interaction.user.tag}`);
                    count++;
                }
            } catch {
                // Continue with next user
            }
        }

        // Update incident
        await pool.execute(
            `UPDATE raid_incidents SET action_taken = 'False Positive', notes = ?, resolved_by = ?, resolved_at = NOW() WHERE id = ?`,
            [`Marked as false positive by ${interaction.user.tag}. Unmuted ${count} users.`, interaction.user.id, incidentId]
        );

        // Update embed
        const message = interaction.message;
        const embed = EmbedBuilder.from(message.embeds[0])
            .setColor(0xffff00)
            .setTitle('⚠️ RAID - FALSE POSITIVE')
            .addFields({ name: 'Resolution', value: `Marked as false positive by ${interaction.user.tag}. Unmuted ${count} users.` });

        await message.edit({ embeds: [embed], components: [] });
        await interaction.editReply(`Marked as false positive. Unmuted ${count} users.`);

        // Clear active raid
        this.activeRaids.delete(interaction.guild.id);
    }

    /**
     * Resolve the raid incident
     */
    async resolveRaid(interaction, incidentId) {
        await interaction.deferReply({ ephemeral: true });

        // Update incident
        await pool.execute(
            `UPDATE raid_incidents SET resolved_by = ?, resolved_at = NOW() WHERE id = ?`,
            [interaction.user.id, incidentId]
        );

        // Update embed
        const message = interaction.message;
        const embed = EmbedBuilder.from(message.embeds[0])
            .setColor(0x00ff00)
            .addFields({ name: 'Resolved', value: `Incident resolved by ${interaction.user.tag}` });

        await message.edit({ embeds: [embed], components: [] });
        await interaction.editReply('Raid incident marked as resolved.');

        // Clear active raid
        this.activeRaids.delete(interaction.guild.id);
    }

    /**
     * Clean up old join entries
     */
    cleanupOldJoins() {
        const maxAge = 5 * 60 * 1000; // 5 minutes
        const now = Date.now();

        for (const [guildId, joins] of this.joinTracker.entries()) {
            const filtered = joins.filter(join => now - join.timestamp < maxAge);
            if (filtered.length === 0) {
                this.joinTracker.delete(guildId);
            } else {
                this.joinTracker.set(guildId, filtered);
            }
        }
    }

    /**
     * Get raid detection configuration (cached - 60s TTL)
     */
    async getConfig(guildId) {
        try {
            return await configCache.get('raid_detection_config', guildId, async () => {
                const [rows] = await pool.execute(
                    `SELECT * FROM raid_detection_config WHERE guild_id = ?`,
                    [guildId]
                );
                return rows.length > 0 ? rows[0] : null;
            });
        } catch (error) {
            logger.error('[RaidDetection] Error fetching config', { error: error.message, guildId });
            return null;
        }
    }

    /**
     * Update raid detection configuration
     */
    async updateConfig(guildId, config) {
        try {
            await pool.execute(
                `INSERT INTO raid_detection_config (guild_id, enabled, join_threshold, join_timeframe_seconds,
                    new_account_age_hours, new_account_ratio, action, alert_channel_id, lockdown_duration_minutes,
                    mute_duration_minutes, purge_messages, purge_limit, whitelist_roles)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    enabled = VALUES(enabled),
                    join_threshold = VALUES(join_threshold),
                    join_timeframe_seconds = VALUES(join_timeframe_seconds),
                    new_account_age_hours = VALUES(new_account_age_hours),
                    new_account_ratio = VALUES(new_account_ratio),
                    action = VALUES(action),
                    alert_channel_id = VALUES(alert_channel_id),
                    lockdown_duration_minutes = VALUES(lockdown_duration_minutes),
                    mute_duration_minutes = VALUES(mute_duration_minutes),
                    purge_messages = VALUES(purge_messages),
                    purge_limit = VALUES(purge_limit),
                    whitelist_roles = VALUES(whitelist_roles)`,
                [
                    guildId,
                    config.enabled ?? false,
                    config.join_threshold ?? 10,
                    config.join_timeframe_seconds ?? 30,
                    config.new_account_age_hours ?? 24,
                    config.new_account_ratio ?? 0.7,
                    config.action ?? 'mute',
                    config.alert_channel_id ?? null,
                    config.lockdown_duration_minutes ?? 10,
                    config.mute_duration_minutes ?? 60,
                    config.purge_messages ?? true,
                    config.purge_limit ?? 100,
                    config.whitelist_roles ? JSON.stringify(config.whitelist_roles) : null
                ]
            );
            // Invalidate cache so next lookup gets fresh data
            configCache.invalidate('raid_detection_config', guildId);
            return true;
        } catch (error) {
            logger.error('[RaidDetection] Error updating config', { error: error.message, guildId });
            return false;
        }
    }

    /**
     * Check if raid detection is enabled for a guild
     */
    async isEnabled(guildId) {
        const config = await this.getConfig(guildId);
        return config?.enabled ?? false;
    }

    /**
     * Get raid incident history
     */
    async getIncidentHistory(guildId, limit = 10) {
        try {
            const [rows] = await pool.execute(
                `SELECT * FROM raid_incidents WHERE guild_id = ? ORDER BY detected_at DESC LIMIT ?`,
                [guildId, limit]
            );
            return rows;
        } catch (error) {
            logger.error('[RaidDetection] Error fetching incident history', { error: error.message });
            return [];
        }
    }
}

export default RaidDetectionManager;
