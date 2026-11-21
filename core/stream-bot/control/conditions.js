/*
 * Stream bot control: the wave 2 conditions (W2.3), registered through conditions.js registerConditionType().
 *
 *   stream.live       Only while live (or only while offline)            stream-info.js, cached 60 s
 *   time.window       Time and day, in a time zone the streamer picks     the clock
 *   stream.category   Category is / is not / contains                    stream-info.js
 *   stream.viewers    Viewer count between a minimum and a maximum        stream-info.js
 *   follow.check      Follows the channel (for at least N days)           Helix /channels/followers (moderator:read:followers),
 *                                                                          cached 10 minutes per viewer; Twitch only
 *   variable.value    A stored value ({sdb:} / {db:}) compared to text   the variable store
 *
 *   controlConditions({ streamInfo(profileId, ev), followedAt(profileId, ev), variable(profileId, ev, scope, key), now })
 *
 * The data is read once per run, before the checks (conditions.js loadConditionData), so check() stays synchronous.
 * Tested in tests/stream-bot-control.test.js.
 */

const DAYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const short = (s, n = 60) => String(s ?? '').slice(0, n);

/** "Mon-Fri", "sat,sun", "weekdays", "" (every day) → a Set of day numbers (0 = Sunday), or null when it cannot be read. */
export function parseDays(text) {
    const t = String(text ?? '').trim().toLowerCase();
    if (!t || t === 'every day' || t === 'daily' || t === 'any') return new Set([0, 1, 2, 3, 4, 5, 6]);
    if (t === 'weekdays') return new Set([1, 2, 3, 4, 5]);
    if (t === 'weekends' || t === 'weekend') return new Set([0, 6]);
    const out = new Set();
    for (const part of t.split(/[\s,]+/).filter(Boolean)) {
        const m = part.match(/^([a-z]{3})[a-z]*(?:-([a-z]{3})[a-z]*)?$/);
        if (!m) return null;
        const a = DAYS.indexOf(m[1]);
        const b = m[2] ? DAYS.indexOf(m[2]) : a;
        if (a < 0 || b < 0) return null;
        for (let i = a; ; i = (i + 1) % 7) { out.add(i); if (i === b) break; }
    }
    return out.size ? out : null;
}

