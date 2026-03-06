import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { BoundedMap } from '../utils/bounded-map.js';
import { batchWithRateLimit } from '../utils/rate-limiter.js';
import { MutexManager } from '../utils/mutex.js';

/**
 * Anti-Nuke Manager - Tracks and prevents mass destructive actions
 * Features:
 * - Bounded memory usage with automatic cleanup
 * - Mutex locks to prevent race conditions
 * - Config/whitelist caching to reduce DB load
 * - Permission verification before punishment
 * - Rate-limited role removal
 */
class AntiNukeManager {
    constructor(client) {
        this.client = client;

        // Time window for tracking (5 minutes)
        this.timeWindow = 5 * 60 * 1000;

        // Bounded action tracker: Map<guildId, Map<`${userId}:${actionType}`, timestamp[]>>
        // Using flat structure for simpler bounded management
        this.actionTracker = new BoundedMap({
            maxSize: 10000,
            ttl: this.timeWindow,
            name: 'AntiNuke:Actions',
            cleanupInterval: 60000
        });

        // Config cache: Map<guildId, {config, cachedAt}>
        this.configCache = new BoundedMap({
            maxSize: 1000,
            ttl: 30000, // 30 second cache
            name: 'AntiNuke:Config'
        });

        // Whitelist cache: Map<`${guildId}:${userId}`, boolean>
        this.whitelistCache = new BoundedMap({
            maxSize: 5000,
            ttl: 60000, // 1 minute cache
            name: 'AntiNuke:Whitelist'
        });

        // Mutex manager for per-guild locking with timeout protection
        this.guildMutexes = new MutexManager({
            maxSize: 1000,
            timeoutMs: 10000, // 10 second timeout to prevent deadlocks
            name: 'AntiNuke:GuildMutex'
        });

        // Track users already being punished to prevent duplicate actions
        this.punishmentInProgress = new Set();

        // Store interval reference for cleanup
        this.cleanupInterval = setInterval(() => this._periodicCleanup(), 60000);
    }

    /**
     * Run a function exclusively for a guild (with mutex protection)
     * @param {string} guildId - Guild ID
     * @param {Function} fn - Function to run exclusively
     * @returns {Promise<*>} Result of the function
     */
    async _runExclusiveForGuild(guildId, fn) {
        return this.guildMutexes.runExclusive(guildId, fn);
    }

    /**
     * Get action key for tracker
     */
    _getActionKey(guildId, userId, actionType) {
        return `${guildId}:${userId}:${actionType}`;
    }

    /**
     * Track a channel deletion
     */
    async trackChannelDelete(guild, channel, executor) {
        await this._trackAction(guild, executor, 'channelDeletes', 'max_channel_deletes', 'channel deletion');
    }

    /**
     * Track a role deletion
     */
    async trackRoleDelete(guild, role, executor) {
        await this._trackAction(guild, executor, 'roleDeletes', 'max_role_deletes', 'role deletion');
    }

    /**
     * Track a ban
     */
    async trackBan(guild, user, executor) {
        await this._trackAction(guild, executor, 'bans', 'max_kick_bans', 'ban');
    }

    /**
     * Generic action tracking with mutex protection
     */
    async _trackAction(guild, executor, actionType, configKey, actionDescription) {
        if (!executor) return;

        // Never trigger on ourselves
        if (this.client?.user?.id && executor.id === this.client.user.id) return;

        await this._runExclusiveForGuild(guild.id, async () => {
            const config = await this.getConfig(guild.id);
            if (!config || !config.enabled) return;

            // Check if user is whitelisted
            if (await this.isWhitelisted(guild.id, executor.id)) return;

            // Track the action
            const count = this._addAction(guild.id, executor.id, actionType);

            // Check threshold
            const threshold = config[configKey];
            if (threshold && count >= threshold) {
                await this._triggerAction(guild, executor, actionDescription, count, config);
            }
        });
    }

    /**
     * Add an action to the tracker and return current count
     */
    _addAction(guildId, userId, actionType) {
        const key = this._getActionKey(guildId, userId, actionType);
        const now = Date.now();

        let timestamps = this.actionTracker.get(key) || [];

        // Filter out old timestamps
        timestamps = timestamps.filter(time => now - time < this.timeWindow);

        // Add new timestamp
        timestamps.push(now);

        // Limit array size to prevent unbounded growth
        if (timestamps.length > 100) {
            timestamps = timestamps.slice(-100);
        }

        this.actionTracker.set(key, timestamps);

        return timestamps.length;
    }

