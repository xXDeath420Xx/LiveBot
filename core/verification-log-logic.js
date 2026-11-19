/*
 * Verification activity log — the pure rules (the live side is core/verification-log.js).
 *
 * The Verification page shows ONE log for everything its systems do. It reads two sources:
 *
 *   event    join_gate_events rows written by verification (verify_*), auto-prune (prune_kicked /
 *            _logged / _held), the inactivity prune (prune_inactive_*) and 'failed' rows whose detail
 *            starts "Verification:" / "Auto-prune:" ("Auto-prune: inactive…" for the inactivity prune).
 *   manual   temp_access_members rows closed by a person from the dashboard or a command: "Stop the
 *            clock" (kind verify) and "Remove from queue" (kind prune) — status 'exempt', note "removed…".
 *
 * The SQL filters for each category live here and ONLY here: core/verification.js (stats, recent
 * attempts) and core/inactivity-prune.js (history) use the same strings, so the log, the stats and
 * the slash commands always agree on what counts as which.
 *
 * Paging is keyset, newest first, over the total order (second, source rank, id) — the two sources
 * interleave by time, and a cursor "<unix seconds>-<e|m><id>" says exactly where a page ended, so
 * "Load more" (before=) and live polling (since=) never skip or repeat a row however many rows share
 * a second. Each source query gets the clause from cursorClause(); mergePage() interleaves the results.
 */
import { VERIFY_EVENT_LABEL } from './verification-logic.js';

export const LOG_TYPES = Object.freeze(['all', 'verification', 'prune', 'inactivity', 'failures']);
/** Range key -> hours back (null = everything kept). */
export const LOG_RANGES = Object.freeze({ '24h': 24, '7d': 168, '30d': 720, all: null });
export const DEFAULT_RANGE = 'all';
export const PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
/** Most rows one poll returns; more than this and the page reloads from the top instead. */
export const MAX_SINCE = 100;
/** Most rows a CSV export holds. */
export const MAX_EXPORT = 5000;
export const MAX_QUERY_LENGTH = 100;
/** Most cached members a name search turns into ids. */
export const MAX_SEARCH_IDS = 200;

/** Sources and their place in the total order (higher rank sorts first within the same second). */
export const SOURCES = Object.freeze({ event: { code: 'e', rank: 1 }, manual: { code: 'm', rank: 0 } });
const SOURCE_BY_CODE = { e: 'event', m: 'manual' };
const SNOWFLAKE = /^\d{15,25}$/;
const CURSOR = /^(\d{1,12})-([em])(\d{1,20})$/;

// ── category filters (join_gate_events) ─────────────────────────────────────

/** Note the doubled backslashes: the SQL text must contain `\_` so LIKE treats `_` literally. */
export const CATEGORY_SQL = Object.freeze({
    verification: `(action LIKE 'verify\\_%' OR (action = 'failed' AND detail LIKE 'Verification:%'))`,
    prune: `(action IN ('prune_kicked','prune_logged','prune_held')
        OR (action = 'failed' AND detail LIKE 'Auto-prune:%' AND detail NOT LIKE 'Auto-prune: inactive%'))`,
    inactivity: `(action LIKE 'prune\\_inactive\\_%' OR (action = 'failed' AND detail LIKE 'Auto-prune: inactive%'))`,
});
/** Every row the Verification page's systems write. */
export const LOG_EVENT_FILTER = `(${CATEGORY_SQL.verification} OR ${CATEGORY_SQL.prune} OR ${CATEGORY_SQL.inactivity})`;
/** "Failures": the bot could not act, or a member failed / ran out of time verifying. */
export const FAILURE_ACTIONS = Object.freeze(['failed', 'verify_failed', 'verify_expired']);
const FAILURE_SQL = `action IN (${FAILURE_ACTIONS.map(a => `'${a}'`).join(',')})`;