/** Day of week (0-6) and minutes after midnight in a time zone; null for an unknown zone. */
export function localClock(ms, timeZone) {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timeZone || 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
        const get = (t) => parts.find((p) => p.type === t)?.value;
        return { day: DAYS.indexOf(String(get('weekday')).slice(0, 3).toLowerCase()), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
    } catch { return null; }
}
export const validZone = (z) => { try { new Intl.DateTimeFormat('en-GB', { timeZone: z }); return true; } catch { return false; } };
const mins = (hhmm) => { const m = String(hhmm || '').match(HHMM); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** Inside the window? `from` after `until` spans midnight (22:00 to 02:00); the day is the day the window started. */
export function inWindow(c, ms) {
    const clock = localClock(ms, c.timezone);
    if (!clock) return { ok: false, detail: `unknown time zone ${short(c.timezone, 40)}` };
    const days = parseDays(c.days) || new Set([0, 1, 2, 3, 4, 5, 6]);
    const from = mins(c.from);
    const until = mins(c.until);
    const label = `${DAYS[clock.day]} ${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')} ${c.timezone || 'UTC'}`;
    if (from == null || until == null || from === until) return { ok: days.has(clock.day), detail: `it is ${label}` };
    if (from < until) return { ok: days.has(clock.day) && clock.minutes >= from && clock.minutes < until, detail: `it is ${label}` };
    const lateEvening = clock.minutes >= from;
    const startedDay = lateEvening ? clock.day : (clock.day + 6) % 7;
    return { ok: days.has(startedDay) && (lateEvening || clock.minutes < until), detail: `it is ${label}` };
}

const VAR_OPS = Object.freeze({ eq: 'is', neq: 'is not', contains: 'contains', gt: 'is more than', lt: 'is less than', empty: 'is empty', set: 'has a value' });

export function compareValue(op, have, want) {
    const a = String(have ?? '');
    const b = String(want ?? '');
    switch (op) {
        case 'neq': return a.toLowerCase() !== b.toLowerCase();
        case 'contains': return a.toLowerCase().includes(b.toLowerCase());
        case 'gt': return a !== '' && Number(a) > Number(b);
        case 'lt': return a !== '' && Number(a) < Number(b);
        case 'empty': return a === '';
        case 'set': return a !== '';
        case 'eq': default: return a.toLowerCase() === b.toLowerCase();
    }
}

export function controlConditions({ streamInfo, followedAt, variable, now = () => Date.now() } = {}) {
    const infoLoad = { key: 'streamInfo', fn: async ({ ev, profileId }) => (streamInfo ? streamInfo(profileId, ev) : null) };
    return [
        {
            type: 'stream.live', label: 'Only while live', help: 'Checks whether your stream is live right now (at most a minute old).',
            fields: [{ name: 'state', kind: 'select', label: 'Run only while', options: ['live', 'offline'], optionLabels: { live: 'You are live', offline: 'You are offline' }, default: 'live' }],
            load: infoLoad,
            check(c, ev, ctx) {
                const info = ctx?.loaded?.streamInfo;
                if (!info) return { ok: false, detail: 'could not tell whether you are live' };
                const ok = c.state === 'offline' ? !info.live : !!info.live;
                return { ok, detail: info.live ? 'you are live' : 'you are offline' };
            },
            validate(c) { return { type: 'stream.live', state: c.state === 'offline' ? 'offline' : 'live' }; },
        },
        {
            type: 'time.window', label: 'Time and day', help: 'Only on these days and between these times, in your time zone. A window such as 22:00 to 02:00 runs past midnight.',
            fields: [
                { name: 'days', kind: 'text', label: 'Days, such as Mon-Fri, Sat,Sun or weekends (empty: every day)', default: '' },
                { name: 'from', kind: 'text', label: 'From (24-hour, such as 18:00; empty: all day)', default: '' },
                { name: 'until', kind: 'text', label: 'Until (such as 23:30)', default: '' },
                { name: 'timezone', kind: 'text', label: 'Time zone, such as America/New_York or Europe/London', default: 'UTC' },
            ],
            check(c) { return inWindow(c, now()); },
            validate(c, err) {
                const out = { type: 'time.window', days: short(c.days, 60).trim(), from: short(c.from, 5).trim(), until: short(c.until, 5).trim(), timezone: short(c.timezone, 60).trim() || 'UTC' };
                if (parseDays(out.days) === null) err('Time and day: write the days like Mon-Fri, Sat,Sun or weekends.');
                if ((out.from && !HHMM.test(out.from)) || (out.until && !HHMM.test(out.until))) err('Time and day: write times like 18:00.');
                if (!!out.from !== !!out.until) err('Time and day: give both times, or neither.');
                if (!validZone(out.timezone)) err('Time and day: that time zone is not known. Use a name such as Europe/London.');
                return out;
            },
        },
        {
            type: 'stream.category', label: 'Stream category', help: 'Your current category or game (at most a minute old).',
            fields: [
                { name: 'op', kind: 'select', label: 'The category', options: ['eq', 'neq', 'contains'], optionLabels: { eq: 'is', neq: 'is not', contains: 'contains' }, default: 'eq' },
                { name: 'value', kind: 'text', label: 'Category, such as Just Chatting (separate several with |)', default: '' },
            ],
            load: infoLoad,
            check(c, ev, ctx) {
                const info = ctx?.loaded?.streamInfo;
                if (!info) return { ok: false, detail: 'could not read your category' };
                const cat = String(info.category || '');
                const any = String(c.value).split('|').map((x) => x.trim()).filter(Boolean);
                const hit = any.some((v) => compareValue(c.op === 'contains' ? 'contains' : 'eq', cat, v));
                return { ok: c.op === 'neq' ? !hit : hit, detail: `category is ${cat ? `"${short(cat)}"` : 'not set'}` };
            },
            validate(c, err) {
                const value = short(c.value, 300).trim();
                if (!value) err('Stream category: enter the category.');
                return { type: 'stream.category', op: ['eq', 'neq', 'contains'].includes(c.op) ? c.op : 'eq', value };
            },
        },
        {
            type: 'stream.viewers', label: 'Viewer count', help: 'Viewers watching now (at most a minute old). 0 while you are offline.',
            fields: [
                { name: 'min', kind: 'number', label: 'At least', min: 0, max: 10000000, step: 1, default: 0 },
                { name: 'max', kind: 'number', label: 'At most (empty: no limit)', min: 0, max: 10000000, step: 1 },
            ],
            load: infoLoad,
            check(c, ev, ctx) {
                const info = ctx?.loaded?.streamInfo;
                if (!info) return { ok: false, detail: 'could not read the viewer count' };
                const v = Number(info.viewers) || 0;
                const ok = v >= (Number(c.min) || 0) && (c.max == null || v <= Number(c.max));
                return { ok, detail: `${v} viewer${v === 1 ? '' : 's'}` };
            },
            validate(c, err) {
                const min = Number(c.min ?? 0);
                const max = c.max === '' || c.max == null ? null : Number(c.max);
                if (!Number.isFinite(min) || min < 0 || (max != null && (!Number.isFinite(max) || max < min))) err('Viewer count: use numbers, with the most at or above the least.');
                return { type: 'stream.viewers', min: Number.isFinite(min) ? Math.max(0, Math.round(min)) : 0, max: max != null && Number.isFinite(max) ? Math.round(max) : null };
            },
        },
        {
            type: 'follow.check', label: 'Follows the channel', help: 'Twitch only: whether the viewer follows you, and for how long. Checked at most every 10 minutes per viewer.',
            fields: [
                { name: 'state', kind: 'select', label: 'The viewer', options: ['follows', 'not'], optionLabels: { follows: 'Follows you', not: 'Does not follow you' }, default: 'follows' },
                { name: 'days', kind: 'number', label: 'For at least (days, 0: any time)', min: 0, max: 10000, step: 1, default: 0 },
            ],
            load: { key: 'followedAt', fn: async ({ ev, profileId }) => (followedAt ? followedAt(profileId, ev) : { known: false }) },
            check(c, ev, ctx) {
                const f = ctx?.loaded?.followedAt;
                if (!f || !f.known) return { ok: false, detail: f?.reason || 'could not check (Twitch viewers only)' };
                const days = f.at ? Math.floor((now() - Date.parse(f.at)) / 86400000) : null;
                const follows = !!f.at && days >= (Number(c.days) || 0);
                return { ok: c.state === 'not' ? !f.at : follows, detail: f.at ? `followed ${days} day${days === 1 ? '' : 's'} ago` : 'does not follow' };
            },
            validate(c) { return { type: 'follow.check', state: c.state === 'not' ? 'not' : 'follows', days: Math.max(0, Math.min(10000, Math.round(Number(c.days) || 0))) }; },
        },
        {
            type: 'variable.value', label: 'Stored value', help: 'A value kept with {sdb:} or {db:}, or by Set a variable and Add to a counter.',
            fields: [
                { name: 'scope', kind: 'select', label: 'For', options: ['channel', 'user'], optionLabels: { channel: 'Your channel ({sdb:})', user: 'The viewer ({db:})' }, default: 'channel' },
                { name: 'key', kind: 'text', label: 'Name, such as deaths', default: '' },
                { name: 'op', kind: 'select', label: 'Test', options: Object.keys(VAR_OPS), optionLabels: VAR_OPS, default: 'eq' },
                { name: 'value', kind: 'text', label: 'Value (not used for "is empty" and "has a value")', default: '' },
            ],
            load: { key: 'variables', fn: async ({ ev, profileId, conditions }) => {
                const out = {};
                for (const c of conditions || []) {
                    if (c?.type !== 'variable.value' || !c.key) continue;
                    const k = `${c.scope}:${c.key}`;
                    if (k in out) continue;
                    try { out[k] = variable ? await variable(profileId, ev, c.scope, c.key) : null; } catch { out[k] = null; }
                }
                return out;
            } },
            check(c, ev, ctx) {
                const have = ctx?.loaded?.variables?.[`${c.scope}:${c.key}`];
                if (have === undefined && c.scope === 'user' && !ev?.user?.id) return { ok: false, detail: 'this event has no viewer' };
                const ok = compareValue(c.op, have, c.value);
                return { ok, detail: `${c.key} is "${short(have ?? '', 40)}"` };
            },
            validate(c, err) {
                const key = String(c.key ?? '').trim().toLowerCase();
                if (!/^[a-z0-9_.-]{1,64}$/.test(key)) err('Stored value: the name may use 1 to 64 letters, numbers, _ . or -.');
                return { type: 'variable.value', scope: c.scope === 'user' ? 'user' : 'channel', key, op: Object.keys(VAR_OPS).includes(c.op) ? c.op : 'eq', value: short(c.value, 500) };
            },
        },
    ];
}

export default { controlConditions, parseDays, localClock, inWindow, compareValue };
