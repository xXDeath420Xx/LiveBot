"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
const discord_js_1 = require("discord.js");
class ScheduledAnnouncementsManager {
    constructor(client) {
        this.client = client;
        this.checkInterval = null;
        logger_1.default.info('[ScheduledAnnouncementsManager] Scheduled announcements manager initialized');
    }
    startScheduler() {
        // Check every minute for due announcements
        this.checkInterval = setInterval(() => {
            this.checkDueAnnouncements();
        }, 60 * 1000);
        logger_1.default.info('[ScheduledAnnouncementsManager] Scheduler started (60s interval)');
    }
    stopScheduler() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            logger_1.default.info('[ScheduledAnnouncementsManager] Scheduler stopped');
        }
    }
    async checkDueAnnouncements() {
        try {
            const [announcements] = await db_1.default.execute('SELECT * FROM scheduled_announcements WHERE enabled = 1 AND next_run <= NOW()');
            if (announcements.length === 0)
                return;
            logger_1.default.info(`[ScheduledAnnouncementsManager] Found ${announcements.length} due announcements`);
            for (const announcement of announcements) {
                await this.sendAnnouncement(announcement);
            }
        }
        catch (error) {
            logger_1.default.error(`[ScheduledAnnouncementsManager] Error checking announcements: ${error.message}`);
        }
    }
    async sendAnnouncement(announcement) {
        try {
            const guild = this.client.guilds.cache.get(announcement.guild_id);
            if (!guild) {
                logger_1.default.warn(`[ScheduledAnnouncementsManager] Guild ${announcement.guild_id} not found, disabling announcement ${announcement.id}`);
                await db_1.default.execute('UPDATE scheduled_announcements SET enabled = 0 WHERE id = ?', [announcement.id]);
                return;
            }
            const channel = guild.channels.cache.get(announcement.channel_id);
            if (!channel) {
                logger_1.default.warn(`[ScheduledAnnouncementsManager] Channel ${announcement.channel_id} not found, disabling announcement ${announcement.id}`);
                await db_1.default.execute('UPDATE scheduled_announcements SET enabled = 0 WHERE id = ?', [announcement.id]);
                return;
            }
            // Prepare message
            const messageOptions = { content: announcement.message_content };
            // Add embed if configured
            if (announcement.embed_data) {
                try {
                    const embedData = JSON.parse(announcement.embed_data);
                    const embed = new discord_js_1.EmbedBuilder(embedData);
                    messageOptions.embeds = [embed];
                }
                catch (embedError) {
                    logger_1.default.error(`[ScheduledAnnouncementsManager] Failed to parse embed data: ${embedError.message}`);
                }
            }
            // Send the announcement
            await channel.send(messageOptions);
            // Update last run and calculate next run
            const nextRun = this.calculateNextRun(announcement);
            await db_1.default.execute('UPDATE scheduled_announcements SET last_run = NOW(), run_count = run_count + 1, next_run = ? WHERE id = ?', [nextRun, announcement.id]);
            logger_1.default.info(`[ScheduledAnnouncementsManager] Sent announcement ${announcement.id} to ${channel.name}`, {
                guildId: guild.id,
                announcementId: announcement.id
            });
        }
        catch (error) {
            logger_1.default.error(`[ScheduledAnnouncementsManager] Failed to send announcement ${announcement.id}: ${error.message}`, {
                announcementId: announcement.id,
                error: error.message
            });
        }
    }
    calculateNextRun(announcement) {
        const now = new Date();
        switch (announcement.schedule_type) {
            case 'once':
                // Disable one-time announcements
                db_1.default.execute('UPDATE scheduled_announcements SET enabled = 0 WHERE id = ?', [announcement.id]);
                return null;
            case 'daily':
                // schedule_value is time in HH:MM format
                const [hours, minutes] = announcement.schedule_value.split(':');
                const next = new Date(now);
                next.setHours(parseInt(hours), parseInt(minutes), 0, 0);
                if (next <= now)
                    next.setDate(next.getDate() + 1);
                return next;
            case 'weekly':
                // schedule_value is "DAY HH:MM" format (e.g., "Monday 15:00")
                const [day, time] = announcement.schedule_value.split(' ');
                const [h, m] = time.split(':');
                const dayMap = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
                const targetDay = dayMap[day];
                const nextWeekly = new Date(now);
                nextWeekly.setHours(parseInt(h), parseInt(m), 0, 0);
                const daysUntil = (targetDay - nextWeekly.getDay() + 7) % 7;
                if (daysUntil === 0 && nextWeekly <= now) {
                    nextWeekly.setDate(nextWeekly.getDate() + 7);
                }
                else {
                    nextWeekly.setDate(nextWeekly.getDate() + daysUntil);
                }
                return nextWeekly;
            case 'monthly':
                // schedule_value is "DD HH:MM" format (e.g., "15 12:00" for 15th day at noon)
                const [dayOfMonth, monthlyTime] = announcement.schedule_value.split(' ');
                const [mh, mm] = monthlyTime.split(':');
                const nextMonthly = new Date(now);
                nextMonthly.setDate(parseInt(dayOfMonth));
                nextMonthly.setHours(parseInt(mh), parseInt(mm), 0, 0);
                if (nextMonthly <= now) {
                    nextMonthly.setMonth(nextMonthly.getMonth() + 1);
                }
                return nextMonthly;
            case 'interval':
                // schedule_value is interval in minutes
                const intervalMinutes = parseInt(announcement.schedule_value);
                const nextInterval = new Date(now.getTime() + intervalMinutes * 60000);
                return nextInterval;
            default:
                return null;
        }
    }
    async createAnnouncement(guildId, channelId, messageContent, scheduleType, scheduleValue, embedData, createdBy) {
        try {
            const nextRun = this.calculateNextRunFromParams(scheduleType, scheduleValue);
            const [result] = await db_1.default.execute(`
                INSERT INTO scheduled_announcements
                (guild_id, channel_id, message_content, embed_data, schedule_type, schedule_value, next_run, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [guildId, channelId, messageContent, embedData ? JSON.stringify(embedData) : null, scheduleType, scheduleValue, nextRun, createdBy]);
            logger_1.default.info(`[ScheduledAnnouncementsManager] Created announcement ${result.insertId}`, { guildId, scheduleType });
            return result.insertId;
        }
        catch (error) {
            logger_1.default.error(`[ScheduledAnnouncementsManager] Failed to create announcement: ${error.message}`, { guildId });
            throw error;
        }
    }
    calculateNextRunFromParams(scheduleType, scheduleValue) {
        const now = new Date();
        switch (scheduleType) {
            case 'once':
                // For one-time, schedule_value should be a timestamp or date string
                return new Date(scheduleValue);
            case 'daily':
                const [hours, minutes] = scheduleValue.split(':');
                const next = new Date(now);
                next.setHours(parseInt(hours), parseInt(minutes), 0, 0);
                if (next <= now)
                    next.setDate(next.getDate() + 1);
                return next;
            case 'weekly':
                const [day, time] = scheduleValue.split(' ');
                const [h, m] = time.split(':');
                const dayMap = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
                const targetDay = dayMap[day];
                const nextWeekly = new Date(now);
                nextWeekly.setHours(parseInt(h), parseInt(m), 0, 0);
                const daysUntil = (targetDay - nextWeekly.getDay() + 7) % 7;
                if (daysUntil === 0 && nextWeekly <= now) {
                    nextWeekly.setDate(nextWeekly.getDate() + 7);
                }
                else {
                    nextWeekly.setDate(nextWeekly.getDate() + daysUntil);
                }
                return nextWeekly;
            case 'monthly':
                const [dayOfMonth, monthlyTime] = scheduleValue.split(' ');
                const [mh, mm] = monthlyTime.split(':');
                const nextMonthly = new Date(now);
                nextMonthly.setDate(parseInt(dayOfMonth));
                nextMonthly.setHours(parseInt(mh), parseInt(mm), 0, 0);
                if (nextMonthly <= now) {
                    nextMonthly.setMonth(nextMonthly.getMonth() + 1);
                }
                return nextMonthly;
            case 'interval':
                const intervalMinutes = parseInt(scheduleValue);
                return new Date(now.getTime() + intervalMinutes * 60000);
            default:
                return now;
        }
    }
    async deleteAnnouncement(announcementId) {
        try {
            await db_1.default.execute('DELETE FROM scheduled_announcements WHERE id = ?', [announcementId]);
            logger_1.default.info(`[ScheduledAnnouncementsManager] Deleted announcement ${announcementId}`);
            return true;
        }
        catch (error) {
            logger_1.default.error(`[ScheduledAnnouncementsManager] Failed to delete announcement: ${error.message}`);
            return false;
        }
    }
    async toggleAnnouncement(announcementId, enabled) {
        try {
            await db_1.default.execute('UPDATE scheduled_announcements SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, announcementId]);
            logger_1.default.info(`[ScheduledAnnouncementsManager] Toggled announcement ${announcementId} to ${enabled}`);
            return true;
        }
        catch (error) {
            logger_1.default.error(`[ScheduledAnnouncementsManager] Failed to toggle announcement: ${error.message}`);
            return false;
        }
    }
    async getGuildAnnouncements(guildId) {
        try {
            const [announcements] = await db_1.default.execute('SELECT * FROM scheduled_announcements WHERE guild_id = ? ORDER BY next_run ASC', [guildId]);
            return announcements;
        }
        catch (error) {
            logger_1.default.error(`[ScheduledAnnouncementsManager] Failed to get announcements: ${error.message}`, { guildId });
            return [];
        }
    }
}
module.exports = ScheduledAnnouncementsManager;
