import type { Client, Guild, GuildMember, TextChannel } from 'discord.js';
import type { RowDataPacket } from 'mysql2';
import { EmbedBuilder } from 'discord.js';
import db from '../utils/db';
import logger from '../utils/logger';

interface BirthdayRow extends RowDataPacket {
    user_id: string;
    guild_id: string;
    month: number;
    day: number;
}

interface BirthdayConfig extends RowDataPacket {
    guild_id: string;
    announcement_channel_id: string | null;
    enabled: boolean;
    message_template: string | null;
}

interface UpcomingBirthday {
    userId: string;
    month: number;
    day: number;
    daysUntil: number;
}

/**
 * Birthday Manager - Handles birthday tracking and announcements
 */
class BirthdayManager {
    private client: Client;
    private checkScheduled: boolean;

    constructor(client: Client) {
        this.client = client;
        this.checkScheduled = false;
    }

    /**
     * Start the birthday checker (runs daily at midnight)
     */
    async start(): Promise<void> {
        if (this.checkScheduled) {
            logger.warn('[BirthdayManager] Birthday checker already scheduled');
            return;
        }

        // Calculate time until next midnight
        const now = new Date();
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
        const msUntilMidnight = tomorrow.getTime() - now.getTime();

        logger.info(`[BirthdayManager] Scheduling first birthday check in ${Math.floor(msUntilMidnight / 1000 / 60)} minutes`);

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
    async checkBirthdays(): Promise<void> {
        const today = new Date();
        const month = today.getMonth() + 1;
        const day = today.getDate();

        logger.info(`[BirthdayManager] Checking birthdays for ${month}/${day}`);

        try {
            const [birthdays] = await db.execute<BirthdayRow[]>(
                'SELECT user_id, guild_id FROM user_birthdays WHERE month = ? AND day = ?',
                [month, day]
            );

            if (birthdays.length === 0) {
                logger.info('[BirthdayManager] No birthdays today');
                return;
            }

            logger.info(`[BirthdayManager] Found ${birthdays.length} birthdays today`);

            for (const { user_id, guild_id } of birthdays) {
                await this.announceBirthday(user_id, guild_id);
            }
        } catch (error: any) {
            logger.error(`[BirthdayManager] Error checking birthdays: ${error.message}`);
        }
    }

    /**
     * Announce a birthday
     */
    async announceBirthday(userId: string, guildId: string): Promise<void> {
        try {
            const guild = await this.client.guilds.fetch(guildId).catch(() => null);
            if (!guild) {
                logger.warn(`[BirthdayManager] Guild ${guildId} not found`);
                return;
            }

            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) {
                logger.warn(`[BirthdayManager] Member ${userId} not found in guild ${guildId}`);
                return;
            }

            // Get birthday config
            const [configRows] = await db.execute<BirthdayConfig[]>(
                'SELECT announcement_channel_id, enabled, message_template FROM birthday_config WHERE guild_id = ?',
                [guildId]
            );

            const config = configRows[0] || { enabled: true, announcement_channel_id: null, message_template: null };

            if (!config.enabled) {
                logger.info(`[BirthdayManager] Birthdays disabled for guild ${guildId}`);
                return;
            }

            let channelId = config.announcement_channel_id;

            // If no channel configured, try to find a suitable one
            if (!channelId) {
                // Try to find #birthdays, #general, or system channel
                const channel = guild.channels.cache.find(ch =>
                    ch.isTextBased() && (
                        ch.name.includes('birthday') ||
                        ch.name === 'general' ||
                        ch.id === guild.systemChannelId
                    )
                );

                if (!channel) {
                    logger.warn(`[BirthdayManager] No suitable channel found for birthday announcement in guild ${guildId}`);
                    return;
                }

                channelId = channel.id;
            }

            const channel = await guild.channels.fetch(channelId).catch(() => null);
            if (!channel || !channel.isTextBased()) {
                logger.warn(`[BirthdayManager] Invalid channel ${channelId} for guild ${guildId}`);
                return;
            }

            // Create birthday embed
            const embed = new EmbedBuilder()
                .setTitle(`🎉 Happy Birthday ${member.displayName}!`)
                .setDescription(`Join us in wishing <@${userId}> a very happy birthday! 🎂🥳`)
                .setColor('#FF69B4')
                .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }))
                .setFooter({ text: `${guild.name} • Birthday Celebration` })
                .setTimestamp();

            await (channel as TextChannel).send({
                content: `🎈 <@${userId}>`,
                embeds: [embed]
            });

            logger.info(`[BirthdayManager] Announced birthday for ${member.user.tag} in ${guild.name}`);
        } catch (error: any) {
            logger.error(`[BirthdayManager] Error announcing birthday: ${error.message}`);
        }
    }

    /**
     * Set a user's birthday
     */
    async setBirthday(userId: string, guildId: string, month: number, day: number): Promise<boolean> {
        if (month < 1 || month > 12 || day < 1 || day > 31) {
            throw new Error('Invalid date. Month must be 1-12, day must be 1-31.');
        }

        try {
            await db.execute(
                `INSERT INTO user_birthdays (user_id, guild_id, month, day)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE month = VALUES(month), day = VALUES(day)`,
                [userId, guildId, month, day]
            );

            logger.info(`[BirthdayManager] Set birthday for user ${userId} in guild ${guildId}: ${month}/${day}`);
            return true;
        } catch (error: any) {
            logger.error(`[BirthdayManager] Error setting birthday: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get a user's birthday
     */
    async getBirthday(userId: string, guildId: string): Promise<{ month: number; day: number } | null> {
        try {
            const [rows] = await db.execute<BirthdayRow[]>(
                'SELECT month, day FROM user_birthdays WHERE user_id = ? AND guild_id = ?',
                [userId, guildId]
            );

            return rows[0] || null;
        } catch (error: any) {
            logger.error(`[BirthdayManager] Error getting birthday: ${error.message}`);
            return null;
        }
    }

    /**
     * Remove a user's birthday
     */
    async removeBirthday(userId: string, guildId: string): Promise<boolean> {
        try {
            await db.execute(
                'DELETE FROM user_birthdays WHERE user_id = ? AND guild_id = ?',
                [userId, guildId]
            );

            logger.info(`[BirthdayManager] Removed birthday for user ${userId} in guild ${guildId}`);
            return true;
        } catch (error: any) {
            logger.error(`[BirthdayManager] Error removing birthday: ${error.message}`);
            return false;
        }
    }

    /**
     * Get all upcoming birthdays for a guild
     */
    async getUpcomingBirthdays(guildId: string, days: number = 7): Promise<UpcomingBirthday[]> {
        try {
            const today = new Date();
            const upcomingBirthdays: UpcomingBirthday[] = [];

            const [allBirthdays] = await db.execute<BirthdayRow[]>(
                'SELECT user_id, month, day FROM user_birthdays WHERE guild_id = ?',
                [guildId]
            );

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
        } catch (error: any) {
            logger.error(`[BirthdayManager] Error getting upcoming birthdays: ${error.message}`);
            return [];
        }
    }

    /**
     * Configure birthday settings for a guild
     */
    async configureBirthdays(guildId: string, channelId: string, enabled: boolean = true, template: string | null = null): Promise<boolean> {
        try {
            await db.execute(
                `INSERT INTO birthday_config (guild_id, announcement_channel_id, enabled, message_template)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    announcement_channel_id = VALUES(announcement_channel_id),
                    enabled = VALUES(enabled),
                    message_template = VALUES(message_template)`,
                [guildId, channelId, enabled, template]
            );

            logger.info(`[BirthdayManager] Configured birthdays for guild ${guildId}`);
            return true;
        } catch (error: any) {
            logger.error(`[BirthdayManager] Error configuring birthdays: ${error.message}`);
            return false;
        }
    }
}

export default BirthdayManager;
