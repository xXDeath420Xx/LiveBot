/*
 * Discord scheduled events: interested-member tracking, reminder DMs, start announcements and
 * recurring templates.
 *
 *   gateway events (events/guildScheduledEvent*.js) ─┐
 *                                                    ├─> scheduled_events_config  (mirror, one row per event)
 *   recurring job (createNextOccurrence) ────────────┘    event_subscriptions      (who is Interested)
 *
 *   jobs/event-reminder-scheduler.js ── every minute ──> runTick():
 *       1. start announcements that are due (claimed via start_announced_at)
 *       2. reminder DMs that are due (claimed per member via event_subscriptions.reminder_sent)
 *       3. recurring templates whose last occurrence has ended -> create the next Discord event
 *
 * Everything due is found from persisted timestamps, so a restart loses nothing but the minute it
 * was down. Everything that sends a message is OFF until a server admin enables it
 * (guild_feature_config, feature key 'event-reminders'); the recurring templates exist only when an
 * admin creates one with /schedule discord recurring-add.
 *
 * DMs are deliberately slow: at most DM_BUDGET_PER_TICK per minute across every guild, one at a
 * time with a gap, and no more than six reminder DMs per member per hour. Members can opt out per
 * server with the button on the DM or /schedule discord reminders.
 */
import {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    GuildScheduledEventPrivacyLevel, PermissionFlagsBits,
} from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';
import { logFeatureEvent } from './feature-log.js';
import {
    FEATURE_KEY, MAX_LEAD_MINUTES, normaliseEventConfig, reminderDue, occurrenceEnded, shouldRearm,
    allowUserDm, eventUrl, entityTypeToColumn, columnToEntityType, statusName,
} from './event-reminder-helpers.js';
import { parseRule, nextOccurrenceAfter } from './recurrence-rule.js';

const DM_BUDGET_PER_TICK = 40;
const DM_SPACING_MS = 1100;
const SUBSCRIBER_PAGE_SIZE = 100;
const SUBSCRIBER_PAGES = 10;          // reconcile at most 1,000 interested members per event
const MAX_TEMPLATE_FAILURES = 10;     // then the template pauses itself (active = 0)
const UNKNOWN_SCHEDULED_EVENT = 10070;
const PERMANENT_SEND_ERRORS = new Set([10003, 50001, 50013]); // unknown channel, missing access/permissions

/** Events whose interested list was reconciled with Discord during this process lifetime. */
const syncedEvents = new Set();
/** userId -> recent reminder DM timestamps (per-member cap). */
const userDmLog = new Map();
/** Templates currently creating an occurrence (single process, so an in-memory lock suffices). */
const creatingTemplates = new Set();
/** templateId -> earliest next attempt after a failure (exponential backoff). */
const templateBackoff = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clientForGuild(guildId, fallback = null) {
    const client = globalThis.botManager?.getClientForGuild?.(guildId) || fallback;
    return client?.guilds?.cache?.has(guildId) ? client : null;
}

function toMs(value) {
    if (value == null) return NaN;
    const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(t) ? t : NaN;
}

function truncate(text, max) {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function parseConfigJson(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return {}; }
}

/** A guild's normalised settings (defaults OFF when it has none). */
export async function getEventConfig(guildId) {
    try {
        const [rows] = await pool.execute(
            'SELECT config FROM guild_feature_config WHERE guild_id = ? AND feature_key = ?',
            [guildId, FEATURE_KEY]
        );
        return normaliseEventConfig(parseConfigJson(rows[0]?.config));
    } catch (err) {
        logger.error(`[EventReminders] Failed to read settings for ${guildId}: ${err.message}`);
        return normaliseEventConfig({});
    }
}

/** Every guild that has turned on DMs and/or announcements, with its normalised settings. */
async function loadEnabledConfigs() {
    const [rows] = await pool.execute(
        'SELECT guild_id, config FROM guild_feature_config WHERE feature_key = ?',
        [FEATURE_KEY]
    );
    const map = new Map();
    for (const row of rows) {
        const cfg = normaliseEventConfig(parseConfigJson(row.config));
        if (cfg.dmEnabled || cfg.announceEnabled) map.set(row.guild_id, cfg);
    }
    return map;
}

