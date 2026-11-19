/**
 * Guild Scheduled Events CRUD — wraps discord.js's `guild.scheduledEvents`.
 *
 *   GET    /                  — list every scheduled event
 *   POST   /                  — create one (voice/stage/external)
 *   PATCH  /:eventId          — edit name, timing, description, image
 *   DELETE /:eventId          — delete
 *
 * The ingest-side event handlers already live under `events/guildScheduledEvent*.js`;
 * this surface is for the dashboard page.
 *
 * All routes gated by `apiCheckGuildAdmin` at the parent router.
 */
import express from 'express';
import {
    PermissionFlagsBits,
    GuildScheduledEventEntityType,
    GuildScheduledEventPrivacyLevel,
    GuildScheduledEventStatus,
    GuildScheduledEventRecurrenceRuleFrequency,
} from 'discord.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;

const ENTITY_LABEL = {
    [GuildScheduledEventEntityType.StageInstance]: 'STAGE_INSTANCE',
    [GuildScheduledEventEntityType.Voice]: 'VOICE',
    [GuildScheduledEventEntityType.External]: 'EXTERNAL',
};

const STATUS_LABEL = {
    [GuildScheduledEventStatus.Scheduled]: 'SCHEDULED',
    [GuildScheduledEventStatus.Active]: 'ACTIVE',
    [GuildScheduledEventStatus.Completed]: 'COMPLETED',
    [GuildScheduledEventStatus.Canceled]: 'CANCELED',
};

function serialiseEvent(e) {
    return {
        id: e.id,
        guildId: e.guildId,
        channelId: e.channelId,
        creatorId: e.creatorId,
        name: e.name,
        description: e.description,
        scheduledStart: e.scheduledStartTimestamp ? new Date(e.scheduledStartTimestamp).toISOString() : null,
        scheduledEnd: e.scheduledEndTimestamp ? new Date(e.scheduledEndTimestamp).toISOString() : null,
        privacyLevel: e.privacyLevel,
        status: e.status,
        statusName: STATUS_LABEL[e.status] ?? String(e.status),
        entityType: e.entityType,
        entityTypeName: ENTITY_LABEL[e.entityType] ?? String(e.entityType),
        entityId: e.entityId,
        entityMetadata: e.entityMetadata,
        userCount: e.userCount,
        imageURL: e.image ? e.coverImageURL({ size: 1024 }) : null,
        recurrenceRule: e.recurrenceRule ? {
            frequency: e.recurrenceRule.frequency,
            interval: e.recurrenceRule.interval,
            byWeekday: e.recurrenceRule.byWeekday,
            byMonth: e.recurrenceRule.byMonth,
            byMonthDay: e.recurrenceRule.byMonthDay,
            count: e.recurrenceRule.count,
            start: e.recurrenceRule.start,
            end: e.recurrenceRule.end,
        } : null,
    };
}

function requireManageEvents(req, res) {
    const me = req.guildObject?.members?.me;
    if (!me?.permissions?.has(PermissionFlagsBits.ManageEvents)) {
        res.status(403).json({ error: 'The bot needs Manage Events to create or edit scheduled events.' });
        return false;
    }
    return true;
}

