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
     * Create a new reminder. `repeat` (optional): { interval: seconds between sends (at least one
     * hour), count: sends in all, -1 or null = until deleted }.
     */
    async createReminder(userId, guildId, channelId, reminderText, duration, isDm = false, repeat = null) {
        try {
            const remindAt = new Date(Date.now() + duration);
            const interval = repeat && Number(repeat.interval) >= 3600 ? Math.floor(Number(repeat.interval)) : null;
            const count = interval ? (Number.isInteger(Number(repeat.count)) && Number(repeat.count) > 1 ? Number(repeat.count) : -1) : null;

            // The text column is `message` (the dashboard's Reminders page reads the same column).
            const [result] = await pool.execute(
                `INSERT INTO reminders (user_id, guild_id, channel_id, message, remind_at, is_dm, created_at,
                                        recurring_interval, recurring_count, next_occurrence, occurrences_sent)
                 VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, 0)`,
                [userId, guildId, channelId, reminderText, remindAt, isDm ? 1 : 0, interval, count, interval ? remindAt : null]
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
            // `/notes remind list` reads r.reminder_text; the column itself is `message`.
            const [reminders] = await pool.execute(
                'SELECT *, message AS reminder_text FROM reminders WHERE user_id = ? AND guild_id = ? ORDER BY remind_at ASC',
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
        // A slow pass (many due reminders, slow Discord) must not overlap the next 30s tick, or the
        // same reminder gets picked up twice and sent twice before the first pass deletes it.
        if (this.checking) return;
        this.checking = true;
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
                    await this.finishOccurrence(reminder);
                }
            }
        } catch (error) {
            logger.error(`[ReminderManager] Error checking reminders: ${error.message}`);
        } finally {
            this.checking = false;
        }
    }

    /**
     * After a reminder fires: a recurring one (recurring_interval seconds, recurring_count total
     * sends, -1 = forever) is pushed to its next time; everything else is deleted.
     */
    async finishOccurrence(reminder) {
        try {
            const interval = Number(reminder.recurring_interval) || 0;
            const sent = (Number(reminder.occurrences_sent) || 0) + 1;
            const total = reminder.recurring_count == null ? -1 : Number(reminder.recurring_count);
            if (interval > 0 && (total < 0 || sent < total)) {
                // Step past now so a reminder that was overdue by several intervals fires once, not in a burst.
                const behindMs = Date.now() - new Date(reminder.remind_at).getTime();
                const steps = Math.max(1, Math.floor(behindMs / (interval * 1000)) + 1);
                const next = new Date(new Date(reminder.remind_at).getTime() + steps * interval * 1000);
                await pool.execute(
                    'UPDATE reminders SET remind_at = ?, next_occurrence = ?, occurrences_sent = ? WHERE id = ?',
                    [next, next, sent, reminder.id]
                );
            } else {
                await pool.execute('DELETE FROM reminders WHERE id = ?', [reminder.id]);
            }
        } catch (error) {
            logger.error(`[ReminderManager] Failed to clear/reschedule reminder ${reminder.id}: ${error.message}`, {
                guildId: reminder.guild_id
            });
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
                .setDescription(reminder.message)
                .setFooter({ text: `Set ${new Date(reminder.created_at).toLocaleString()}` })
                .setTimestamp();

            if (reminder.is_dm) {
                await user.send({ embeds: [embed] });
                logger.info(`[ReminderManager] Sent DM reminder to user ${user.id}`);
            } else {
                // Same client that owns the guild (multi-bot): the default bot may not be in it.
                const channel = await guildClient.channels.fetch(reminder.channel_id).catch(() => null);
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
            logger.debug('[ReminderManager] Scheduler already running'); // expected: initReminderScheduler re-runs once custom bots load
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