// ── Mirror ──────────────────────────────────────────────────────────────────────────────────

/**
 * Upsert a Discord scheduled event into scheduled_events_config. Moving the start time re-arms
 * the reminder and the start announcement so the new time is reminded about too.
 */
export async function syncEventMirror(event, { recurringEventId = null } = {}) {
    if (!event?.id) return null;
    if (event.partial) {
        event = await event.fetch().catch(() => null);
        if (!event) return null;
    }
    const guildId = event.guildId || event.guild?.id;
    const startMs = event.scheduledStartTimestamp;
    if (!guildId || !Number.isFinite(startMs)) return null;

    const values = {
        name: truncate(event.name || 'Event', 100),
        description: event.description || null,
        start: new Date(startMs),
        end: Number.isFinite(event.scheduledEndTimestamp) ? new Date(event.scheduledEndTimestamp) : null,
        type: entityTypeToColumn(event.entityType),
        channelId: event.channelId || null,
        location: event.entityMetadata?.location || null,
        status: statusName(event.status),
    };

    const [existingRows] = await pool.execute(
        'SELECT id, scheduled_start FROM scheduled_events_config WHERE event_id = ?',
        [event.id]
    );
    const existing = existingRows[0];

    if (!existing) {
        await pool.execute(
            `INSERT INTO scheduled_events_config
                (guild_id, event_id, event_name, description, scheduled_start, scheduled_end, event_type,
                 channel_id, location, creator_id, status, recurring_event_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                event_name = VALUES(event_name), description = VALUES(description),
                scheduled_start = VALUES(scheduled_start), scheduled_end = VALUES(scheduled_end),
                event_type = VALUES(event_type), channel_id = VALUES(channel_id), location = VALUES(location),
                status = VALUES(status), recurring_event_id = COALESCE(VALUES(recurring_event_id), recurring_event_id)`,
            [guildId, event.id, values.name, values.description, values.start, values.end, values.type,
             values.channelId, values.location, event.creatorId || '0', values.status, recurringEventId]
        );
        return event;
    }

    const rearm = shouldRearm({
        oldStartMs: toMs(existing.scheduled_start),
        newStartMs: startMs,
        nowMs: Date.now(),
    });
    await pool.execute(
        `UPDATE scheduled_events_config
            SET event_name = ?, description = ?, scheduled_start = ?, scheduled_end = ?, event_type = ?,
                channel_id = ?, location = ?, status = ?,
                recurring_event_id = COALESCE(?, recurring_event_id)
                ${rearm ? ', reminder_sent_at = NULL, start_announced_at = NULL' : ''}
          WHERE id = ?`,
        [values.name, values.description, values.start, values.end, values.type,
         values.channelId, values.location, values.status, recurringEventId, existing.id]
    );
    if (rearm) {
        await pool.execute('UPDATE event_subscriptions SET reminder_sent = 0 WHERE event_id = ?', [event.id]);
        syncedEvents.delete(event.id);
        logger.info(`[EventReminders] ${event.id} moved to ${values.start.toISOString()} — reminders re-armed`, { guildId });
    }
    return event;
}

// ── Gateway hooks (called from events/guildScheduledEvent*.js) ──────────────────────────────

export async function handleEventCreate(event) {
    await syncEventMirror(event);
}

export async function handleEventUpdate(oldEvent, newEvent) {
    const synced = await syncEventMirror(newEvent);
    const event = synced || newEvent;
    const status = statusName(event.status);
    const guildId = event.guildId || event.guild?.id;

    if (status === 'active' && statusName(oldEvent?.status) !== 'active') {
        await announceStart(guildId, event.id, { client: event.client });
    }
    if (status === 'completed' || status === 'canceled') {
        await followUpRecurring(event.id, event.client);
    }
}

export async function handleEventDelete(event) {
    await pool.execute("UPDATE scheduled_events_config SET status = 'deleted' WHERE event_id = ?", [event.id]);
    await pool.execute('DELETE FROM event_subscriptions WHERE event_id = ?', [event.id]);
    syncedEvents.delete(event.id);
    await followUpRecurring(event.id, event.client);
}