    /**
     * Get action count within time window
     */
    getActionCount(guildId, userId, actionType) {
        const key = this._getActionKey(guildId, userId, actionType);
        const timestamps = this.actionTracker.get(key);
        if (!timestamps) return 0;

        const now = Date.now();
        return timestamps.filter(time => now - time < this.timeWindow).length;
    }

    /**
     * Get anti-nuke configuration with caching
     */
    async getConfig(guildId) {
        // Check cache first
        const cached = this.configCache.get(guildId);
        if (cached) return cached;

        try {
            const [rows] = await pool.execute(
                `SELECT * FROM anti_nuke_config WHERE guild_id = ?`,
                [guildId]
            );

            const config = rows.length > 0 ? rows[0] : null;
            if (config) {
                this.configCache.set(guildId, config);
            }
            return config;
        } catch (error) {
            logger.logError('[AntiNuke] Error fetching config', error, { guildId });
            return null;
        }
    }

    /**
     * Check if user is whitelisted with caching
     */
    async isWhitelisted(guildId, userId) {
        const cacheKey = `${guildId}:${userId}`;

        // Check cache first
        const cached = this.whitelistCache.get(cacheKey);
        if (cached !== undefined) return cached;

        try {
            const [rows] = await pool.execute(
                `SELECT 1 FROM anti_nuke_whitelist WHERE guild_id = ? AND user_id = ?`,
                [guildId, userId]
            );

            const isWhitelisted = rows.length > 0;
            this.whitelistCache.set(cacheKey, isWhitelisted);
            return isWhitelisted;
        } catch (error) {
            logger.logError('[AntiNuke] Error checking whitelist', error, { guildId, userId });
            return false; // Fail-safe: treat as not whitelisted
        }
    }

    /**
     * Invalidate whitelist cache for a user (call when whitelist changes)
     */
    invalidateWhitelistCache(guildId, userId) {
        this.whitelistCache.delete(`${guildId}:${userId}`);
    }

    /**
     * Invalidate config cache for a guild (call when config changes)
     */
    invalidateConfigCache(guildId) {
        this.configCache.delete(guildId);
    }

    /**
     * Trigger punishment action with race condition protection
     */
    async _triggerAction(guild, executor, actionType, count, config) {
        // Prevent duplicate punishments
        const punishmentKey = `${guild.id}:${executor.id}`;
        if (this.punishmentInProgress.has(punishmentKey)) {
            logger.debug('[AntiNuke] Punishment already in progress, skipping', { punishmentKey });
            return;
        }

        this.punishmentInProgress.add(punishmentKey);

        try {
            logger.warn('[AntiNuke] Threshold exceeded', {
                guildId: guild.id,
                userId: executor.id,
                actionType,
                count,
                action: config.action_on_trigger
            });

            // Send alert first
            await this._sendAlert(guild, executor, actionType, count, config);

            // Get the member
            const member = await guild.members.fetch(executor.id).catch(() => null);
            if (!member) {
                logger.warn('[AntiNuke] Could not fetch member to punish', { userId: executor.id });
                return;
            }

            // Skip if member is owner
            if (member.id === guild.ownerId) {
                logger.info('[AntiNuke] Skipping action for guild owner', { userId: executor.id });
                return;
            }

            // Verify bot has permission to punish
            const botMember = await guild.members.fetchMe().catch(() => null);
            if (!botMember) {
                logger.error('[AntiNuke] Could not fetch bot member');
                return;
            }

            // Check role hierarchy - bot must be higher than target
            if (member.roles.highest.position >= botMember.roles.highest.position) {
                logger.warn('[AntiNuke] Cannot punish member with equal or higher role', {
                    userId: executor.id,
                    targetPosition: member.roles.highest.position,
                    botPosition: botMember.roles.highest.position
                });
                return;
            }

            // Execute action
            await this._executePunishment(member, guild, config, actionType, count);

        } catch (error) {
            logger.error('[AntiNuke] Error in triggerAction', {
                error: error.message,
                userId: executor.id,
                guildId: guild.id
            });
        } finally {
            // Clear punishment lock after a delay to prevent rapid re-triggers
            setTimeout(() => {
                this.punishmentInProgress.delete(punishmentKey);
            }, 10000);
        }
    }

