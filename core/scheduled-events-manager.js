"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
class ScheduledEventsManager {
    constructor(client) {
        this.checkInterval = null;
        this.client = client;
    }
    async init() {
        logger_1.default.info('[ScheduledEvents] Initializing Scheduled Events Manager...');
        this.client.on('guildScheduledEventCreate', (event) => this.handleEventCreate(event));
        this.client.on('guildScheduledEventUpdate', (oldEvent, newEvent) => this.handleEventUpdate(oldEvent, newEvent));
        this.client.on('guildScheduledEventDelete', (event) => this.handleEventDelete(event));
        this.client.on('guildScheduledEventUserAdd', (event, user) => this.handleUserSubscribe(event, user));
        this.client.on('guildScheduledEventUserRemove', (event, user) => this.handleUserUnsubscribe(event, user));
        this.checkInterval = setInterval(() => this.checkRecurringEvents(), 300000);
        await this.checkRecurringEvents();
        logger_1.default.info('[ScheduledEvents] Scheduled Events Manager initialized');
    }
    async createEvent(guildId, eventData) {
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild)
                return { success: false, error: 'Guild not found' };
            const eventOptions = {
                name: eventData.name,
                description: eventData.description,
                scheduledStartTime: eventData.scheduledStart,
                scheduledEndTime: eventData.scheduledEnd,
                privacyLevel: discord_js_1.GuildScheduledEventPrivacyLevel.GuildOnly,
                entityType: this.getEntityType(eventData.type),
                reason: `Created by ${eventData.creatorId}`
            };
            if (eventData.type === 'voice' || eventData.type === 'stage') {
                eventOptions.channel = eventData.channelId;
            }
            else if (eventData.type === 'external') {
                eventOptions.entityMetadata = { location: eventData.location };
            }
            const event = await guild.scheduledEvents.create(eventOptions);
            await db_1.default.execute(`INSERT INTO scheduled_events_config
                (guild_id, event_id, event_name, description, scheduled_start, scheduled_end,
                 event_type, channel_id, location, creator_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                guildId,
                event.id,
                eventData.name,
                eventData.description,
                eventData.scheduledStart,
                eventData.scheduledEnd || null,
                eventData.type,
                eventData.channelId || null,
                eventData.location || null,
                eventData.creatorId
            ]);
            logger_1.default.info(`[ScheduledEvents] Created event: ${eventData.name} (${event.id})`);
            return { success: true, event };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error('[ScheduledEvents] Error creating event:', error);
            return { success: false, error: errorMessage };
        }
    }
    async createRecurringEvent(guildId, eventData, recurrenceRule) {
        try {
            await db_1.default.execute(`INSERT INTO recurring_events
                (guild_id, template_name, event_name, description, event_type, channel_id,
                 location, duration_minutes, recurrence_rule, next_scheduled, creator_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                guildId,
                eventData.templateName,
                eventData.name,
                eventData.description,
                eventData.type,
                eventData.channelId || null,
                eventData.location || null,
                eventData.durationMinutes || 60,
                JSON.stringify(recurrenceRule),
                this.calculateNextOccurrence(recurrenceRule),
                eventData.creatorId
            ]);
            logger_1.default.info(`[ScheduledEvents] Created recurring event template: ${eventData.templateName}`);
            return { success: true, message: 'Recurring event template created' };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error('[ScheduledEvents] Error creating recurring event:', error);
            return { success: false, error: errorMessage };
        }
    }
    async checkRecurringEvents() {
        try {
            const [events] = await db_1.default.execute(`SELECT * FROM recurring_events
                 WHERE next_scheduled <= NOW() AND active = TRUE`);
            for (const recurringEvent of events) {
                const eventData = {
                    name: recurringEvent.event_name,
                    description: recurringEvent.description,
                    scheduledStart: new Date(recurringEvent.next_scheduled),
                    scheduledEnd: new Date(new Date(recurringEvent.next_scheduled).getTime() + (recurringEvent.duration_minutes * 60000)),
                    type: recurringEvent.event_type,
                    channelId: recurringEvent.channel_id || undefined,
                    location: recurringEvent.location || undefined,
                    creatorId: recurringEvent.creator_id
                };
                const result = await this.createEvent(recurringEvent.guild_id, eventData);
                if (result.success && result.event) {
                    const recurrenceRule = JSON.parse(recurringEvent.recurrence_rule);
                    const nextOccurrence = this.calculateNextOccurrence(recurrenceRule, new Date(recurringEvent.next_scheduled));
                    await db_1.default.execute(`UPDATE recurring_events
                         SET last_created_event_id = ?, last_created_at = NOW(), next_scheduled = ?
                         WHERE id = ?`, [result.event.id, nextOccurrence, recurringEvent.id]);
                    logger_1.default.info(`[ScheduledEvents] Created recurring event instance: ${eventData.name}`);
                }
            }
        }
        catch (error) {
            logger_1.default.error('[ScheduledEvents] Error checking recurring events:', error);
        }
    }
    calculateNextOccurrence(recurrenceRule, fromDate = new Date()) {
        const { frequency, interval, dayOfWeek, timeOfDay } = recurrenceRule;
        const next = new Date(fromDate);
        switch (frequency) {
            case 'daily':
                next.setDate(next.getDate() + (interval || 1));
                break;
            case 'weekly':
                next.setDate(next.getDate() + 7 * (interval || 1));
                if (dayOfWeek !== undefined) {
                    while (next.getDay() !== dayOfWeek) {
                        next.setDate(next.getDate() + 1);
                    }
                }
                break;
            case 'monthly':
                next.setMonth(next.getMonth() + (interval || 1));
                break;
        }
        if (timeOfDay) {
            const [hours, minutes] = timeOfDay.split(':');
            next.setHours(parseInt(hours), parseInt(minutes), 0, 0);
        }
        return next;
    }
    getEntityType(type) {
        switch (type) {
            case 'voice':
                return discord_js_1.GuildScheduledEventEntityType.Voice;
            case 'stage':
                return discord_js_1.GuildScheduledEventEntityType.StageInstance;
            case 'external':
                return discord_js_1.GuildScheduledEventEntityType.External;
            default:
                return discord_js_1.GuildScheduledEventEntityType.External;
        }
    }
    async handleEventCreate(event) {
        logger_1.default.info(`[ScheduledEvents] Event created: ${event.name} (${event.id})`);
    }
    async handleEventUpdate(oldEvent, newEvent) {
        try {
            await db_1.default.execute(`UPDATE scheduled_events_config
                 SET event_name = ?, description = ?, scheduled_start = ?, scheduled_end = ?
                 WHERE event_id = ?`, [
                newEvent.name,
                newEvent.description,
                newEvent.scheduledStartAt,
                newEvent.scheduledEndAt,
                newEvent.id
            ]);
            logger_1.default.info(`[ScheduledEvents] Event updated: ${newEvent.name} (${newEvent.id})`);
        }
        catch (error) {
            logger_1.default.error('[ScheduledEvents] Error handling event update:', error);
        }
    }
    async handleEventDelete(event) {
        try {
            await db_1.default.execute('DELETE FROM scheduled_events_config WHERE event_id = ?', [event.id]);
            await db_1.default.execute('DELETE FROM event_subscriptions WHERE event_id = ?', [event.id]);
            logger_1.default.info(`[ScheduledEvents] Event deleted: ${event.id}`);
        }
        catch (error) {
            logger_1.default.error('[ScheduledEvents] Error handling event delete:', error);
        }
    }
    async handleUserSubscribe(event, user) {
        try {
            await db_1.default.execute(`INSERT IGNORE INTO event_subscriptions (event_id, user_id)
                 VALUES (?, ?)`, [event.id, user.id]);
            logger_1.default.info(`[ScheduledEvents] User ${user.id} subscribed to event ${event.id}`);
        }
        catch (error) {
            logger_1.default.error('[ScheduledEvents] Error handling user subscribe:', error);
        }
    }
    async handleUserUnsubscribe(event, user) {
        try {
            await db_1.default.execute('DELETE FROM event_subscriptions WHERE event_id = ? AND user_id = ?', [event.id, user.id]);
            logger_1.default.info(`[ScheduledEvents] User ${user.id} unsubscribed from event ${event.id}`);
        }
        catch (error) {
            logger_1.default.error('[ScheduledEvents] Error handling user unsubscribe:', error);
        }
    }
    shutdown() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
        }
        logger_1.default.info('[ScheduledEvents] Scheduled Events Manager shut down');
    }
}
exports.default = ScheduledEventsManager;