/** The manual source: a person stopped a CAPTCHA clock or took someone off the auto-prune queue. */
export const MANUAL_FILTER = `status = 'exempt' AND note LIKE 'removed%'`;
const MANUAL_KIND_CATEGORY = { verify: 'verification', prune: 'prune' };

/** The category of one join_gate_events row, or null when it is not one of this page's events. */
export function categoryOf(action, detail = '') {
    const a = String(action || '');
    const d = String(detail || '');
    if (a === 'failed') {
        if (d.startsWith('Verification:')) return 'verification';
        if (d.startsWith('Auto-prune: inactive')) return 'inactivity';
        if (d.startsWith('Auto-prune:')) return 'prune';
        return null;
    }
    if (a.startsWith('verify_')) return 'verification';
    if (a.startsWith('prune_inactive_')) return 'inactivity';
    if (a === 'prune_kicked' || a === 'prune_logged' || a === 'prune_held') return 'prune';
    return null;
}
export const isFailure = (action) => FAILURE_ACTIONS.includes(action);

export const CATEGORY_LABEL = Object.freeze({ verification: 'Verification', prune: 'Auto-prune', inactivity: 'Inactivity' });

/** Short pill text + tone per action (the long wording stays VERIFY_EVENT_LABEL, used as the tooltip). */
const PILL = Object.freeze({
    verify_passed: ['Verified', 'ok'], verify_wrong: ['Wrong code', 'warn'], verify_failed: ['Failed', 'bad'],
    verify_expired: ['Timed out', 'bad'], verify_kicked: ['Kicked', 'bad'], verify_banned: ['Banned', 'bad'],
    verify_timedout: ['Muted', 'bad'], verify_held: ['Held', 'neutral'],
    prune_kicked: ['Pruned', 'bad'], prune_logged: ['Logged', 'neutral'], prune_held: ['Held', 'neutral'],
    prune_inactive_kicked: ['Removed', 'bad'], prune_inactive_warned: ['Warned', 'warn'],
    prune_inactive_logged: ['Logged', 'neutral'], prune_inactive_held: ['Held', 'neutral'],
    failed: ['Could not act', 'bad'],
    manual_verify: ['Clock stopped', 'info'], manual_prune: ['Unqueued', 'info'],
});
const MANUAL_LABEL = { manual_verify: 'CAPTCHA clock stopped by staff', manual_prune: 'Taken off the auto-prune queue by staff' };
/** Actions that may send the member a DM; for the rest "DM" does not apply. */
const DM_ACTIONS = new Set(['verify_kicked', 'verify_banned', 'verify_timedout', 'prune_kicked', 'prune_inactive_kicked', 'prune_inactive_warned', 'failed']);

// ── request parameters ──────────────────────────────────────────────────────

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Validate the query string of GET /log. Returns { ok, error?, params }. Missing values fall back to
 * defaults; malformed ones (bad type, range or cursor, both cursors) are errors.
 */
export function parseLogQuery(query = {}, { maxLimit = MAX_PAGE_SIZE } = {}) {
    const q = query || {};
    const one = (v) => (Array.isArray(v) ? v[0] : v);
    const type = clean(one(q.type)) || 'all';
    if (!LOG_TYPES.includes(type)) return { ok: false, error: `type must be one of ${LOG_TYPES.join(', ')}.` };
    const range = clean(one(q.range)) || DEFAULT_RANGE;
    if (!Object.hasOwn(LOG_RANGES, range)) return { ok: false, error: `range must be one of ${Object.keys(LOG_RANGES).join(', ')}.` };
    const search = clean(one(q.q)).slice(0, MAX_QUERY_LENGTH);
    const rawBefore = clean(one(q.before));
    const rawSince = clean(one(q.since));
    if (rawBefore && rawSince) return { ok: false, error: 'Use before or since, not both.' };
    const before = rawBefore ? decodeCursor(rawBefore) : null;
    const since = rawSince ? decodeCursor(rawSince) : null;
    if ((rawBefore && !before) || (rawSince && !since)) return { ok: false, error: 'That cursor is not valid.' };
    const n = Number(one(q.limit));
    const limit = Number.isInteger(n) && n > 0 ? Math.min(n, maxLimit) : Math.min(PAGE_SIZE, maxLimit);
    return { ok: true, params: { type, range, q: search, before, since, limit } };
}