    /**
     * Execute the actual punishment
     */
    async _executePunishment(member, guild, config, actionType, count) {
        const reason = `Anti-Nuke: ${count} ${actionType}s detected`;

        try {
            switch (config.action_on_trigger) {
                case 'kick':
                    if (!guild.members.me.permissions.has(PermissionFlagsBits.KickMembers)) {
                        logger.warn('[AntiNuke] Missing kick permission');
                        return;
                    }
                    await member.kick(reason);
                    logger.info('[AntiNuke] Kicked member', { userId: member.id, guildId: guild.id });
                    break;

                case 'ban':
                    if (!guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) {
                        logger.warn('[AntiNuke] Missing ban permission');
                        return;
                    }
                    await member.ban({ reason });
                    logger.info('[AntiNuke] Banned member', { userId: member.id, guildId: guild.id });
                    break;

                case 'strip':
                    if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
                        logger.warn('[AntiNuke] Missing manage roles permission');
                        return;
                    }
                    await this._stripRoles(member, guild);
                    logger.info('[AntiNuke] Stripped roles from member', { userId: member.id, guildId: guild.id });
                    break;

                case 'alert':
                    logger.info('[AntiNuke] Alert only, no action taken', { userId: member.id, guildId: guild.id });
                    break;
            }
        } catch (error) {
            logger.error('[AntiNuke] Error executing punishment', {
                error: error.message,
                userId: member.id,
                guildId: guild.id,
                action: config.action_on_trigger
            });
        }
    }

    /**
     * Strip roles with rate limiting
     */
    async _stripRoles(member, guild) {
        const rolesToRemove = member.roles.cache.filter(role =>
            role.id !== guild.id && // Not @everyone
            role.position < guild.members.me.roles.highest.position // Bot can remove it
        );

        if (rolesToRemove.size === 0) {
            logger.debug('[AntiNuke] No removable roles found');
            return;
        }

        // Use batch with rate limiting
        const results = await batchWithRateLimit(
            Array.from(rolesToRemove.values()),
            async (role) => member.roles.remove(role, 'Anti-Nuke role strip'),
            {
                bucket: `antinuke:strip:${guild.id}`,
                delayBetween: 200,
                maxRetries: 3
            }
        );

        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;

        if (failCount > 0) {
            logger.warn('[AntiNuke] Some roles could not be removed', {
                success: successCount,
                failed: failCount,
                userId: member.id
            });
        }
    }

    /**
     * Send alert to configured channel
     */
    async _sendAlert(guild, executor, actionType, count, config) {
        if (!config.alert_channel_id) return;

        const channel = await guild.channels.fetch(config.alert_channel_id).catch(() => null);
        if (!channel) return;

        const actionEmojis = {
            'channel deletion': '\uD83D\uDDD1\uFE0F',
            'role deletion': '\uD83C\uDFAD',
            'ban': '\uD83D\uDD28'
        };

        const actionDescriptions = {
            'kick': 'Kicked from server',
            'ban': 'Banned from server',
            'strip': 'All roles removed',
            'alert': 'No action (alert only)'
        };

        const embed = new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle(`${actionEmojis[actionType] || '\u26A0\uFE0F'} Anti-Nuke Triggered`)
            .setDescription(`**${executor.tag || executor.username}** (${executor.id}) triggered anti-nuke protection!`)
            .addFields(
                { name: 'Action Type', value: actionType, inline: true },
                { name: 'Count', value: `${count}`, inline: true },
                { name: 'Response', value: actionDescriptions[config.action_on_trigger] || config.action_on_trigger, inline: true }
            )
            .setThumbnail(executor.displayAvatarURL?.() || null)
            .setTimestamp()
            .setFooter({ text: 'Anti-Nuke Protection System' });

        await channel.send({ embeds: [embed] }).catch(err =>
            logger.error('[AntiNuke] Error sending alert', { error: err.message })
        );
    }

    /**
     * Periodic cleanup of old data
     */
    _periodicCleanup() {
        // Clean punishment in progress set (should be empty normally)
        // This is a safety cleanup in case setTimeout cleanup fails
        if (this.punishmentInProgress.size > 100) {
            logger.warn('[AntiNuke] Punishment in progress set is large, clearing', { size: this.punishmentInProgress.size });
            this.punishmentInProgress.clear();
        }
    }

    /**
     * Stop the manager and clean up intervals
     */
    stop() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        this.actionTracker.destroy();
        this.configCache.destroy();
        this.whitelistCache.destroy();
        this.guildMutexes.clear(); // MutexManager uses clear()
        this.punishmentInProgress.clear();

        logger.info('[AntiNuke] Manager stopped');
    }
}

export default AntiNukeManager;
