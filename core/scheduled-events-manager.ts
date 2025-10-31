import { Client, GuildScheduledEvent, GuildScheduledEventPrivacyLevel, GuildScheduledEventEntityType, User } from 'discord.js';
import { RowDataPacket } from 'mysql2';
import db from '../utils/db';
import logger from '../utils/logger';

interface EventData {
    name: string;
    description: string;
    scheduledStart: Date;
    scheduledEnd?: Date;
    type: 'voice' | 'stage' | 'external';
    channelId?: string;
    location?: string;
    creatorId: string;
    templateName?: string;
    durationMinutes?: number;
}

interface RecurrenceRule {
    frequency: 'daily' | 'weekly' | 'monthly';
    interval?: number;
    dayOfWeek?: number;
    timeOfDay?: string;
}

interface RecurringEventRow extends RowDataPacket {
    id: number;
    guild_id: string;
    event_name: string;
    description: string;
    event_type: 'voice' | 'stage' | 'external';
    channel_id: string | null;
    location: string | null;
    duration_minutes: number;
    recurrence_rule: string;
    next_scheduled: Date;
    creator_id: string;
}

interface CreateEventResult {
    success: boolean;
    event?: GuildScheduledEvent;
    error?: string;
    message?: string;
}

class ScheduledEventsManager {
    private client: Client;
    private checkInterval: NodeJS.Timeout | null = null;

    constructor(client: Client) {
        this.client = client;
    }

    async init(): Promise<void> {
        logger.info('[ScheduledEvents] Initializing Scheduled Events Manager...');

        this.client.on('guildScheduledEventCreate', (event) => this.handleEventCreate(event));
        this.client.on('guildScheduledEventUpdate', (oldEvent, newEvent) => this.handleEventUpdate(oldEvent, newEvent));
        this.client.on('guildScheduledEventDelete', (event) => this.handleEventDelete(event));
        this.client.on('guildScheduledEventUserAdd', (event, user) => this.handleUserSubscribe(event, user));
        this.client.on('guildScheduledEventUserRemove', (event, user) => this.handleUserUnsubscribe(event, user));

        this.checkInterval = setInterval(() => this.checkRecurringEvents(), 300000);
        await this.checkRecurringEvents();

        logger.info('[ScheduledEvents] Scheduled Events Manager initialized');
    }

    async createEvent(guildId: string, eventData: EventData): Promise<CreateEventResult> {
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild) return { success: false, error: 'Guild not found' };

            const eventOptions: any = {
                name: eventData.name,
                description: eventData.description,
                scheduledStartTime: eventData.scheduledStart,
                scheduledEndTime: eventData.scheduledEnd,
                privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
                entityType: this.getEntityType(eventData.type),
                reason: `Created by ${eventData.creatorId}`
            };

            if (eventData.type === 'voice' || eventData.type === 'stage') {
                eventOptions.channel = eventData.channelId;
            } else if (eventData.type === 'external') {
                eventOptions.entityMetadata = { location: eventData.location };
            }

            const event = await guild.scheduledEvents.create(eventOptions);