export async function handleUserAdd(event, user) {
    if (!event?.id || !user?.id || user.bot) return;
    const guildId = event.guildId || event.guild?.id || null;
    await pool.execute(
        `INSERT INTO event_subscriptions (event_id, user_id, guild_id, reminder_sent)
         VALUES (?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE guild_id = VALUES(guild_id)`,
        [event.id, user.id, guildId]
    );
    // An event created while the bot was offline has no mirror row yet; without one the reminder
    // job would never see it.
    const [mirror] = await pool.execute('SELECT 1 FROM scheduled_events_config WHERE event_id = ?', [event.id]);
    if (!mirror.length) await syncEventMirror(event);
}

export async function handleUserRemove(event, user) {
    if (!event?.id || !user?.id) return;
    await pool.execute('DELETE FROM event_subscriptions WHERE event_id = ? AND user_id = ?', [event.id, user.id]);
}

// ── Reminder DMs ────────────────────────────────────────────────────────────────────────────

/**
 * Bring event_subscriptions in line with Discord's own interested list. Covers everyone who
 * clicked Interested while the bot was offline (or before this feature existed), and drops
 * members who un-clicked in the meantime. Returns 'gone' if the event no longer exists.
 */
async function reconcileSubscribers(guild, eventId) {
    const ids = new Set();
    let complete = false;
    let after = null;
    try {
        for (let page = 0; page < SUBSCRIBER_PAGES; page++) {
            const batch = await guild.scheduledEvents.fetchSubscribers(eventId, {
                limit: SUBSCRIBER_PAGE_SIZE,
                ...(after ? { after } : {}),
            });
            for (const [userId, sub] of batch) {
                if (!sub?.user?.bot) ids.add(userId);
            }
            if (batch.size < SUBSCRIBER_PAGE_SIZE) {
                complete = true;
                break;
            }
            after = [...batch.keys()].reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a));
        }
    } catch (err) {
        if (err.code === UNKNOWN_SCHEDULED_EVENT) return 'gone';
        logger.warn(`[EventReminders] Could not fetch interested members for ${eventId}: ${err.message}`, { guildId: guild.id });
        return false;
    }

    const list = [...ids];
    for (let i = 0; i < list.length; i += 200) {
        const chunk = list.slice(i, i + 200);
        await pool.query(
            `INSERT INTO event_subscriptions (event_id, user_id, guild_id, reminder_sent) VALUES ?
             ON DUPLICATE KEY UPDATE guild_id = VALUES(guild_id)`,
            [chunk.map((userId) => [eventId, userId, guild.id, 0])]
        );
    }
    if (complete) {
        if (list.length) {
            await pool.query(
                'DELETE FROM event_subscriptions WHERE event_id = ? AND reminder_sent = 0 AND user_id NOT IN (?)',
                [eventId, list]
            );
        } else {
            await pool.execute('DELETE FROM event_subscriptions WHERE event_id = ? AND reminder_sent = 0', [eventId]);
        }
    }
    syncedEvents.add(eventId);
    return true;
}

function reminderPayload(guild, ev, startMs) {
    const s = Math.floor(startMs / 1000);
    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, 'primary'))
        .setTitle(truncate(`⏰ ${ev.event_name}`, 256))
        .setDescription(`Starts <t:${s}:R> (<t:${s}:f>) in **${truncate(guild.name, 100)}**.`)
        .setFooter({ text: 'You are getting this because you marked this event as Interested.' });

    const where = ev.channel_id ? `<#${ev.channel_id}>` : (ev.location ? truncate(ev.location, 1024) : null);
    if (where) embed.addFields({ name: 'Where', value: where, inline: true });
    if (ev.description) embed.addFields({ name: 'About', value: truncate(ev.description, 1024), inline: false });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('View event').setURL(eventUrl(guild.id, ev.event_id)),
        new ButtonBuilder()
            .setStyle(ButtonStyle.Secondary)
            .setCustomId(`evrem_optout:${guild.id}`)
            .setLabel('Stop reminders from this server'),
    );
    return { embeds: [embed], components: [row] };
}

