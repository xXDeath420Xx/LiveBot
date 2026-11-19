/*
 * Pure decisions behind Discord scheduled-event reminders, start announcements and recurring
 * templates. No discord.js or database here, so the timing rules can be unit-tested directly
 * (tests/event-reminders.test.js). core/event-reminder-manager.js does the I/O.
 */

export const FEATURE_KEY = 'event-reminders';

export const DEFAULT_LEAD_MINUTES = 30;
export const MIN_LEAD_MINUTES = 5;
export const MAX_LEAD_MINUTES = 1440;

/** Start announcements are only made this close to the start; a bot that was down longer stays quiet. */
export const START_ANNOUNCE_GRACE_MS = 15 * 60_000;

/** Discord GuildScheduledEventStatus → stored status. */
export const STATUS_NAMES = Object.freeze({ 1: 'scheduled', 2: 'active', 3: 'completed', 4: 'canceled' });
export const FINAL_STATUSES = Object.freeze(['completed', 'canceled', 'deleted']);

/** Discord GuildScheduledEventEntityType ↔ the enum('voice','stage','external') column. */
const ENTITY_TO_COLUMN = Object.freeze({ 1: 'stage', 2: 'voice', 3: 'external' });
const COLUMN_TO_ENTITY = Object.freeze({ stage: 1, voice: 2, external: 3 });

export function entityTypeToColumn(entityType) {
    return ENTITY_TO_COLUMN[Number(entityType)] || 'external';
}

export function columnToEntityType(column) {
    return COLUMN_TO_ENTITY[column] || 3;
}

export function statusName(status) {
    return STATUS_NAMES[Number(status)] || 'scheduled';
}

function truthy(v) {
    return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

function snowflakeOrNull(v) {
    const s = v == null ? '' : String(v).trim();
    return /^\d{15,25}$/.test(s) ? s : null;
}

/**
 * Normalise a guild's stored feature config (guild_feature_config JSON, possibly empty) into the
 * settings the runtime uses. Everything that sends anything defaults OFF.
 */
export function normaliseEventConfig(raw = {}) {
    const cfg = raw && typeof raw === 'object' ? raw : {};
    let lead = Math.round(Number(cfg.reminder_minutes));
    if (!Number.isFinite(lead) || lead <= 0) lead = DEFAULT_LEAD_MINUTES;
    lead = Math.min(MAX_LEAD_MINUTES, Math.max(MIN_LEAD_MINUTES, lead));

    const channelId = snowflakeOrNull(cfg.announce_channel_id);
    return {
        dmEnabled: truthy(cfg.dm_reminders_enabled),
        leadMinutes: lead,
        announceEnabled: truthy(cfg.announce_enabled) && !!channelId,
        announceChannelId: channelId,
        announceRoleId: snowflakeOrNull(cfg.announce_role_id),
    };
}

/** Is it time to send the "starting soon" DMs? Only between (start - lead) and start. */
export function reminderDue({ startMs, nowMs, leadMinutes }) {
    if (!Number.isFinite(startMs)) return false;
    return nowMs >= startMs - leadMinutes * 60_000 && nowMs < startMs;
}

/** Should a start announcement still go out? From the start until the grace window closes. */
export function startAnnouncementDue({ startMs, nowMs, graceMs = START_ANNOUNCE_GRACE_MS }) {
    if (!Number.isFinite(startMs)) return false;
    return nowMs >= startMs && nowMs - startMs <= graceMs;
}

/**
 * Has an occurrence of a recurring template finished, so the next one may be created?
 * Ended = Discord says completed/canceled/deleted, or its planned end has passed (an admin who
 * never presses "End event" must not stall the series).
 */
export function occurrenceEnded({ status, startMs, endMs = null, durationMinutes = 60, nowMs }) {
    if (FINAL_STATUSES.includes(status)) return true;
    const plannedEnd = Number.isFinite(endMs) && endMs > 0
        ? endMs
        : startMs + Math.max(1, Number(durationMinutes) || 60) * 60_000;
    return Number.isFinite(plannedEnd) && nowMs >= plannedEnd;
}

/**
 * When an existing event is edited, decide whether its reminder/announcement flags should be
 * re-armed. Moving the start by more than a minute into the future re-arms both so the new time
 * gets its own reminder; anything else (renames, description edits) leaves them alone.
 */
export function shouldRearm({ oldStartMs, newStartMs, nowMs }) {
    if (!Number.isFinite(oldStartMs) || !Number.isFinite(newStartMs)) return false;
    if (Math.abs(newStartMs - oldStartMs) <= 60_000) return false;
    return newStartMs > nowMs;
}

/**
 * Sliding-window limiter for reminder DMs to one user. Returns true and records the send if the
 * user is under `max` in the last `windowMs`; false otherwise. `log` is a Map userId -> number[].
 */
export function allowUserDm(log, userId, nowMs, { max = 6, windowMs = 3_600_000 } = {}) {
    const recent = (log.get(userId) || []).filter((t) => nowMs - t < windowMs);
    if (recent.length >= max) {
        log.set(userId, recent);
        return false;
    }
    recent.push(nowMs);
    log.set(userId, recent);
    return true;
}

/** Link that opens an event in the Discord client. */
export function eventUrl(guildId, eventId) {
    return `https://discord.com/events/${guildId}/${eventId}`;
}

export default {
    FEATURE_KEY, DEFAULT_LEAD_MINUTES, MIN_LEAD_MINUTES, MAX_LEAD_MINUTES, START_ANNOUNCE_GRACE_MS,
    STATUS_NAMES, FINAL_STATUSES, entityTypeToColumn, columnToEntityType, statusName,
    normaliseEventConfig, reminderDue, startAnnouncementDue, occurrenceEnded, shouldRearm,
    allowUserDm, eventUrl,
};