/** Shared validator — minimal structural checks, Discord does the deep ones. */
function validateEventBody(body, { isCreate }) {
    const out = {};
    if (isCreate || body.name !== undefined) {
        if (typeof body.name !== 'string' || body.name.trim().length < 1) return { error: 'A name is required (1–100 chars).' };
        out.name = body.name.trim().slice(0, 100);
    }
    if (body.description !== undefined) out.description = body.description === null ? null : String(body.description).slice(0, 1000);
    if (body.scheduledStartTime !== undefined) {
        const d = new Date(body.scheduledStartTime);
        if (Number.isNaN(d.getTime())) return { error: 'scheduledStartTime must be an ISO date.' };
        out.scheduledStartTime = d;
    } else if (isCreate) return { error: 'scheduledStartTime is required.' };
    if (body.scheduledEndTime !== undefined) {
        const d = body.scheduledEndTime === null ? null : new Date(body.scheduledEndTime);
        if (d && Number.isNaN(d.getTime())) return { error: 'scheduledEndTime must be an ISO date or null.' };
        out.scheduledEndTime = d;
    }
    if (body.entityType !== undefined) {
        const t = Number(body.entityType);
        if (!(t in ENTITY_LABEL)) return { error: 'entityType must be 1 (STAGE_INSTANCE), 2 (VOICE) or 3 (EXTERNAL).' };
        out.entityType = t;
    } else if (isCreate) return { error: 'entityType is required.' };
    if (body.channelId !== undefined) {
        if (body.channelId !== null && !SNOWFLAKE.test(String(body.channelId))) return { error: 'channelId must be a snowflake or null.' };
        out.channel = body.channelId;
    }
    if (body.entityMetadata !== undefined) out.entityMetadata = body.entityMetadata;
    if (body.privacyLevel !== undefined) out.privacyLevel = Number(body.privacyLevel) || GuildScheduledEventPrivacyLevel.GuildOnly;
    else if (isCreate) out.privacyLevel = GuildScheduledEventPrivacyLevel.GuildOnly;
    if (body.image !== undefined) out.image = body.image;
    if (body.status !== undefined && !isCreate) out.status = Number(body.status);
    if (body.reason) out.reason = String(body.reason).slice(0, 512);

    // Recurrence rule (new 2024 field)
    if (body.recurrenceRule !== undefined) {
        if (body.recurrenceRule === null) out.recurrenceRule = null;
        else {
            const r = body.recurrenceRule;
            const freq = Number(r.frequency);
            if (!(freq in GuildScheduledEventRecurrenceRuleFrequency)) return { error: 'recurrenceRule.frequency must be a valid frequency enum.' };
            out.recurrenceRule = {
                frequency: freq,
                interval: Math.max(1, Number(r.interval) || 1),
                byWeekday: Array.isArray(r.byWeekday) ? r.byWeekday.map(Number) : null,
                byMonth: Array.isArray(r.byMonth) ? r.byMonth.map(Number) : null,
                byMonthDay: Array.isArray(r.byMonthDay) ? r.byMonthDay.map(Number) : null,
                byYearDay: Array.isArray(r.byYearDay) ? r.byYearDay.map(Number) : null,
                count: r.count === null ? null : Number(r.count) || null,
                startAt: r.startAt ? new Date(r.startAt) : undefined,
            };
        }
    }

    return { data: out };
}

/** GET / */
router.get('/', async (req, res) => {
    try {
        if (!requireManageEvents(req, res)) return;
        const events = await req.guildObject.scheduledEvents.fetch();
        res.json({
            events: [...events.values()].map(serialiseEvent),
            entityTypes: ENTITY_LABEL,
            statuses: STATUS_LABEL,
        });
    } catch (err) {
        logger.error('[API scheduled-events GET] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Failed to fetch events' });
    }
});

/** POST / */
router.post('/', async (req, res) => {
    try {
        if (!requireManageEvents(req, res)) return;
        const { data, error } = validateEventBody(req.body || {}, { isCreate: true });
        if (error) return res.status(400).json({ error });
        const created = await req.guildObject.scheduledEvents.create(data);
        logger.info('[API scheduled-events POST] created', { guildId: req.params.guildId, eventId: created.id, by: req.user?.id });
        res.json({ success: true, event: serialiseEvent(created) });
    } catch (err) {
        if (err?.code === 50013) return res.status(403).json({ error: 'Discord refused — missing permission.' });
        logger.error('[API scheduled-events POST] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Failed to create event' });
    }
});

/** PATCH /:eventId */
router.patch('/:eventId', async (req, res) => {
    try {
        if (!requireManageEvents(req, res)) return;
        const eventId = req.params.eventId;
        if (!SNOWFLAKE.test(String(eventId))) return res.status(400).json({ error: 'Invalid event id.' });
        const { data, error } = validateEventBody(req.body || {}, { isCreate: false });
        if (error) return res.status(400).json({ error });
        const edited = await req.guildObject.scheduledEvents.edit(eventId, data);
        logger.info('[API scheduled-events PATCH] updated', { guildId: req.params.guildId, eventId, by: req.user?.id });
        res.json({ success: true, event: serialiseEvent(edited) });
    } catch (err) {
        if (err?.code === 10066) return res.status(404).json({ error: 'That event no longer exists.' });
        if (err?.code === 50013) return res.status(403).json({ error: 'Discord refused — missing permission.' });
        logger.error('[API scheduled-events PATCH] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Failed to update event' });
    }
});

/** DELETE /:eventId */
router.delete('/:eventId', async (req, res) => {
    try {
        if (!requireManageEvents(req, res)) return;
        const eventId = req.params.eventId;
        if (!SNOWFLAKE.test(String(eventId))) return res.status(400).json({ error: 'Invalid event id.' });
        await req.guildObject.scheduledEvents.delete(eventId);
        logger.info('[API scheduled-events DELETE] removed', { guildId: req.params.guildId, eventId, by: req.user?.id });
        res.json({ success: true });
    } catch (err) {
        if (err?.code === 10066) return res.status(404).json({ error: 'That event no longer exists.' });
        if (err?.code === 50013) return res.status(403).json({ error: 'Discord refused — missing permission.' });
        logger.error('[API scheduled-events DELETE] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Failed to delete event' });
    }
});

export default router;