async function deliverReminder(guild, ev, startMs, userId) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || member.user.bot) return false;
    try {
        await member.send(reminderPayload(guild, ev, startMs));
        return true;
    } catch (err) {
        // 50007 = DMs closed. Expected for a share of members; not worth more than a debug line.
        if (err.code !== 50007) {
            logger.warn(`[EventReminders] DM to ${userId} failed: ${err.message}`, { guildId: guild.id, eventId: ev.event_id });
        }
        return false;
    }
}

/** Send up to `budget` reminders for one event. Returns how many members were processed. */
async function sendPendingReminders(guild, ev, startMs, budget) {
    const limit = Math.max(0, Math.floor(budget));
    const [pending] = await pool.execute(
        `SELECT es.id, es.user_id
           FROM event_subscriptions es
           LEFT JOIN event_reminder_optouts o ON o.guild_id = ? AND o.user_id = es.user_id
          WHERE es.event_id = ? AND es.reminder_sent = 0 AND o.user_id IS NULL
          ORDER BY es.id
          LIMIT ${limit}`,
        [ev.guild_id, ev.event_id]
    );

    let processed = 0;
    let delivered = 0;
    for (const sub of pending) {
        if (Date.now() >= startMs) break;
        // Claim before sending: a crash mid-send loses one reminder rather than repeating it.
        const [claim] = await pool.execute(
            'UPDATE event_subscriptions SET reminder_sent = 1 WHERE id = ? AND reminder_sent = 0',
            [sub.id]
        );
        if (!claim.affectedRows) continue;
        processed++;
        if (!allowUserDm(userDmLog, sub.user_id, Date.now())) continue;
        if (await deliverReminder(guild, ev, startMs, sub.user_id)) delivered++;
        await sleep(DM_SPACING_MS);
    }

    const [[left]] = await pool.execute(
        `SELECT COUNT(*) AS n
           FROM event_subscriptions es
           LEFT JOIN event_reminder_optouts o ON o.guild_id = ? AND o.user_id = es.user_id
          WHERE es.event_id = ? AND es.reminder_sent = 0 AND o.user_id IS NULL`,
        [ev.guild_id, ev.event_id]
    );
    if (Number(left.n) === 0 || Date.now() >= startMs) {
        await pool.execute(
            'UPDATE scheduled_events_config SET reminder_sent_at = NOW() WHERE id = ? AND reminder_sent_at IS NULL',
            [ev.id]
        );
        logger.info(`[EventReminders] Reminders finished for "${ev.event_name}" (${ev.event_id})`, {
            guildId: ev.guild_id, delivered, unsent: Number(left.n),
        });
    }
    return processed;
}

async function processReminders(configs, fallbackClient) {
    const guildIds = [...configs].filter(([, c]) => c.dmEnabled).map(([g]) => g);
    if (!guildIds.length) return;

    const [events] = await pool.query(
        `SELECT id, guild_id, event_id, event_name, description, scheduled_start, event_type, channel_id, location
           FROM scheduled_events_config
          WHERE guild_id IN (?) AND status = 'scheduled' AND reminder_sent_at IS NULL
            AND scheduled_start > NOW()
            AND scheduled_start <= DATE_ADD(NOW(), INTERVAL ${MAX_LEAD_MINUTES} MINUTE)
          ORDER BY scheduled_start
          LIMIT 100`,
        [guildIds]
    );

    let budget = DM_BUDGET_PER_TICK;
    for (const ev of events) {
        if (budget <= 0) break;
        const cfg = configs.get(ev.guild_id);
        const startMs = toMs(ev.scheduled_start);
        if (!cfg || !reminderDue({ startMs, nowMs: Date.now(), leadMinutes: cfg.leadMinutes })) continue;

        const client = clientForGuild(ev.guild_id, fallbackClient);
        if (!client) continue;
        const guild = client.guilds.cache.get(ev.guild_id);

        try {
            if (!syncedEvents.has(ev.event_id)) {
                const outcome = await reconcileSubscribers(guild, ev.event_id);
                if (outcome === 'gone') {
                    await pool.execute("UPDATE scheduled_events_config SET status = 'deleted' WHERE id = ?", [ev.id]);
                    continue;
                }
            }
            budget -= await sendPendingReminders(guild, ev, startMs, budget);
        } catch (err) {
            logger.error(`[EventReminders] Reminder pass failed for ${ev.event_id}: ${err.message}`, { guildId: ev.guild_id });
        }
    }
}

