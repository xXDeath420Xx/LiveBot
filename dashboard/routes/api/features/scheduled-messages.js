/**
 * Scheduled messages: recurring channel posts (Dashboard → Scheduled messages).
 *
 * Mounted at /api/guilds/:guildId/scheduled-messages (behind apiCheckAuth + apiCheckGuildAdmin).
 *
 *   GET    /             every post of this server, plus the text channels and roles to pick from
 *                        and the server's timezone
 *   POST   /             create a post
 *   PUT    /:id          edit a post (the full editor body), or { enabled } alone to pause/resume
 *   DELETE /:id          delete a post
 *   POST   /:id/send     post it now as a test (its schedule and post count are not touched)
 *
 * Rows live in scheduled_announcements; validation, scheduling and sending are in
 * core/scheduled-announcements-manager.js, and jobs/announcement-scheduler.js posts what is due
 * every minute. /alerts scheduled manages the same rows from Discord.
 */
import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { getGuildTimezone, getZoneAbbreviation, getLocalDateParts } from '../../../../utils/guild-timezone.js';
import ScheduledAnnouncementsManager, {
    validatePostInput, describeSchedule, scheduleFields, embedFields, MAX_PER_GUILD, MIN_INTERVAL_MINUTES,
} from '../../../../core/scheduled-announcements-manager.js';
import { getAnnouncementsManager } from '../../../../jobs/announcement-scheduler.js';

const router = express.Router({ mergeParams: true });

/** The guild as the bot serving it sees it (custom bot when one is mapped). */
function guildFor(req) {
    const { guildId } = req.params;
    return global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId)
        || req.guildObject
        || null;
}

function parseId(raw) {
    const id = Number.parseInt(raw, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
}

async function loadRow(guildId, id) {
    const [[row]] = await pool.execute('SELECT * FROM scheduled_announcements WHERE id = ? AND guild_id = ?', [id, guildId]);
    return row || null;
}

/** "YYYY-MM-DD" of an instant in the server's timezone. */
function localDate(value, tz) {
    const p = getLocalDateParts(new Date(value), tz);
    return `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** A row as the page uses it. */
function view(row, tz) {
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    return {
        id: row.id,
        name: row.name || null,
        channel_id: row.channel_id,
        message_content: row.message_content || '',
        embed: embedFields(row.embed_data),
        ping_role_id: row.ping_role_id || '',
        schedule_type: row.schedule_type,
        schedule_value: row.schedule_value,
        schedule: scheduleFields(row, tz),
        summary: describeSchedule(row.schedule_type, row.schedule_value),
        next_run: row.enabled ? iso(row.next_run) : null,
        last_run: iso(row.last_run),
        run_count: Number(row.run_count) || 0,
        max_runs: row.max_runs == null ? null : Number(row.max_runs),
        end_at: iso(row.end_at),
        end_date: row.end_at ? localDate(row.end_at, tz) : '',
        enabled: !!row.enabled,
        last_error: row.last_error || null,
        created_by: row.created_by,
    };
}

router.get('/', async (req, res) => {
    const { guildId } = req.params;
    try {
        const tz = await getGuildTimezone(guildId);
        const [rows] = await pool.execute(
            'SELECT * FROM scheduled_announcements WHERE guild_id = ? ORDER BY enabled DESC, next_run ASC, id ASC',
            [guildId]);
        const guild = guildFor(req);
        const channels = guild
            ? [...guild.channels.cache.values()].filter((c) => c.type === 0 || c.type === 5)
                .sort((a, b) => a.rawPosition - b.rawPosition).map((c) => ({ id: c.id, name: c.name }))
            : [];
        const roles = guild
            ? [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed)
                .sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name }))
            : [];
        res.json({
            posts: rows.map((r) => view(r, tz)),
            channels,
            roles,
            timezone: tz,
            timezoneLabel: getZoneAbbreviation(tz),
            limits: { maxPosts: MAX_PER_GUILD, minIntervalMinutes: MIN_INTERVAL_MINUTES },
        });
    } catch (error) {
        logger.error('[ScheduledMessages] list failed', { guildId, error: error.message });
        res.status(500).json({ error: 'Could not load scheduled messages.' });
    }
});

router.post('/', async (req, res) => {
    const { guildId } = req.params;
    try {
        const [[{ n }]] = await pool.execute('SELECT COUNT(*) AS n FROM scheduled_announcements WHERE guild_id = ?', [guildId]);
        if (n >= MAX_PER_GUILD) return res.status(400).json({ error: `A server can have at most ${MAX_PER_GUILD} scheduled messages.` });
        const tz = await getGuildTimezone(guildId);
        const result = validatePostInput(req.body || {}, guildFor(req), tz);
        if (!result.ok) return res.status(400).json({ error: result.error });
        const r = result.row;
        const [ins] = await pool.execute(
            `INSERT INTO scheduled_announcements
                (guild_id, channel_id, name, message_content, embed_data, ping_role_id, schedule_type, schedule_value,
                 next_run, end_at, max_runs, enabled, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [guildId, r.channel_id, r.name, r.message_content, r.embed_data, r.ping_role_id, r.schedule_type, r.schedule_value,
                result.nextRun, r.end_at, r.max_runs, r.enabled, String(req.user.id)]);
        const row = await loadRow(guildId, ins.insertId);
        logger.info('[ScheduledMessages] created', { guildId, id: ins.insertId, by: req.user.id, schedule: r.schedule_type });
        res.status(201).json({ success: true, message: 'Scheduled message created', post: view(row, tz) });
    } catch (error) {
        logger.error('[ScheduledMessages] create failed', { guildId, error: error.message });
        res.status(500).json({ error: 'Could not save the scheduled message.' });
    }
});

