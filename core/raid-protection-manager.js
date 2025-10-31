"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
const discord_js_1 = require("discord.js");
class RaidProtectionManager {
    constructor(client) {
        this.client = client;
        this.joinTracking = new Map();
        this.lockdowns = new Map();
        logger_1.default.info('[RaidProtectionManager] Raid protection manager initialized');
    }
    async getConfig(guildId) {
        try {
            const [[config]] = await db_1.default.execute('SELECT * FROM raid_protection_config WHERE guild_id = ?', [guildId]);
            return config || null;
        }
        catch (error) {
            logger_1.default.error(`[RaidProtectionManager] Failed to get config: ${error.message}`, { guildId });
            return null;
        }
    }
    async handleMemberJoin(member) {
        try {
            const guildId = member.guild.id;
            const config = await this.getConfig(guildId);
            if (!config || !config.enabled)
                return;
            // Check if server is in lockdown
            if (this.lockdowns.has(guildId)) {
                const expiresAt = this.lockdowns.get(guildId);
                if (Date.now() < expiresAt) {
                    await member.kick('Server is in lockdown due to raid detection');
                    logger_1.default.info(`[RaidProtectionManager] Kicked ${member.user.tag} - server in lockdown`, { guildId });
                    return;
                }
                else {
                    this.lockdowns.delete(guildId);
                }
            }
            // Check if member has whitelist role (for re-joins)
            if (config.whitelist_role_id && member.roles.cache.has(config.whitelist_role_id)) {
                return; // Bypass raid protection
            }
            // Check account age
            const accountAge = Date.now() - member.user.createdTimestamp;
            const requiredAge = config.min_account_age_days * 24 * 60 * 60 * 1000;
            if (accountAge < requiredAge) {
                await this.takeAction(member, config, 'Account too new');
                await this.logSuspiciousJoin(guildId, member.id, 'new_account');
                return;
            }
            // Track join rate
            if (!this.joinTracking.has(guildId)) {
                this.joinTracking.set(guildId, []);
            }
            const joins = this.joinTracking.get(guildId);
            const now = Date.now();
            // Remove old joins outside the interval
            const cutoff = now - (config.join_rate_interval * 1000);
            const recentJoins = joins.filter(timestamp => timestamp > cutoff);
            recentJoins.push(now);
            this.joinTracking.set(guildId, recentJoins);
            // Check if join rate exceeds limit
            if (recentJoins.length > config.join_rate_limit) {
                await this.triggerRaidDetection(member.guild, config, recentJoins.length);
            }
            // Check if we should activate lockdown
            if (recentJoins.length >= config.lockdown_threshold) {
                await this.activateLockdown(member.guild, config);
            }
        }
        catch (error) {
            logger_1.default.error(`[RaidProtectionManager] Member join handling error: ${error.message}`, { guildId: member.guild.id });
        }
    }
    async takeAction(member, config, reason) {
        try {
            switch (config.action) {
                case 'kick':
                    await member.kick(`Raid Protection: ${reason}`);
                    logger_1.default.info(`[RaidProtectionManager] Kicked ${member.user.tag} - ${reason}`, { guildId: member.guild.id });
                    break;
                case 'ban':
                    await member.ban({ reason: `Raid Protection: ${reason}` });
                    logger_1.default.info(`[RaidProtectionManager] Banned ${member.user.tag} - ${reason}`, { guildId: member.guild.id });
                    break;
                case 'verify':
                    // Apply unverified role if verification system is enabled
                    if (this.client.verificationManager) {
                        await this.client.verificationManager.handleMemberJoin(member);
                    }
                    break;
            }
        }
        catch (error) {
            logger_1.default.error(`[RaidProtectionManager] Failed to take action: ${error.message}`);
        }
    }
    async triggerRaidDetection(guild, config, joinCount) {
        try {
            await db_1.default.execute(`INSERT INTO raid_events (guild_id, event_type, join_count)
                VALUES (?, 'raid_detected', ?)`, [guild.id, joinCount]);
            // Send alert to configured channel
            if (config.alert_channel_id) {
                const channel = guild.channels.cache.get(config.alert_channel_id);
                if (channel) {
                    const embed = new discord_js_1.EmbedBuilder()
                        .setColor('#FF0000')
                        .setTitle('🚨 Potential Raid Detected!')
                        .setDescription(`**${joinCount} members** joined in the last **${config.join_rate_interval} seconds**`)
                        .addFields({ name: 'Action Taken', value: config.action === 'verify' ? 'Verification Required' : `Auto-${config.action}`, inline: true }, { name: 'Rate Limit', value: `${config.join_rate_limit} joins per ${config.join_rate_interval}s`, inline: true })
                        .setTimestamp();
                    await channel.send({ embeds: [embed] });
                }
            }
            logger_1.default.warn(`[RaidProtectionManager] Raid detected in guild ${guild.id} - ${joinCount} joins`, { guildId: guild.id });
        }
        catch (error) {
            logger_1.default.error(`[RaidProtectionManager] Failed to trigger raid detection: ${error.message}`);
        }
    }
    async activateLockdown(guild, config) {
        try {
            const expiresAt = Date.now() + (config.lockdown_duration * 1000);
            this.lockdowns.set(guild.id, expiresAt);
            await db_1.default.execute(`INSERT INTO raid_events (guild_id, event_type)
                VALUES (?, 'lockdown_activated')`, [guild.id]);
            // Send alert
            if (config.alert_channel_id) {
                const channel = guild.channels.cache.get(config.alert_channel_id);
                if (channel) {
                    const embed = new discord_js_1.EmbedBuilder()
                        .setColor('#FF0000')
                        .setTitle('🔒 Server Lockdown Activated!')
                        .setDescription(`All new joins will be automatically kicked for the next **${config.lockdown_duration} seconds**`)
                        .addFields({ name: 'Reason', value: `Join threshold exceeded (${config.lockdown_threshold} joins)`, inline: false }, { name: 'Duration', value: `${Math.floor(config.lockdown_duration / 60)} minutes`, inline: true })
                        .setTimestamp();
                    await channel.send({ embeds: [embed] });
                }
            }
            logger_1.default.warn(`[RaidProtectionManager] Lockdown activated for guild ${guild.id}`, { guildId: guild.id });
            // Auto-disable lockdown after duration
            setTimeout(() => {
                this.lockdowns.delete(guild.id);
                logger_1.default.info(`[RaidProtectionManager] Lockdown expired for guild ${guild.id}`, { guildId: guild.id });
            }, config.lockdown_duration * 1000);
        }
        catch (error) {
            logger_1.default.error(`[RaidProtectionManager] Failed to activate lockdown: ${error.message}`);
        }
    }
    async logSuspiciousJoin(guildId, userId, type) {
        try {
            await db_1.default.execute(`INSERT INTO raid_events (guild_id, event_type, user_ids)
                VALUES (?, 'suspicious_join', ?)`, [guildId, JSON.stringify([userId])]);
        }
        catch (error) {
            logger_1.default.error(`[RaidProtectionManager] Failed to log suspicious join: ${error.message}`);
        }
    }
    async manualLockdown(guild, duration = 600) {
        const expiresAt = Date.now() + (duration * 1000);
        this.lockdowns.set(guild.id, expiresAt);
        logger_1.default.info(`[RaidProtectionManager] Manual lockdown activated for guild ${guild.id}`, { guildId: guild.id, duration });
        return expiresAt;
    }
    async endLockdown(guildId) {
        this.lockdowns.delete(guildId);
        logger_1.default.info(`[RaidProtectionManager] Lockdown manually ended for guild ${guildId}`, { guildId });
        return true;
    }
    isInLockdown(guildId) {
        if (!this.lockdowns.has(guildId))
            return false;
        const expiresAt = this.lockdowns.get(guildId);
        return Date.now() < expiresAt;
    }
    async getRaidEvents(guildId, limit = 10) {
        try {
            const [events] = await db_1.default.execute('SELECT * FROM raid_events WHERE guild_id = ? ORDER BY timestamp DESC LIMIT ?', [guildId, limit]);
            return events;
        }
        catch (error) {
            logger_1.default.error(`[RaidProtectionManager] Failed to get raid events: ${error.message}`);
            return [];
        }
    }
}
exports.default = RaidProtectionManager;