            await db.execute(`INSERT INTO scheduled_events_config
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

            logger.info(`[ScheduledEvents] Created event: ${eventData.name} (${event.id})`);
            return { success: true, event };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(_error);
            logger.error('[ScheduledEvents] Error creating event:', error as Record<string, any>);
            return { success: false, error: errorMessage };
        }
    }

    async createRecurringEvent(guildId: string, eventData: EventData, recurrenceRule: RecurrenceRule): Promise<CreateEventResult> {
        try {
            await db.execute(`INSERT INTO recurring_events
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

            logger.info(`[ScheduledEvents] Created recurring event template: ${eventData.templateName}`);
            return { success: true, message: 'Recurring event template created' };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(_error);
            logger.error('[ScheduledEvents] Error creating recurring event:', error as Record<string, any>);
            return { success: false, error: errorMessage };
        }
    }

    async checkRecurringEvents(): Promise<void> {
        try {
            const [events] = await db.execute<RecurringEventRow[]>(`SELECT * FROM recurring_events
                 WHERE next_scheduled <= NOW() AND active = TRUE`);

            for (const recurringEvent of events) {
                const eventData: EventData = {
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
                    const recurrenceRule: RecurrenceRule = JSON.parse(recurringEvent.recurrence_rule);
                    const nextOccurrence = this.calculateNextOccurrence(recurrenceRule, new Date(recurringEvent.next_scheduled));

                    await db.execute(`UPDATE recurring_events
                         SET last_created_event_id = ?, last_created_at = NOW(), next_scheduled = ?
                         WHERE id = ?`, [result.event.id, nextOccurrence, recurringEvent.id]);

                    logger.info(`[ScheduledEvents] Created recurring event instance: ${eventData.name}`);
                }
            }
        } catch (error) {
            logger.error('[ScheduledEvents] Error checking recurring events:', error as Record<string, any>);
        }
    }

    calculateNextOccurrence(recurrenceRule: RecurrenceRule, fromDate: Date = new Date()): Date {
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

    getEntityType(type: 'voice' | 'stage' | 'external'): GuildScheduledEventEntityType {
        switch (type) {
            case 'voice':
                return GuildScheduledEventEntityType.Voice;
            case 'stage':
                return GuildScheduledEventEntityType.StageInstance;
            case 'external':
                return GuildScheduledEventEntityType.External;
            default:
                return GuildScheduledEventEntityType.External;
        }
    }

    async handleEventCreate(event: GuildScheduledEvent): Promise<void> {
        logger.info(`[ScheduledEvents] Event created: ${event.name} (${event.id})`);
    }

    async handleEventUpdate(oldEvent: GuildScheduledEvent | null, newEvent: GuildScheduledEvent): Promise<void> {
        try {
            await db.execute(`UPDATE scheduled_events_config
                 SET event_name = ?, description = ?, scheduled_start = ?, scheduled_end = ?
                 WHERE event_id = ?`, [
                newEvent.name,
                newEvent.description,
                newEvent.scheduledStartAt,
                newEvent.scheduledEndAt,
                newEvent.id
            ]);

            logger.info(`[ScheduledEvents] Event updated: ${newEvent.name} (${newEvent.id})`);
        } catch (error) {
            logger.error('[ScheduledEvents] Error handling event update:', error as Record<string, any>);
        }
    }

    async handleEventDelete(event: GuildScheduledEvent): Promise<void> {
        try {
            await db.execute('DELETE FROM scheduled_events_config WHERE event_id = ?', [event.id]);
            await db.execute('DELETE FROM event_subscriptions WHERE event_id = ?', [event.id]);

            logger.info(`[ScheduledEvents] Event deleted: ${event.id}`);
        } catch (error) {
            logger.error('[ScheduledEvents] Error handling event delete:', error as Record<string, any>);
        }
    }

    async handleUserSubscribe(event: GuildScheduledEvent, user: User): Promise<void> {
        try {
            await db.execute(`INSERT IGNORE INTO event_subscriptions (event_id, user_id)
                 VALUES (?, ?)`, [event.id, user.id]);

            logger.info(`[ScheduledEvents] User ${user.id} subscribed to event ${event.id}`);
        } catch (error) {
            logger.error('[ScheduledEvents] Error handling user subscribe:', error as Record<string, any>);
        }
    }

    async handleUserUnsubscribe(event: GuildScheduledEvent, user: User): Promise<void> {
        try {
            await db.execute('DELETE FROM event_subscriptions WHERE event_id = ? AND user_id = ?', [event.id, user.id]);

            logger.info(`[ScheduledEvents] User ${user.id} unsubscribed from event ${event.id}`);
        } catch (error) {
            logger.error('[ScheduledEvents] Error handling user unsubscribe:', error as Record<string, any>);
        }
    }

    shutdown(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
        }
        logger.info('[ScheduledEvents] Scheduled Events Manager shut down');
    }
}

export default ScheduledEventsManager;