// ── cursors ─────────────────────────────────────────────────────────────────

/** "<unix seconds>-<e|m><id>" */
export function encodeCursor(row) {
    if (!row || !Number.isFinite(row.sec) || !SOURCES[row.source]) return null;
    return `${Math.floor(row.sec)}-${SOURCES[row.source].code}${row.id}`;
}
export function decodeCursor(s) {
    const m = String(s ?? '').match(CURSOR);
    if (!m) return null;
    const id = Number(m[3]);
    if (!Number.isSafeInteger(id)) return null;
    return { sec: Number(m[1]), source: SOURCE_BY_CODE[m[2]], id };
}

/** Sort comparator, newest first. Order: second desc, source rank desc, id desc. */
export function compareRows(a, b) {
    if (a.sec !== b.sec) return b.sec - a.sec;
    const ra = SOURCES[a.source].rank;
    const rb = SOURCES[b.source].rank;
    if (ra !== rb) return rb - ra;
    return b.id - a.id;
}

/**
 * The WHERE fragment that keeps one source's rows strictly older (dir 'before') or newer ('since') than
 * the cursor in the total order. `tsCol`/`idCol` are trusted column names. Exact seconds via
 * UNIX_TIMESTAMP, so the session time zone (and its DST hour) cannot shift a page boundary.
 */
export function cursorClause(source, cursor, dir, tsCol, idCol) {
    if (!cursor) return { sql: '1=1', params: [] };
    const ts = `UNIX_TIMESTAMP(${tsCol})`;
    const r = SOURCES[source].rank;
    const cr = SOURCES[cursor.source].rank;
    const older = dir === 'before';
    const lt = older ? '<' : '>';
    if (r === cr) return { sql: `(${ts} ${lt} ? OR (${ts} = ? AND ${idCol} ${lt} ?))`, params: [cursor.sec, cursor.sec, cursor.id] };
    // Within the cursor's second, a lower-ranked source's rows sort after the cursor row, a higher one's before.
    const sameSecondCounts = older ? r < cr : r > cr;
    return { sql: `${ts} ${lt}${sameSecondCounts ? '=' : ''} ?`, params: [cursor.sec] };
}

// ── filters ─────────────────────────────────────────────────────────────────

/** WHERE fragment for the event source's type filter. */
export function eventTypeClause(type) {
    if (type === 'failures') return `(${LOG_EVENT_FILTER} AND ${FAILURE_SQL})`;
    if (CATEGORY_SQL[type]) return CATEGORY_SQL[type];
    return LOG_EVENT_FILTER;
}
/** Which manual kinds a type filter shows ([] = skip the manual source). */
export function manualKindsFor(type) {
    if (type === 'all') return ['verify', 'prune'];
    if (type === 'verification') return ['verify'];
    if (type === 'prune') return ['prune'];
    return [];
}
/** Hours back for a range key (null = no limit). */
export const rangeHours = (range) => (Object.hasOwn(LOG_RANGES, range) ? LOG_RANGES[range] : null);

/** Escape LIKE wildcards (the default escape character is a backslash). */
export const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Cached members whose name contains `q` (case-insensitive): username, global name or server nickname.
 * `members` is any iterable of { id, username, globalName, displayName }.
 */
export function matchMemberIds(members, q, cap = MAX_SEARCH_IDS) {
    const needle = clean(q).toLowerCase();
    if (!needle) return [];
    const out = [];
    for (const m of members || []) {
        if (out.length >= cap) break;
        const names = [m?.username, m?.globalName, m?.displayName];
        if (names.some(n => n && String(n).toLowerCase().includes(needle))) out.push(String(m.id));
    }
    return out;
}

