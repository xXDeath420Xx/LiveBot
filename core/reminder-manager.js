import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { EmbedBuilder } from 'discord.js';

class ReminderManager {
    constructor(client) {
        this.client = client;
        this.checkInterval = null;
        logger.info('[ReminderManager] Reminder manager initialized');
    }

    /**
     * Parse time string like "5m", "2h", "1d" to milliseconds
     */
    parseTime(timeStr) {
        const match = timeStr.match(/^(\d+)(s|m|h|d|w)$/i);
        if (!match) return null;

        const value = parseInt(match[1]);
        const unit = match[2].toLowerCase();

        const multipliers = {
            s: 1000,
            m: 60 * 1000,
            h: 60 * 60 * 1000,
            d: 24 * 60 * 60 * 1000,
            w: 7 * 24 * 60 * 60 * 1000
        };

        return value * multipliers[unit];
    }

    /**
     * Create a new reminder
     */
    async createReminder(userId, guildId, channelId, reminderText, duration, isDm = false) {
        try {
            const remindAt = new Date(Date.now() + duration);

            const [result] = await pool.execute(
                `INSERT INTO reminders (user_id, guild_id, channel_id, reminder_text, remind_at, is_dm, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                [userId, guildId, channelId, reminderText, remindAt, isDm ? 1 : 0]
            );

            logger.info(`[ReminderManager] Created reminder ${result.insertId} for user ${userId}`);
            return { success: true, reminderId: result.insertId, remindAt };
        } catch (error) {
            logger.error(`[ReminderManager] Failed to create reminder: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Delete a reminder
     */
    async deleteReminder(reminderId, userId) {
        try {
            const [result] = await pool.execute(
                'DELETE FROM reminders WHERE id = ? AND user_id = ?',
                [reminderId, userId]
            );

            if (result.affectedRows > 0) {
                logger.info(`[ReminderManager] Deleted reminder ${reminderId}`);
                return { success: true };
            } else {
                return { success: false, error: 'Reminder not found or you do not own it' };
            }
        } catch (error) {
            logger.error(`[ReminderManager] Failed to delete reminder: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get all reminders for a user
     */
    async getUserReminders(userId, guildId) {
        try {
            const [reminders] = await pool.execute(
                'SELECT * FROM reminders WHERE user_id = ? AND guild_id = ? ORDER BY remind_at ASC',
                [userId, guildId]
            );

            return reminders;
        } catch (error) {
            logger.error(`[ReminderManager] Failed to fetch user reminders: ${error.message}`);
            return [];
        }
    }

    /**
     * Check and send due reminders
     * Supports multi-bot system - filters reminders by bot assignment
     */
    async checkReminders() {
        try {
            // Build guild filter based on bot assignment to prevent race conditions
            let guildFilter = '';
            const params = [];

            if (this.client.isDefaultBot) {
                // Default bot handles guilds NOT assigned to any custom bot
                guildFilter = `AND guild_id NOT IN (SELECT guild_id FROM guild_bot_mapping)`;
            } else if (this.client.botId) {
                // Custom bot only handles its assigned guilds
                guildFilter = `AND guild_id IN (SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?)`;
                params.push(this.client.botId);
            }

            const [reminders] = await pool.execute(
                `SELECT * FROM reminders WHERE remind_at <= NOW() ${guildFilter}`,
                params
            );

            if (reminders.length === 0) return;

            const botInfo = this.client.isDefaultBot ? 'default bot' : `custom bot ${this.client.botId}`;
            logger.info(`[ReminderManager] Processing ${reminders.length} due reminders for ${botInfo}`);

            for (const reminder of reminders) {
                try {
                    // Get the correct bot client for this guild
                    const guildClient = global.botManager?.getClientForGuild(reminder.guild_id) || this.client;
                    await this.sendReminder(reminder, guildClient);
                } catch (error) {
                    logger.error(`[ReminderManager] Failed to send reminder ${reminder.id}: ${error.message}`);
                } finally {
                    // Always delete the reminder after attempting to send
                    await pool.execute('DELETE FROM reminders WHERE id = ?', [reminder.id]);
                }
            }
        } catch (error) {
            logger.error(`[ReminderManager] Error checking reminders: ${error.message}`);
        }
    }

    /**
     * Send a reminder to the user
     * @param {Object} reminder - The reminder data
     * @param {Client} guildClient - The bot client for this guild (supports multi-bot)
     */
    async sendReminder(reminder, guildClient = this.client) {
        try {
            const user = await guildClient.users.fetch(reminder.user_id).catch(() => null);
            if (!user) {
                logger.warn(`[ReminderManager] Could not find user ${reminder.user_id} for reminder ${reminder.id}`);
                return;
            }

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('🔔 Reminder!')
                .setDescription(reminder.reminder_text)
                .setFooter({ text: `Set ${new Date(reminder.created_at).toLocaleString()}` })
                .setTimestamp();

            if (reminder.is_dm) {
                await user.send({ embeds: [embed] });
                logger.info(`[ReminderManager] Sent DM reminder to user ${user.id}`);
            } else {
                const channel = await this.client.channels.fetch(reminder.channel_id).catch(() => null);
                if (channel && channel.isTextBased()) {
                    await channel.send({ content: `${user}`, embeds: [embed] });
                    logger.info(`[ReminderManager] Sent channel reminder to ${channel.id}`);
                } else {
                    // Fallback to DM if channel not found
                    await user.send({ embeds: [embed] });
                    logger.info(`[ReminderManager] Channel not found, sent DM reminder to user ${user.id}`);
                }
            }
        } catch (error) {
            logger.error(`[ReminderManager] Failed to send reminder ${reminder.id}: ${error.message}`);
        }
    }

    /**
     * Start the reminder check interval
     */
    startScheduler(intervalSeconds = 30) {
        if (this.checkInterval) {
            logger.warn('[ReminderManager] Scheduler already running');
            return;
        }

        logger.info(`[ReminderManager] Starting reminder scheduler (interval: ${intervalSeconds}s)`);

        // Check immediately
        this.checkReminders();

        // Then check on interval
        this.checkInterval = setInterval(() => this.checkReminders(), intervalSeconds * 1000);
    }

    /**
     * Stop the reminder check interval
     */
    stopScheduler() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
            logger.info('[ReminderManager] Stopped reminder scheduler');
        }
    }
}

export default ReminderManager;