// ── Start announcements ─────────────────────────────────────────────────────────────────────

/**
 * Post "starting now" in the configured channel, once per event. Called when Discord flips the
 * event to Active and by the job when the scheduled start passes — whichever comes first wins
 * the start_announced_at claim.
 */
export async function announceStart(guildId, eventId, { client: fallback = null, cfg = null } = {}) {
    if (!guildId || !eventId) return false;
    const config = cfg || await getEventConfig(guildId);
    if (!config.announceEnabled) return false;

    const [rows] = await pool.execute(
        'SELECT id, event_id, event_name, description, scheduled_start, channel_id, location, start_announced_at FROM scheduled_events_config WHERE event_id = ?',
        [eventId]
    );
    const ev = rows[0];
    if (!ev || ev.start_announced_at) return false;

    const client = clientForGuild(guildId, fallback);
    if (!client) return false;
    const guild = client.guilds.cache.get(guildId);
    const channel = await guild.channels.fetch(config.announceChannelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
        logger.warn(`[EventReminders] Announcement channel ${config.announceChannelId} missing or not text`, { guildId });
        return false;
    }
    const me = guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (perms && !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        logger.warn(`[EventReminders] Missing permissions to announce in ${channel.id}`, { guildId });
        return false;
    }

    const [claim] = await pool.execute(
        'UPDATE scheduled_events_config SET start_announced_at = NOW() WHERE id = ? AND start_announced_at IS NULL',
        [ev.id]
    );
    if (!claim.affectedRows) return false;

    const startMs = toMs(ev.scheduled_start);
    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'success'))
        .setTitle(truncate(`📅 ${ev.event_name} is starting now!`, 256))
        .setTimestamp(Number.isFinite(startMs) ? new Date(startMs) : new Date());
    if (ev.description) embed.setDescription(truncate(ev.description, 2000));
    const where = ev.channel_id ? `<#${ev.channel_id}>` : (ev.location ? truncate(ev.location, 1024) : null);
    if (where) embed.addFields({ name: 'Where', value: where, inline: true });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open event').setURL(eventUrl(guildId, eventId)),
    );

    try {
        await channel.send({
            content: config.announceRoleId ? `<@&${config.announceRoleId}>` : undefined,
            embeds: [embed],
            components: [row],
            allowedMentions: { roles: config.announceRoleId ? [config.announceRoleId] : [] },
        });
        logger.info(`[EventReminders] Announced start of "${ev.event_name}"`, { guildId, eventId });
        return true;
    } catch (err) {
        logger.error(`[EventReminders] Start announcement failed: ${err.message}`, { guildId, eventId, code: err.code });
        if (!PERMANENT_SEND_ERRORS.has(err.code)) {
            await pool.execute('UPDATE scheduled_events_config SET start_announced_at = NULL WHERE id = ?', [ev.id]);
        }
        return false;
    }
}

async function processStartAnnouncements(configs, fallbackClient) {
    const guildIds = [...configs].filter(([, c]) => c.announceEnabled).map(([g]) => g);
    if (!guildIds.length) return;
    const [rows] = await pool.query(
        `SELECT guild_id, event_id
           FROM scheduled_events_config
          WHERE guild_id IN (?) AND start_announced_at IS NULL AND status IN ('scheduled', 'active')
            AND scheduled_start <= NOW() AND scheduled_start >= DATE_SUB(NOW(), INTERVAL 15 MINUTE)`,
        [guildIds]
    );
    for (const row of rows) {
        try {
            await announceStart(row.guild_id, row.event_id, { client: fallbackClient, cfg: configs.get(row.guild_id) });
        } catch (err) {
            logger.error(`[EventReminders] Start announcement pass failed for ${row.event_id}: ${err.message}`, { guildId: row.guild_id });
        }
    }
}

// ── Recurring templates ─────────────────────────────────────────────────────────────────────

