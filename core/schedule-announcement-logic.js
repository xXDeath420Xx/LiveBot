/*
 * Which /schedule announcements are due — pure logic for core/schedule-manager.js, kept free of
 * discord.js and the database so it can be tested on its own (tests/schedule-announcements.test.js).
 *
 * A linked channel with update_type 'announcements' (or 'full') gets three kinds of post per run:
 *   starting_soon  a pending run whose projected start is within announce_before_minutes
 *   now_playing    a run that went 'running' recently
 *   completed      a run that finished recently
 * "Recently" is RECENT_WINDOW_MS: a channel linked to a marathon that is half over must not dump
 * every earlier run into the channel, and neither must the first tick after a restart. Each
 * (link, run, type) is posted once — dedupe happens in schedule_announcements, not here.
 */

export const RECENT_WINDOW_MS = 30 * 60_000;
export const ANNOUNCEMENT_TYPES = Object.freeze(['starting_soon', 'now_playing', 'completed']);

function ms(value) {
    if (value == null || value === '') return null;
    const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(t) ? t : null;
}

/** Gap after a run before the next one starts: the run's own setup, else the schedule default. */
function setupAfterMs(item, schedule) {
    const own = Number(item.setup_seconds) || 0;
    const fallback = Number(schedule?.setup_time_seconds) || 0;
    return (own > 0 ? own : fallback) * 1000;
}

/**
 * Projected start time (ms) for every run of one schedule, keyed by item id; null where it cannot
 * be known (no schedule start time and nothing has run yet).
 *
 * Walks the runs in position order with a cursor = "the earliest the next run can begin":
 *   completed -> cursor = its actual end + setup
 *   running   -> cursor = max(actual start + estimate, now) + setup   (an overrunning run pushes
 *                everything after it back to at least "now")
 *   skipped   -> no effect
 *   pending   -> start = max(cursor, its own scheduled_start) — a marathon running behind starts
 *                runs late, never early; the first pending run falls back to the schedule's start.
 */
export function projectStarts(schedule, items, nowMs) {
    const out = new Map();
    const ordered = [...items].sort((a, b) => (Number(a.position) - Number(b.position)) || (Number(a.id) - Number(b.id)));
    let cursor = ms(schedule?.start_time);

    for (const item of ordered) {
        const estimateMs = (Number(item.estimate_seconds) || 0) * 1000;
        const own = ms(item.scheduled_start);

        if (item.status === 'completed') {
            const end = ms(item.actual_end);
            const start = ms(item.actual_start);
            out.set(item.id, start ?? own ?? cursor);
            if (end != null) cursor = end + setupAfterMs(item, schedule);
            else if (start != null) cursor = start + estimateMs + setupAfterMs(item, schedule);
            continue;
        }
        if (item.status === 'skipped') {
            out.set(item.id, null);
            continue;
        }
        if (item.status === 'running') {
            const start = ms(item.actual_start) ?? own ?? cursor ?? nowMs;
            out.set(item.id, start);
            cursor = Math.max(start + estimateMs, nowMs) + setupAfterMs(item, schedule);
            continue;
        }

        // pending
        let start = null;
        if (cursor != null && own != null) start = Math.max(cursor, own);
        else start = cursor ?? own;
        out.set(item.id, start);
        if (start != null) cursor = start + estimateMs + setupAfterMs(item, schedule);
    }
    return out;
}

/**
 * Announcements due for one linked channel right now.
 * @param {object} args
 * @param {Array} args.schedules  schedule_schedules rows covered by the link
 * @param {Array} args.items      schedule_items rows of those schedules
 * @param {number} args.announceBeforeMinutes
 * @param {number} args.nowMs
 * @returns {Array<{ item, type, startMs }>}
 */
export function dueAnnouncements({ schedules, items, announceBeforeMinutes, nowMs, recentWindowMs = RECENT_WINDOW_MS }) {
    const due = [];
    const leadMs = Math.max(0, Number(announceBeforeMinutes) || 0) * 60_000;

    for (const schedule of schedules) {
        const own = items.filter((i) => String(i.schedule_id) === String(schedule.id));
        const starts = projectStarts(schedule, own, nowMs);

        for (const item of own) {
            const startMs = starts.get(item.id);
            if (item.status === 'pending') {
                if (leadMs > 0 && startMs != null && startMs > nowMs && startMs - nowMs <= leadMs) {
                    due.push({ item, type: 'starting_soon', startMs });
                }
            } else if (item.status === 'running') {
                const actual = ms(item.actual_start);
                if (actual != null && nowMs - actual <= recentWindowMs && actual <= nowMs + 60_000) {
                    due.push({ item, type: 'now_playing', startMs: actual });
                }
            } else if (item.status === 'completed') {
                const end = ms(item.actual_end);
                if (end != null && nowMs - end <= recentWindowMs && end <= nowMs + 60_000) {
                    due.push({ item, type: 'completed', startMs: ms(item.actual_start) });
                }
            }
        }
    }
    // Oldest event first, so a run's "completed" lands before the next run's "now playing".
    const order = { completed: 0, now_playing: 1, starting_soon: 2 };
    return due.sort((a, b) => order[a.type] - order[b.type] || (a.startMs ?? 0) - (b.startMs ?? 0));
}

/** Seconds -> "1:05:00" / "45:00". */
export function formatDuration(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
        : `${m}:${String(sec).padStart(2, '0')}`;
}

export default { RECENT_WINDOW_MS, ANNOUNCEMENT_TYPES, projectStarts, dueAnnouncements, formatDuration };
