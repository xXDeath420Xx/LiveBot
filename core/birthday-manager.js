"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
/**
 * Birthday Manager - Handles birthday tracking and announcements
 */
class BirthdayManager {
    constructor(client) {
        this.client = client;
        this.checkScheduled = false;
    }
    /**
     * Start the birthday checker (runs daily at midnight)
     */
    async start() {
        if (this.checkScheduled) {
            logger_1.default.warn('[BirthdayManager] Birthday checker already scheduled');
            return;
        }
        // Calculate time until next midnight
        const now = new Date();
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
        const msUntilMidnight = tomorrow.getTime() - now.getTime();
        logger_1.default.info(`[BirthdayManager] Scheduling first birthday check in ${Math.floor(msUntilMidnight / 1000 / 60)} minutes`);
        // Schedule first check at midnight
        setTimeout(() => {
            this.checkBirthdays();
            // Then check daily
            setInterval(() => this.checkBirthdays(), 24 * 60 * 60 * 1000);
        }, msUntilMidnight);
        this.checkScheduled = true;
    }
    /**
     * Check for birthdays today and announce them
     */
    async checkBirthdays() {
        const today = new Date();
        const month = today.getMonth() + 1;
        const day = today.getDate();
        logger_1.default.info(`[BirthdayManager] Checking birthdays for ${month}/${day}`);
        try {
            const [birthdays] = await db_1.default.execute('SELECT user_id, guild_id FROM user_birthdays WHERE month = ? AND day = ?', [month, day]);
            if (birthdays.length === 0) {
                logger_1.default.info('[BirthdayManager] No birthdays today');
                return;
            }
            logger_1.default.info(`[BirthdayManager] Found ${birthdays.length} birthdays today`);
            for (const { user_id, guild_id } of birthdays) {
                await this.announceBirthday(user_id, guild_id);
            }
        }
        catch (error) {
            logger_1.default.error(`[BirthdayManager] Error checking birthdays: ${error.message}`);
        }
    }
    /**
     * Announce a birthday
     */
    async announceBirthday(userId, guildId) {
        try {
            const guild = await this.client.guilds.fetch(guildId).catch(() => null);
            if (!guild) {
                logger_1.default.warn(`[BirthdayManager] Guild ${guildId} not found`);
                return;
            }
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) {
                logger_1.default.warn(`[BirthdayManager] Member ${userId} not found in guild ${guildId}`);
                return;
            }
            // Get birthday config
            const [configRows] = await db_1.default.execute('SELECT announcement_channel_id, enabled, message_template FROM birthday_config WHERE guild_id = ?', [guildId]);
            const config = configRows[0] || { enabled: true, announcement_channel_id: null, message_template: null };
            if (!config.enabled) {
                logger_1.default.info(`[BirthdayManager] Birthdays disabled for guild ${guildId}`);
                return;
            }
            let channelId = config.announcement_channel_id;
            // If no channel configured, try to find a suitable one
            if (!channelId) {
                // Try to find #birthdays, #general, or system channel
                const channel = guild.channels.cache.find(ch => ch.isTextBased() && (ch.name.includes('birthday') ||
                    ch.name === 'general' ||
                    ch.id === guild.systemChannelId));
                if (!channel) {
                    logger_1.default.warn(`[BirthdayManager] No suitable channel found for birthday announcement in guild ${guildId}`);
                    return;
                }
                channelId = channel.id;
            }
            const channel = await guild.channels.fetch(channelId).catch(() => null);
            if (!channel || !channel.isTextBased()) {
                logger_1.default.warn(`[BirthdayManager] Invalid channel ${channelId} for guild ${guildId}`);
                return;
            }
            // Create birthday embed
            const embed = new discord_js_1.EmbedBuilder()
                .setTitle(`🎉 Happy Birthday ${member.displayName}!`)
                .setDescription(`Join us in wishing <@${userId}> a very happy birthday! 🎂🥳`)
                .setColor('#FF69B4')
                .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }))
                .setFooter({ text: `${guild.name} • Birthday Celebration` })
                .setTimestamp();
            await channel.send({
                content: `🎈 <@${userId}>`,
                embeds: [embed]
            });
            logger_1.default.info(`[BirthdayManager] Announced birthday for ${member.user.tag} in ${guild.name}`);
        }
        catch (error) {
            logger_1.default.error(`[BirthdayManager] Error announcing birthday: ${error.message}`);
        }
    }
    /**
     * Set a user's birthday
     */
    async setBirthday(userId, guildId, month, day) {
        if (month < 1 || month > 12 || day < 1 || day > 31) {
            throw new Error('Invalid date. Month must be 1-12, day must be 1-31.');
        }
        try {
            await db_1.default.execute(`INSERT INTO user_birthdays (user_id, guild_id, month, day)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE month = VALUES(month), day = VALUES(day)`, [userId, guildId, month, day]);
            logger_1.default.info(`[BirthdayManager] Set birthday for user ${userId} in guild ${guildId}: ${month}/${day}`);
            return true;
        }
        catch (error) {
            logger_1.default.error(`[BirthdayManager] Error setting birthday: ${error.message}`);
            throw error;
        }
    }
    /**
     * Get a user's birthday
     */
    async getBirthday(userId, guildId) {
        try {
            const [rows] = await db_1.default.execute('SELECT month, day FROM user_birthdays WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
            return rows[0] || null;
        }
        catch (error) {
            logger_1.default.error(`[BirthdayManager] Error getting birthday: ${error.message}`);
            return null;
        }
    }
    /**
     * Remove a user's birthday
     */
    async removeBirthday(userId, guildId) {
        try {
            await db_1.default.execute('DELETE FROM user_birthdays WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
            logger_1.default.info(`[BirthdayManager] Removed birthday for user ${userId} in guild ${guildId}`);
            return true;
        }
        catch (error) {
            logger_1.default.error(`[BirthdayManager] Error removing birthday: ${error.message}`);
            return false;
        }
    }
    /**
     * Get all upcoming birthdays for a guild
     */
    async getUpcomingBirthdays(guildId, days = 7) {
        try {
            const today = new Date();
            const upcomingBirthdays = [];
            const [allBirthdays] = await db_1.default.execute('SELECT user_id, month, day FROM user_birthdays WHERE guild_id = ?', [guildId]);
            for (const birthday of allBirthdays) {
                const birthdayDate = new Date(today.getFullYear(), birthday.month - 1, birthday.day);
                // If birthday has passed this year, check next year
                if (birthdayDate < today) {
                    birthdayDate.setFullYear(today.getFullYear() + 1);
                }
                const daysUntil = Math.floor((birthdayDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
                if (daysUntil <= days) {
                    upcomingBirthdays.push({
                        userId: birthday.user_id,
                        month: birthday.month,
                        day: birthday.day,
                        daysUntil
                    });
                }
            }
            return upcomingBirthdays.sort((a, b) => a.daysUntil - b.daysUntil);
        }
        catch (error) {
            logger_1.default.error(`[BirthdayManager] Error getting upcoming birthdays: ${error.message}`);
            return [];
        }
    }
    /**
     * Configure birthday settings for a guild
     */
    async configureBirthdays(guildId, channelId, enabled = true, template = null) {
        try {
            await db_1.default.execute(`INSERT INTO birthday_config (guild_id, announcement_channel_id, enabled, message_template)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    announcement_channel_id = VALUES(announcement_channel_id),
                    enabled = VALUES(enabled),
                    message_template = VALUES(message_template)`, [guildId, channelId, enabled, template]);
            logger_1.default.info(`[BirthdayManager] Configured birthdays for guild ${guildId}`);
            return true;
        }
        catch (error) {
            logger_1.default.error(`[BirthdayManager] Error configuring birthdays: ${error.message}`);
            return false;
        }
    }
}
exports.default = BirthdayManager;