async function recordTemplateFailure(templateId, message) {
    const msg = truncate(message || 'unknown error', 255);
    const [[row]] = await pool.execute('SELECT failure_count, guild_id, template_name, active FROM recurring_events WHERE id = ?', [templateId]);
    const failures = Number(row?.failure_count || 0) + 1;
    templateBackoff.set(templateId, Date.now() + Math.min(2 ** failures, 720) * 60_000);
    await pool.execute(
        `UPDATE recurring_events
            SET active = IF(failure_count + 1 >= ?, 0, active), failure_count = failure_count + 1, last_error = ?
          WHERE id = ?`,
        [MAX_TEMPLATE_FAILURES, msg, templateId]
    );
    logger.warn(`[EventReminders] Recurring template #${templateId} failed (${failures}/${MAX_TEMPLATE_FAILURES}): ${msg}`);
    if (row?.active && failures >= MAX_TEMPLATE_FAILURES) {
        // This failure is the one that paused the template.
        void logFeatureEvent(() => (clientForGuild(row.guild_id)?.guilds.cache.get(row.guild_id)), 'system.featureDisabled', () => ({
            title: '⛔ Feature Auto-Disabled',
            description: `The repeating event **${truncate(row.template_name || `#${templateId}`, 100)}** was paused after ${failures} failed attempts in a row to create its next event. `
                + `Fix the problem, then resume it with \`/schedule discord recurring-pause id:${templateId} paused:False\`.`,
            fields: [
                ['Feature', 'Repeating event'],
                ['Why', `Failed ${failures} times in a row — last error: ${msg}`, false],
                ['Template', `#${templateId}`],
            ],
        }));
    }
}

/**
 * Create the next Discord event for a template. `expectedLastEventId` guards against a stale
 * caller: the row is re-read under the lock and nothing happens if someone already advanced it.
 */
export async function createNextOccurrence(templateId, { client: fallback = null, expectedLastEventId } = {}) {
    if (creatingTemplates.has(templateId)) return { ok: false, error: 'Already creating the next event.' };
    creatingTemplates.add(templateId);
    try {
        const [[t]] = await pool.execute('SELECT * FROM recurring_events WHERE id = ?', [templateId]);
        if (!t || !t.active) return { ok: false, error: 'Template not found or paused.' };
        if (expectedLastEventId !== undefined && (t.last_created_event_id || null) !== (expectedLastEventId || null)) {
            return { ok: false, error: 'Already advanced.' };
        }

        const rule = parseRule(t.recurrence_rule);
        if (!rule) {
            await recordTemplateFailure(t.id, 'The repeat rule is invalid.');
            return { ok: false, error: 'The repeat rule is invalid.' };
        }

        const client = clientForGuild(t.guild_id, fallback);
        if (!client) return { ok: false, error: 'This server is not reachable right now.' };
        const guild = client.guilds.cache.get(t.guild_id);

        const lastStart = t.last_created_event_id ? toMs(t.next_scheduled) : NaN;
        const after = Math.max(Date.now() + 2 * 60_000, Number.isFinite(lastStart) ? lastStart : 0);
        const { startMs } = nextOccurrenceAfter(rule, after);
        const endMs = startMs + Math.max(15, Number(t.duration_minutes) || 60) * 60_000;

        const options = {
            name: truncate(t.event_name, 100),
            scheduledStartTime: new Date(startMs),
            scheduledEndTime: new Date(endMs),
            privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
            entityType: columnToEntityType(t.event_type),
            reason: `Recurring event #${t.id} (${t.template_name})`,
        };
        if (t.description) options.description = truncate(t.description, 1000);
        if (t.event_type === 'external') options.entityMetadata = { location: truncate(t.location || 'See description', 100) };
        else options.channel = t.channel_id;

        let event;
        try {
            event = await guild.scheduledEvents.create(options);
        } catch (err) {
            await recordTemplateFailure(t.id, err.message);
            return { ok: false, error: err.message };
        }

        templateBackoff.delete(t.id);
        await pool.execute(
            `UPDATE recurring_events
                SET last_created_event_id = ?, last_created_at = NOW(), next_scheduled = ?, failure_count = 0, last_error = NULL
              WHERE id = ?`,
            [event.id, new Date(startMs), t.id]
        );
        await syncEventMirror(event, { recurringEventId: t.id });
        logger.info(`[EventReminders] Recurring template #${t.id} created event ${event.id} for ${new Date(startMs).toISOString()}`, { guildId: t.guild_id });
        return { ok: true, event, startMs };
    } finally {
        creatingTemplates.delete(templateId);
    }
}