/**
 * WHERE fragment for the member search on one source. An id matches user_id exactly; a name matches the
 * stored username (event rows only) or any cached member id from matchMemberIds.
 */
export function searchClause(source, q, ids = []) {
    const term = clean(q);
    if (!term) return { sql: '1=1', params: [] };
    if (SNOWFLAKE.test(term)) return { sql: 'user_id = ?', params: [term] };
    const parts = [];
    const params = [];
    if (source === 'event') { parts.push('username LIKE ?'); params.push(`%${likeEscape(term)}%`); }
    const list = [...new Set(ids.map(String).filter(id => SNOWFLAKE.test(id)))].slice(0, MAX_SEARCH_IDS);
    if (list.length) { parts.push(`user_id IN (${list.map(() => '?').join(',')})`); params.push(...list); }
    return parts.length ? { sql: `(${parts.join(' OR ')})`, params } : { sql: '0=1', params: [] };
}

// ── rows ────────────────────────────────────────────────────────────────────

const toSec = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : null;
};

/** One join_gate_events row (with `ts` = UNIX_TIMESTAMP(created_at)) as a log row. */
export function normaliseEvent(r) {
    const sec = toSec(r.ts);
    const action = String(r.action);
    const [pill, tone] = PILL[action] || [VERIFY_EVENT_LABEL[action] || action, 'neutral'];
    const category = categoryOf(action, r.detail);
    const row = {
        source: 'event', id: Number(r.id), sec, at: sec == null ? null : sec * 1000,
        userId: String(r.user_id), username: r.username || null,
        action, category, categoryLabel: CATEGORY_LABEL[category] || null,
        pill, label: VERIFY_EVENT_LABEL[action] || action, tone, failure: isFailure(action),
        detail: r.detail || null,
        dm: Number(r.dm_delivered) ? true : DM_ACTIONS.has(action) ? false : null,
    };
    row.cursor = encodeCursor(row);
    return row;
}

/**
 * Inactivity warnings the member has since answered: a warning row whose member was active (message or
 * voice join) after it was sent is shown as "Back", with when and where they came back (a link to the
 * message, or the voice channel they joined). The stored event is not changed; this is read-time only.
 * `activity` maps userId -> { msgSec, msgChannelId, messageId, voiceSec, voiceChannelId } (or a bare
 * epoch-seconds number when only the time is known).
 */
