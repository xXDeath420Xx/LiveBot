/*
 * The month calendar behind a schedule post.
 *
 * A sync's `schedule_source` says where its streams come from:
 *   twitch  the Twitch schedule, as it always was
 *   mixed   the Twitch schedule, with any day the owner filled in replacing that day
 *   custom  only the days the owner filled in on the dashboard
 *
 * Owner days become ordinary segments, so the hash, embed, alt text and every other layout keep
 * working unchanged. The month poster also needs what a segment cannot say (a day off with a
 * reason, chosen colours), so it reads the days themselves through buildMonth().
 */
import crypto from 'crypto';
import pool from '../utils/db.js';
import { formatTimeInZone, getLocalDateParts } from '../utils/guild-timezone.js';
import { toPlain } from '../utils/channel-name-style.js';

export const SOURCES = ['twitch', 'mixed', 'custom'];
export const DAY_KINDS = ['stream', 'off'];

/* Readable on the peach cells. A show keeps its colour from month to month because it comes from
   the title. */
const SHOW_COLORS = ['#B8692E', '#1F9A3E', '#E8760C', '#25249C', '#A94FD0', '#8A2F5F', '#2F6F8F', '#9C3A1C'];
export const OFF_COLOR = '#C0141C';

export function showColor(title) {
    let h = 0;
    for (const c of String(title || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return SHOW_COLORS[h % SHOW_COLORS.length];
}

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (t) => String(t || '').slice(0, 5);

/** mysql2 returns DATE as a Date at local midnight unless dateStrings is on; normalise either. */
function dayKey(value) {
    if (value instanceof Date) return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    return String(value).slice(0, 10);
}

export function localDayKey(instant, tz) {
    const p = getLocalDateParts(new Date(instant), tz);
    return `${p.year}-${pad(p.month + 1)}-${pad(p.day)}`;
}

/** The UTC instant of a wall-clock date and time in `tz`. */
function zonedInstant(key, time, tz) {
    const [y, m, d] = key.split('-').map(Number);
    const [h, mi] = hhmm(time).split(':').map(Number);
    const wall = Date.UTC(y, m - 1, d, h, mi);
    const offsetAt = (ms) => {
        const p = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric',
        }).formatToParts(new Date(ms)).reduce((a, x) => { a[x.type] = Number(x.value); return a; }, {});
        return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - ms;
    };
    // Twice, so a guess on the far side of a clock change lands on the right offset.
    let at = wall - offsetAt(wall);
    at = wall - offsetAt(at);
    return new Date(at);
}

/** "7pm", "7:30pm", from "19:00:00". */
function clock(time) {
    const [h, m] = hhmm(time).split(':').map(Number);
    const suffix = h < 12 ? 'am' : 'pm';
    const hour = h % 12 || 12;
    return m ? `${hour}:${pad(m)}${suffix}` : `${hour}${suffix}`;
}

function zonedClock(instant, tz) {
    const raw = formatTimeInZone(new Date(instant), tz, { hour: 'numeric', minute: '2-digit' });
    const m = raw.match(/(\d+):(\d+)\s*([AP])M/i);
    if (!m) return raw;
    return `${m[1]}${m[2] === '00' ? '' : `:${m[2]}`}${m[3].toLowerCase()}m`;
}

export async function loadCustomDays(syncId) {
    const [rows] = await pool.execute(
        'SELECT * FROM twitch_schedule_custom_days WHERE sync_id = ? ORDER BY day', [syncId]);
    return new Map(rows.map((r) => [dayKey(r.day), { ...r, day: dayKey(r.day) }]));
}