/** An occurrence just ended/was cancelled/deleted: if a template owns it, create the next one now. */
async function followUpRecurring(eventId, client) {
    const [rows] = await pool.execute(
        'SELECT id FROM recurring_events WHERE last_created_event_id = ? AND active = 1',
        [eventId]
    );
    for (const row of rows) {
        const out = await createNextOccurrence(row.id, { client, expectedLastEventId: eventId });
        if (!out.ok && out.error !== 'Already advanced.') {
            logger.debug?.(`[EventReminders] Follow-up for template #${row.id} deferred: ${out.error}`);
        }
    }
}

async function processRecurringTemplates(fallbackClient) {
    const [templates] = await pool.execute(
        `SELECT re.id, re.last_created_event_id, re.next_scheduled, re.duration_minutes,
                sec.status AS last_status, sec.scheduled_start AS last_start, sec.scheduled_end AS last_end
           FROM recurring_events re
           LEFT JOIN scheduled_events_config sec ON sec.event_id = re.last_created_event_id
          WHERE re.active = 1`
    );
    const now = Date.now();
    for (const t of templates) {
        if ((templateBackoff.get(t.id) || 0) > now) continue;
        try {
            let due = !t.last_created_event_id;
            if (!due) {
                due = occurrenceEnded({
                    status: t.last_status || 'scheduled',
                    startMs: Number.isFinite(toMs(t.last_start)) ? toMs(t.last_start) : toMs(t.next_scheduled),
                    endMs: toMs(t.last_end),
                    durationMinutes: t.duration_minutes,
                    nowMs: now,
                });
            }
            if (due) await createNextOccurrence(t.id, { client: fallbackClient, expectedLastEventId: t.last_created_event_id || null });
        } catch (err) {
            logger.error(`[EventReminders] Recurring template #${t.id} pass failed: ${err.message}`);
        }
    }
}

// ── Template management (used by /schedule discord) ─────────────────────────────────────────