router.put('/:id', async (req, res) => {
    const { guildId } = req.params;
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid message id.' });
    try {
        const row = await loadRow(guildId, id);
        if (!row) return res.status(404).json({ error: 'That scheduled message no longer exists.' });
        const tz = await getGuildTimezone(guildId);
        const body = req.body || {};

        // Pause / resume only.
        if (Object.keys(body).length === 1 && 'enabled' in body) {
            const on = body.enabled === true || body.enabled === 1 || body.enabled === '1' || body.enabled === 'true';
            const manager = getAnnouncementsManager(guildId) || new ScheduledAnnouncementsManager(null);
            if (on && row.end_at && new Date(row.end_at) <= new Date()) return res.status(400).json({ error: 'Its end date has passed. Edit it to set a new one.' });
            if (on && row.max_runs != null && Number(row.run_count) >= Number(row.max_runs)) return res.status(400).json({ error: 'It has already posted as many times as it was set to. Edit it to raise the limit.' });
            if (on && row.schedule_type === 'once' && row.last_run) return res.status(400).json({ error: 'A one-off message that has been posted cannot be turned back on. Edit it to pick a new time.' });
            await manager.toggleAnnouncement(id, on);
            return res.json({ success: true, message: on ? 'Resumed' : 'Paused', post: view(await loadRow(guildId, id), tz) });
        }

        const result = validatePostInput(body, guildFor(req), tz);
        if (!result.ok) return res.status(400).json({ error: result.error });
        const r = result.row;
        // An edit starts the count again when the limit would already be reached.
        const resetCount = r.max_runs != null && Number(row.run_count) >= r.max_runs;
        await pool.execute(
            `UPDATE scheduled_announcements
                SET channel_id = ?, name = ?, message_content = ?, embed_data = ?, ping_role_id = ?,
                    schedule_type = ?, schedule_value = ?, next_run = ?, end_at = ?, max_runs = ?, enabled = ?,
                    last_error = NULL${resetCount ? ', run_count = 0' : ''}
              WHERE id = ? AND guild_id = ?`,
            [r.channel_id, r.name, r.message_content, r.embed_data, r.ping_role_id, r.schedule_type, r.schedule_value,
                result.nextRun, r.end_at, r.max_runs, r.enabled, id, guildId]);
        logger.info('[ScheduledMessages] updated', { guildId, id, by: req.user.id });
        res.json({ success: true, message: 'Scheduled message saved', post: view(await loadRow(guildId, id), tz) });
    } catch (error) {
        logger.error('[ScheduledMessages] update failed', { guildId, id, error: error.message });
        res.status(500).json({ error: 'Could not save the scheduled message.' });
    }
});

router.delete('/:id', async (req, res) => {
    const { guildId } = req.params;
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid message id.' });
    try {
        const [del] = await pool.execute('DELETE FROM scheduled_announcements WHERE id = ? AND guild_id = ?', [id, guildId]);
        if (!del.affectedRows) return res.status(404).json({ error: 'That scheduled message no longer exists.' });
        logger.info('[ScheduledMessages] deleted', { guildId, id, by: req.user.id });
        res.json({ success: true, message: 'Scheduled message deleted' });
    } catch (error) {
        logger.error('[ScheduledMessages] delete failed', { guildId, id, error: error.message });
        res.status(500).json({ error: 'Could not delete the scheduled message.' });
    }
});

router.post('/:id/send', async (req, res) => {
    const { guildId } = req.params;
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid message id.' });
    try {
        const row = await loadRow(guildId, id);
        if (!row) return res.status(404).json({ error: 'That scheduled message no longer exists.' });
        const manager = getAnnouncementsManager(guildId) || new ScheduledAnnouncementsManager(null);
        const result = await manager.sendAnnouncement(row, { countRun: false });
        if (!result.ok) return res.status(400).json({ error: result.error });
        logger.info('[ScheduledMessages] sent now', { guildId, id, by: req.user.id });
        res.json({ success: true, message: 'Posted' });
    } catch (error) {
        logger.error('[ScheduledMessages] send-now failed', { guildId, id, error: error.message });
        res.status(500).json({ error: 'Could not post the message.' });
    }
});

export default router;