/** Changes whenever a filled-in day does, so an edit is noticed like a Twitch change is. */
export function hashCustomDays(days) {
    const data = [...days.values()].map((d) => [d.day, d.kind, d.title, d.title_color, d.title_color2,
        d.start_time, d.end_time, d.note, d.note_color].join('|')).join('\n');
    return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/** A filled-in stream as a segment. One with no start time has no instant, so it stays poster-only. */
function daySegment(day, tz) {
    if (day.kind !== 'stream' || !day.start_time) return null;
    const start = zonedInstant(day.day, day.start_time, tz);
    let end = null;
    if (day.end_time) {
        end = zonedInstant(day.day, day.end_time, tz);
        if (end <= start) end = new Date(end.getTime() + 86_400_000); // 7pm to 2am ends the next day
    }
    return {
        id: `custom:${day.day}`, title: day.title || 'Stream', category: null,
        start_time: start.toISOString(), end_time: end ? end.toISOString() : null,
    };
}

export function mergeSegments(source, twitchSegments, days, tz) {
    const own = [...days.values()].map((d) => daySegment(d, tz)).filter(Boolean);
    if (source === 'custom') return own;
    if (source !== 'mixed') return twitchSegments;
    const kept = twitchSegments.filter((s) => !days.has(localDayKey(s.start_time, tz)));
    return [...kept, ...own].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
}

/** The poster moves on to next month for the last week of this one. */
export function posterMonth(tz, now = new Date()) {
    const p = getLocalDateParts(now, tz);
    const lastDay = new Date(Date.UTC(p.year, p.month + 1, 0)).getUTCDate();
    const next = lastDay - p.day < 7;
    const when = new Date(Date.UTC(p.year, p.month + (next ? 1 : 0), 1));
    return { year: when.getUTCFullYear(), month: when.getUTCMonth() };
}

const plainTitle = (raw) => toPlain(raw || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/\s+/g, ' ').trim();

/**
 * Every day of a month, ready to draw or to show in the dashboard editor.
 * `month` is 0-indexed. Nothing scheduled reads NO STREAM, as on a hand-made poster.
 */
export function buildMonth({ year, month, source, segments = [], canceled = [], days = new Map(), tz }) {
    const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const byDate = new Map();
    const collect = (list, cancelled) => {
        for (const s of list) {
            if (String(s.id || '').startsWith('custom:')) continue;
            const key = localDayKey(s.start_time, tz);
            const e = byDate.get(key) || { titles: [], times: [], cancelled: true };
            const title = plainTitle(s.title || s.category?.name);
            if (title && !e.titles.includes(title)) e.titles.push(title);
            const slot = s.end_time ? `${zonedClock(s.start_time, tz)} to ${zonedClock(s.end_time, tz)}` : zonedClock(s.start_time, tz);
            if (!e.times.includes(slot)) e.times.push(slot);
            if (!cancelled) e.cancelled = false;
            byDate.set(key, e);
        }
    };
    if (source !== 'custom') { collect(segments, false); collect(canceled, true); }

    const out = [];
    for (let d = 1; d <= count; d++) {
        const key = `${year}-${pad(month + 1)}-${pad(d)}`;
        const own = source === 'twitch' ? null : days.get(key);
        const twitch = byDate.get(key);
        if (own?.kind === 'stream') {
            const title = own.title || 'Stream';
            const time = own.start_time
                ? (own.end_time ? `${clock(own.start_time)} to ${clock(own.end_time)}` : clock(own.start_time))
                : null;
            out.push({ date: d, key, kind: 'stream', origin: 'custom', title, time, note: own.note || null,
                color: own.title_color || showColor(title), color2: own.title_color2 || null,
                noteColor: own.note_color || null });
        } else if (own) {
            out.push({ date: d, key, kind: 'off', origin: 'custom', title: own.title || 'NO STREAM', time: null,
                note: own.note || null, color: own.title_color || OFF_COLOR, color2: own.title_color2 || null,
                noteColor: own.note_color || null });
        } else if (twitch?.cancelled) {
            out.push({ date: d, key, kind: 'off', origin: 'twitch', title: 'CANCELLED', time: null,
                note: twitch.titles.join(' + ') || null, color: OFF_COLOR, color2: null, noteColor: OFF_COLOR });
        } else if (twitch) {
            const title = twitch.titles.join(' + ') || 'Stream';
            out.push({ date: d, key, kind: 'stream', origin: 'twitch', title, time: twitch.times.join(', '),
                note: null, color: showColor(title), color2: null, noteColor: null });
        } else {
            out.push({ date: d, key, kind: 'off', origin: 'none', title: 'NO STREAM', time: null, note: null,
                color: OFF_COLOR, color2: null, noteColor: null });
        }
    }
    return out;
}

/** Sunday-first column of the 1st of a month. */
export const firstWeekday = (year, month) => new Date(Date.UTC(year, month, 1)).getUTCDay();

export function monthName(year, month) {
    return new Date(Date.UTC(year, month, 15)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
}