export function markAnsweredWarnings(rows, activity) {
    for (const r of rows) {
        if (r.action !== 'prune_inactive_warned' || r.sec == null) continue;
        const a = activity?.get?.(r.userId);
        const info = typeof a === 'object' && a ? a : { msgSec: Number(a) };
        const msgSec = Number(info.msgSec) || 0, voiceSec = Number(info.voiceSec) || 0;
        const back = Math.max(msgSec, voiceSec);
        if (!back || back <= r.sec) continue;
        const viaVoice = voiceSec > msgSec;
        r.pill = 'Back';
        r.tone = 'ok';
        r.label = 'Warning cancelled: active again';
        r.answer = {
            at: back * 1000,
            kind: viaVoice ? 'voice' : 'message',
            channelId: (viaVoice ? info.voiceChannelId : info.msgChannelId) || null,
            messageId: viaVoice ? null : (info.messageId || null),
        };
        r.detail = `${r.detail ? `${r.detail}; ` : ''}cancelled: ${viaVoice ? 'joined voice' : 'posted'} ${new Date(back * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    }
    return rows;
}

/** One closed temp_access_members row (with `ts` = UNIX_TIMESTAMP(resolved_at)) as a log row. */
export function normaliseManual(r) {
    const sec = toSec(r.ts);
    const action = `manual_${r.kind}`;
    const category = MANUAL_KIND_CATEGORY[r.kind] || null;
    const [pill, tone] = PILL[action] || ['Staff action', 'info'];
    const row = {
        source: 'manual', id: Number(r.id), sec, at: sec == null ? null : sec * 1000,
        userId: String(r.user_id), username: null,
        action, category, categoryLabel: CATEGORY_LABEL[category] || null,
        pill, label: MANUAL_LABEL[action] || 'Staff action', tone, failure: false,
        detail: r.note || null, dm: null,
    };
    row.cursor = encodeCursor(row);
    return row;
}

/**
 * Interleave per-source pages (each fetched newest first with limit + 1) into one page.
 * Returns { rows, hasMore, nextCursor }. Rows without a time are dropped (they cannot be paged).
 */
export function mergePage(lists, limit) {
    const all = lists.flat().filter(r => r && r.sec != null && Number.isFinite(r.id)).sort(compareRows);
    const rows = all.slice(0, limit);
    return { rows, hasMore: all.length > limit, nextCursor: rows.length ? rows[rows.length - 1].cursor : null };
}

/**
 * Counts per filter chip. `eventGroups`: rows of { action, detail_kind, n } where detail_kind is the
 * category of a 'failed' row (FAILED_KIND_SQL); `manualGroups`: { kind, n }.
 */
export function countsFrom(eventGroups = [], manualGroups = []) {
    const out = { all: 0, verification: 0, prune: 0, inactivity: 0, failures: 0 };
    for (const g of eventGroups || []) {
        const n = Number(g.n) || 0;
        const cat = g.action === 'failed' ? (CATEGORY_LABEL[g.detail_kind] ? g.detail_kind : null) : categoryOf(g.action);
        if (!cat) continue;
        out.all += n;
        out[cat] += n;
        if (isFailure(g.action)) out.failures += n;
    }
    for (const g of manualGroups || []) {
        const n = Number(g.n) || 0;
        const cat = MANUAL_KIND_CATEGORY[g.kind];
        if (!cat) continue;
        out.all += n;
        out[cat] += n;
    }
    return out;
}
/** SQL expression giving a 'failed' row's category for countsFrom (matches categoryOf). */
export const FAILED_KIND_SQL = `CASE WHEN action <> 'failed' THEN NULL
    WHEN detail LIKE 'Verification:%' THEN 'verification'
    WHEN detail LIKE 'Auto-prune: inactive%' THEN 'inactivity'
    WHEN detail LIKE 'Auto-prune:%' THEN 'prune' END`;

// ── CSV ─────────────────────────────────────────────────────────────────────

/** One CSV cell: quoted when needed; a leading = + - @ (spreadsheet formula) is neutralised. */
export function csvCell(v) {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const CSV_HEADER = Object.freeze(['Time (UTC)', 'Member ID', 'Username', 'Display name', 'Type', 'Event', 'Detail', 'DM']);
/** Log rows (with optional `user` bits) as CSV text, header first, CRLF line ends. */
export function toCsv(rows) {
    const lines = [CSV_HEADER.map(csvCell).join(',')];
    for (const r of rows || []) {
        lines.push([
            r.at != null ? new Date(r.at).toISOString().replace('T', ' ').slice(0, 19) : '',
            r.userId, r.user?.username || r.username || '', r.user?.displayName || '',
            r.categoryLabel || '', r.label, r.detail || '',
            r.dm === true ? 'delivered' : r.dm === false ? 'not delivered' : '',
        ].map(csvCell).join(','));
    }
    return lines.join('\r\n') + '\r\n';
}

export default {
    markAnsweredWarnings,
    LOG_TYPES, LOG_RANGES, DEFAULT_RANGE, PAGE_SIZE, MAX_PAGE_SIZE, MAX_SINCE, MAX_EXPORT, SOURCES, CATEGORY_SQL,
    LOG_EVENT_FILTER, FAILURE_ACTIONS, MANUAL_FILTER, FAILED_KIND_SQL, categoryOf, isFailure, parseLogQuery,
    encodeCursor, decodeCursor, compareRows, cursorClause, eventTypeClause, manualKindsFor, rangeHours, likeEscape,
    matchMemberIds, searchClause, normaliseEvent, normaliseManual, mergePage, countsFrom, csvCell, toCsv,
};