export async function createTemplate({ guildId, name, description, rule, firstStartMs, durationMinutes, eventType, channelId, location, creatorId }) {
    const [result] = await pool.execute(
        `INSERT INTO recurring_events
            (guild_id, template_name, event_name, description, event_type, channel_id, location,
             duration_minutes, recurrence_rule, next_scheduled, active, creator_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [guildId, truncate(name, 100), truncate(name, 100), description || null, eventType, channelId || null,
         location || null, durationMinutes, JSON.stringify(rule), new Date(firstStartMs), creatorId]
    );
    return result.insertId;
}

export async function listTemplates(guildId) {
    const [rows] = await pool.execute(
        `SELECT id, template_name, event_name, event_type, channel_id, location, duration_minutes, recurrence_rule,
                last_created_event_id, next_scheduled, active, failure_count, last_error
           FROM recurring_events WHERE guild_id = ? ORDER BY id`,
        [guildId]
    );
    return rows;
}

export async function setTemplateActive(guildId, id, active) {
    const [result] = await pool.execute(
        'UPDATE recurring_events SET active = ?, failure_count = 0, last_error = NULL WHERE id = ? AND guild_id = ?',
        [active ? 1 : 0, id, guildId]
    );
    if (active) templateBackoff.delete(id);
    return result.affectedRows > 0;
}

/** Delete a template; optionally cancel the upcoming Discord event it already created. */
export async function removeTemplate(guild, id, { cancelUpcoming = false } = {}) {
    const [[t]] = await pool.execute('SELECT * FROM recurring_events WHERE id = ? AND guild_id = ?', [id, guild.id]);
    if (!t) return { removed: false };
    // Row first: deleting the Discord event fires GuildScheduledEventDelete, and a template that
    // still existed at that moment would immediately create its next occurrence.
    await pool.execute('DELETE FROM recurring_events WHERE id = ? AND guild_id = ?', [id, guild.id]);
    templateBackoff.delete(id);

    let cancelled = false;
    if (cancelUpcoming && t.last_created_event_id && toMs(t.next_scheduled) > Date.now()) {
        try {
            await guild.scheduledEvents.delete(t.last_created_event_id);
            cancelled = true;
        } catch (err) {
            if (err.code !== UNKNOWN_SCHEDULED_EVENT) {
                logger.warn(`[EventReminders] Could not delete upcoming event ${t.last_created_event_id}: ${err.message}`, { guildId: guild.id });
            }
        }
    }
    return { removed: true, cancelled, template: t };
}

/** Per-server reminder opt-out. Returns the new state (true = opted out). */
export async function setOptOut(guildId, userId, optedOut) {
    if (optedOut) {
        await pool.execute('INSERT IGNORE INTO event_reminder_optouts (guild_id, user_id) VALUES (?, ?)', [guildId, userId]);
    } else {
        await pool.execute('DELETE FROM event_reminder_optouts WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    }
    return optedOut;
}

export async function isOptedOut(guildId, userId) {
    const [rows] = await pool.execute(
        'SELECT 1 FROM event_reminder_optouts WHERE guild_id = ? AND user_id = ?',
        [guildId, userId]
    );
    return rows.length > 0;
}

// ── Mirror refresh ──────────────────────────────────────────────────────────────────────────

const MIRROR_REFRESH_MS = 10 * 60_000;
const lastMirrorRefresh = new Map(); // guildId -> ms

/**
 * For guilds that use reminders/announcements, re-read their scheduled events from Discord every
 * ten minutes. Gateway events cover changes made while the bot is connected; this covers events
 * created, moved or deleted while it was not (restarts, outages), so nothing due is missed.
 */
async function refreshMirrors(configs, fallbackClient) {
    for (const guildId of configs.keys()) {
        if (Date.now() - (lastMirrorRefresh.get(guildId) || 0) < MIRROR_REFRESH_MS) continue;
        const client = clientForGuild(guildId, fallbackClient);
        if (!client) continue;
        const guild = client.guilds.cache.get(guildId);
        lastMirrorRefresh.set(guildId, Date.now());

        let events;
        try {
            events = await guild.scheduledEvents.fetch();
        } catch (err) {
            logger.warn(`[EventReminders] Could not fetch scheduled events: ${err.message}`, { guildId });
            continue;
        }
        for (const event of events.values()) {
            await syncEventMirror(event).catch((err) => {
                logger.warn(`[EventReminders] Mirror sync failed for ${event.id}: ${err.message}`, { guildId });
            });
        }
        // Upcoming events Discord no longer lists were deleted while nobody was listening.
        const ids = [...events.keys()];
        await pool.query(
            `UPDATE scheduled_events_config SET status = 'deleted'
              WHERE guild_id = ? AND status IN ('scheduled', 'active') AND scheduled_start > NOW()
              ${ids.length ? 'AND event_id NOT IN (?)' : ''}`,
            ids.length ? [guildId, ids] : [guildId]
        );
    }
}

// ── Tick ────────────────────────────────────────────────────────────────────────────────────

export async function runTick(fallbackClient = null) {
    let configs = new Map();
    try {
        configs = await loadEnabledConfigs();
    } catch (err) {
        logger.error(`[EventReminders] Could not load settings: ${err.message}`);
    }
    if (configs.size) {
        try { await refreshMirrors(configs, fallbackClient); }
        catch (err) { logger.error(`[EventReminders] Mirror refresh failed: ${err.message}`); }
        try { await processStartAnnouncements(configs, fallbackClient); }
        catch (err) { logger.error(`[EventReminders] Start announcements failed: ${err.message}`); }
        try { await processReminders(configs, fallbackClient); }
        catch (err) { logger.error(`[EventReminders] Reminders failed: ${err.message}`); }
    }
    try { await processRecurringTemplates(fallbackClient); }
    catch (err) { logger.error(`[EventReminders] Recurring templates failed: ${err.message}`); }
}

export default {
    getEventConfig, syncEventMirror, handleEventCreate, handleEventUpdate, handleEventDelete,
    handleUserAdd, handleUserRemove, announceStart, createNextOccurrence, createTemplate,
    listTemplates, setTemplateActive, removeTemplate, setOptOut, isOptedOut, runTick,
};
