import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseLogQuery, encodeCursor, decodeCursor, compareRows, cursorClause, eventTypeClause, manualKindsFor, rangeHours,
    likeEscape, matchMemberIds, searchClause, normaliseEvent, normaliseManual, mergePage, countsFrom, csvCell, toCsv,
    categoryOf, isFailure, CATEGORY_SQL, LOG_EVENT_FILTER, MANUAL_FILTER, LOG_TYPES, PAGE_SIZE, MAX_PAGE_SIZE, CSV_HEADER,
} from '../core/verification-log-logic.js';

/*
 * The Verification page's activity log (core/verification-log-logic.js): request validation, the
 * category filters, row normalisation across the two sources (join_gate_events + staff queue actions),
 * keyset cursors and their SQL, merging pages, counts and CSV. No database: cursor clauses are checked
 * by evaluating them against in-memory rows.
 */

const U1 = '111111111111111111';
const U2 = '222222222222222222';

const ev = (id, ts, action = 'verify_passed', extra = {}) => ({ id, user_id: U1, username: 'alice', action, detail: null, dm_delivered: 0, ts, ...extra });
const man = (id, ts, kind = 'verify', note = 'removed by mod') => ({ id, user_id: U2, kind, note, ts });

/** Evaluate a cursorClause() fragment against one row: only the shapes cursorClause emits. */
function holds(clause, row) {
    let i = 0;
    const js = clause.sql
        .replace(/UNIX_TIMESTAMP\([a-z_]+\)/g, 'S')
        .replace(/\bid\b/g, 'I')
        .replace(/\?/g, () => JSON.stringify(clause.params[i++]))
        .replace(/ = /g, ' === ')
        .replace(/\bOR\b/g, '||')
        .replace(/\bAND\b/g, '&&');
    assert.equal(i, clause.params.length, 'every placeholder has a param');
    assert.match(js, /^[\sSI0-9<>=|&()1]+$/, `unexpected SQL shape: ${clause.sql}`);
    return Function('S', 'I', `return (${js});`)(row.sec, row.id);
}

test('parseLogQuery: defaults, validation and limits', () => {
    const d = parseLogQuery({});
    assert.equal(d.ok, true);
    assert.deepEqual(d.params, { type: 'all', range: 'all', q: '', before: null, since: null, limit: PAGE_SIZE });
    for (const t of LOG_TYPES) assert.equal(parseLogQuery({ type: t }).params.type, t);
    assert.equal(parseLogQuery({ type: 'bans' }).ok, false);
    assert.equal(parseLogQuery({ range: '90d' }).ok, false);
    assert.equal(parseLogQuery({ range: '24h' }).params.range, '24h');
    assert.equal(parseLogQuery({ before: 'nope' }).ok, false);
    assert.equal(parseLogQuery({ since: '12-x5' }).ok, false);
    assert.equal(parseLogQuery({ before: '1700000000-e5', since: '1700000000-e6' }).ok, false);
    assert.deepEqual(parseLogQuery({ before: '1700000000-m42' }).params.before, { sec: 1700000000, source: 'manual', id: 42 });
    assert.equal(parseLogQuery({ limit: '5000' }).params.limit, MAX_PAGE_SIZE);
    assert.equal(parseLogQuery({ limit: '-3' }).params.limit, PAGE_SIZE);
    assert.equal(parseLogQuery({ limit: '2.5' }).params.limit, PAGE_SIZE);
    // Arrays from repeated params, control characters and over-long searches.
    assert.equal(parseLogQuery({ type: ['prune', 'all'] }).params.type, 'prune');
    assert.equal(parseLogQuery({ q: '  ali\u0000ce \n ' }).params.q, 'ali ce');
    assert.equal(parseLogQuery({ q: 'x'.repeat(500) }).params.q.length, 100);
});

test('cursors round-trip and reject junk', () => {
    const row = normaliseEvent(ev(77, 1700000123));
    assert.equal(row.cursor, '1700000123-e77');
    assert.deepEqual(decodeCursor(row.cursor), { sec: 1700000123, source: 'event', id: 77 });
    assert.equal(encodeCursor(normaliseManual(man(5, 1700000000))), '1700000000-m5');
    for (const bad of ['', '1-e', 'a-e1', '1-x1', '1-e1-2', '1700000000-e99999999999999999999', null, undefined]) assert.equal(decodeCursor(bad), null, String(bad));
    assert.equal(encodeCursor({ sec: null, source: 'event', id: 1 }), null);
});

test('total order: second, then events before staff actions, then id — newest first', () => {
    const rows = [
        normaliseManual(man(9, 100)), normaliseEvent(ev(3, 100)), normaliseEvent(ev(4, 100)),
        normaliseEvent(ev(1, 99)), normaliseManual(man(2, 101)),
    ].sort(compareRows);
    assert.deepEqual(rows.map(r => r.cursor), ['101-m2', '100-e4', '100-e3', '100-m9', '99-e1']);
});

test('cursorClause matches compareRows for every source and direction', () => {
    const rows = [];
    let id = 1;
    for (const sec of [100, 101, 102]) {
        for (let k = 0; k < 3; k++) rows.push(normaliseEvent(ev(id++, sec)));
        for (let k = 0; k < 2; k++) rows.push(normaliseManual(man(id++, sec)));
    }
    for (const cur of rows) {
        const c = decodeCursor(cur.cursor);
        for (const r of rows) {
            const cmp = compareRows(r, cur); // > 0: r is older (sorts after the cursor)
            const before = holds(cursorClause(r.source, c, 'before', 'created_at', 'id'), r);
            const since = holds(cursorClause(r.source, c, 'since', 'created_at', 'id'), r);
            assert.equal(before, cmp > 0, `before ${cur.cursor} vs ${r.cursor}`);
            assert.equal(since, cmp < 0, `since ${cur.cursor} vs ${r.cursor}`);
        }
    }
    assert.deepEqual(cursorClause('event', null, 'before', 'created_at', 'id'), { sql: '1=1', params: [] });
    assert.match(cursorClause('manual', decodeCursor('5-m1'), 'before', 'resolved_at', 'id').sql, /UNIX_TIMESTAMP\(resolved_at\)/);
});

test('keyset paging across both sources never skips or repeats a row', () => {
    // 3 events + 1 staff action in every second, 40 seconds: many rows share a second.
    const events = [];
    const manual = [];
    let id = 1;
    for (let sec = 1000; sec < 1040; sec++) {
        for (let k = 0; k < 3; k++) events.push(normaliseEvent(ev(id++, sec)));
        manual.push(normaliseManual(man(id++, sec)));
    }
    const source = (list, src, cursor, n) => list
        .filter(r => !cursor || holds(cursorClause(src, cursor, 'before', 'created_at', 'id'), r))
        .sort(compareRows).slice(0, n);
    const seen = [];
    let cursor = null;
    let pages = 0;
    for (;;) {
        const limit = 7;
        const page = mergePage([source(events, 'event', cursor, limit + 1), source(manual, 'manual', cursor, limit + 1)], limit);
        seen.push(...page.rows.map(r => r.cursor));
        pages++;
        if (!page.hasMore) break;
        cursor = decodeCursor(page.nextCursor);
        assert.ok(pages < 100);
    }
    const all = [...events, ...manual].sort(compareRows).map(r => r.cursor);
    assert.deepEqual(seen, all);
    assert.equal(new Set(seen).size, all.length);
});

test('mergePage: limit, hasMore, nextCursor; rows without a time are dropped', () => {
    const a = [normaliseEvent(ev(5, 50)), normaliseEvent(ev(4, 40)), normaliseEvent(ev(3, 30))];
    const b = [normaliseManual(man(9, 45)), normaliseManual(man(8, null))];
    const p = mergePage([a, b], 3);
    assert.deepEqual(p.rows.map(r => r.cursor), ['50-e5', '45-m9', '40-e4']);
    assert.equal(p.hasMore, true);
    assert.equal(p.nextCursor, '40-e4');
    const q = mergePage([a, b], 10);
    assert.equal(q.rows.length, 4);
    assert.equal(q.hasMore, false);
    assert.deepEqual(mergePage([[], []], 5), { rows: [], hasMore: false, nextCursor: null });
});

test('categoryOf / isFailure cover every event the page shows', () => {
    const cases = {
        verify_passed: 'verification', verify_wrong: 'verification', verify_failed: 'verification', verify_expired: 'verification',
        verify_kicked: 'verification', verify_banned: 'verification', verify_timedout: 'verification', verify_held: 'verification',
        prune_kicked: 'prune', prune_logged: 'prune', prune_held: 'prune',
        prune_inactive_kicked: 'inactivity', prune_inactive_warned: 'inactivity', prune_inactive_logged: 'inactivity', prune_inactive_held: 'inactivity',
        name_banned: null, spammer_kicked: null, avatar_logged: null, kicked_new: null,
    };
    for (const [action, cat] of Object.entries(cases)) assert.equal(categoryOf(action), cat, action);
    assert.equal(categoryOf('failed', 'Verification: could not kick (role hierarchy)'), 'verification');
    assert.equal(categoryOf('failed', 'Auto-prune: kick failed: Missing Permissions'), 'prune');
    assert.equal(categoryOf('failed', 'Auto-prune: inactive: could not kick (never, 30 d)'), 'inactivity');
    assert.equal(categoryOf('failed', 'name filter: cannot ban'), null);
    assert.equal(categoryOf('failed', null), null);
    assert.ok(isFailure('failed') && isFailure('verify_failed') && isFailure('verify_expired'));
    assert.ok(!isFailure('verify_wrong') && !isFailure('prune_kicked'));
});

test('SQL filters: one definition, LIKE underscores escaped, failures scoped to the page', () => {
    assert.ok(CATEGORY_SQL.verification.includes(String.raw`'verify\_%'`));
    assert.ok(CATEGORY_SQL.inactivity.includes(String.raw`'prune\_inactive\_%'`));
    assert.ok(CATEGORY_SQL.prune.includes("NOT LIKE 'Auto-prune: inactive%'"));
    for (const k of Object.keys(CATEGORY_SQL)) assert.ok(LOG_EVENT_FILTER.includes(CATEGORY_SQL[k]), k);
    assert.equal(eventTypeClause('all'), LOG_EVENT_FILTER);
    assert.equal(eventTypeClause('prune'), CATEGORY_SQL.prune);
    assert.ok(eventTypeClause('failures').startsWith(`(${LOG_EVENT_FILTER} AND action IN ('failed','verify_failed','verify_expired')`));
    assert.match(MANUAL_FILTER, /status = 'exempt' AND note LIKE 'removed%'/);
    assert.deepEqual(manualKindsFor('all'), ['verify', 'prune']);
    assert.deepEqual(manualKindsFor('verification'), ['verify']);
    assert.deepEqual(manualKindsFor('prune'), ['prune']);
    assert.deepEqual(manualKindsFor('inactivity'), []);
    assert.deepEqual(manualKindsFor('failures'), []);
    assert.equal(rangeHours('24h'), 24);
    assert.equal(rangeHours('7d'), 168);
    assert.equal(rangeHours('30d'), 720);
    assert.equal(rangeHours('all'), null);
    assert.equal(rangeHours('__proto__'), null);
});

test('search: ids exact, names by stored username + cached members, wildcards escaped', () => {
    assert.deepEqual(searchClause('event', ''), { sql: '1=1', params: [] });
    assert.deepEqual(searchClause('event', U1), { sql: 'user_id = ?', params: [U1] });
    assert.deepEqual(searchClause('manual', U1), { sql: 'user_id = ?', params: [U1] });
    const e = searchClause('event', 'al_i%', [U2, 'junk', U2]);
    assert.equal(e.sql, '(username LIKE ? OR user_id IN (?))');
    assert.deepEqual(e.params, [String.raw`%al\_i\%%`, U2]);
    assert.deepEqual(searchClause('manual', 'alice', []), { sql: '0=1', params: [] });
    assert.deepEqual(searchClause('manual', 'alice', [U1]), { sql: '(user_id IN (?))', params: [U1] });
    assert.equal(likeEscape(String.raw`a\b`), String.raw`a\\b`);
    const members = [
        { id: U1, username: 'alice', globalName: 'Alice A', displayName: 'Ally' },
        { id: U2, username: 'bob', globalName: null, displayName: 'Bobby Tables' },
    ];
    assert.deepEqual(matchMemberIds(members, 'ALL'), [U1]);
    assert.deepEqual(matchMemberIds(members, 'tables'), [U2]);
    assert.deepEqual(matchMemberIds(members, 'a', 1), [U1]);
    assert.deepEqual(matchMemberIds(members, '  '), []);
    assert.deepEqual(matchMemberIds(null, 'x'), []);
});

test('normaliseEvent / normaliseManual: one row shape for both sources', () => {
    const k = normaliseEvent(ev(10, '1700000000', 'prune_inactive_kicked', { dm_delivered: 1, detail: 'no message for 90 days' }));
    assert.equal(k.source, 'event');
    assert.equal(k.at, 1700000000000);
    assert.equal(k.category, 'inactivity');
    assert.equal(k.categoryLabel, 'Inactivity');
    assert.equal(k.pill, 'Removed');
    assert.equal(k.tone, 'bad');
    assert.equal(k.dm, true);
    assert.equal(k.username, 'alice');
    assert.equal(k.label, 'Removed for inactivity');
    const w = normaliseEvent(ev(11, 1700000001, 'prune_inactive_warned'));
    assert.equal(w.dm, false, 'a DM-capable action with no delivery shows "not sent"');
    assert.equal(w.tone, 'warn');
    const p = normaliseEvent(ev(12, 1700000002, 'verify_passed', { detail: 'CAPTCHA' }));
    assert.equal(p.dm, null, 'DM does not apply to a pass');
    assert.equal(p.tone, 'ok');
    assert.equal(p.failure, false);
    const f = normaliseEvent(ev(13, 1700000003, 'failed', { detail: 'Auto-prune: kick failed: Missing Permissions' }));
    assert.equal(f.category, 'prune');
    assert.equal(f.failure, true);
    assert.equal(f.pill, 'Could not act');
    const odd = normaliseEvent(ev(14, null, 'verify_held'));
    assert.equal(odd.at, null);
    assert.equal(odd.cursor, null);
    const m = normaliseManual(man(3, 1700000004, 'prune', 'removed from the queue by mod'));
    assert.equal(m.source, 'manual');
    assert.equal(m.category, 'prune');
    assert.equal(m.pill, 'Unqueued');
    assert.equal(m.tone, 'info');
    assert.equal(m.detail, 'removed from the queue by mod');
    assert.equal(m.dm, null);
    assert.equal(normaliseManual(man(4, 1, 'verify')).pill, 'Clock stopped');
    // Same keys either way, so the page renders them the same.
    assert.deepEqual(Object.keys(m).sort(), Object.keys(k).sort());
});

test('countsFrom: per chip, failed rows by their detail, staff actions included', () => {
    const counts = countsFrom([
        { action: 'verify_passed', detail_kind: null, n: 10 },
        { action: 'verify_failed', detail_kind: null, n: '2' },
        { action: 'verify_expired', detail_kind: null, n: 1 },
        { action: 'prune_kicked', detail_kind: null, n: 4 },
        { action: 'prune_inactive_warned', detail_kind: null, n: 50 },
        { action: 'failed', detail_kind: 'inactivity', n: 3 },
        { action: 'failed', detail_kind: 'prune', n: 1 },
        { action: 'failed', detail_kind: null, n: 99 },
        { action: 'name_banned', detail_kind: null, n: 7 },
    ], [{ kind: 'verify', n: 2 }, { kind: 'prune', n: 1 }, { kind: 'trial', n: 5 }]);
    assert.deepEqual(counts, { all: 74, verification: 15, prune: 6, inactivity: 53, failures: 7 });
    assert.deepEqual(countsFrom(), { all: 0, verification: 0, prune: 0, inactivity: 0, failures: 0 });
});

test('CSV: quoting, formula neutralising, header and rows', () => {
    assert.equal(csvCell(null), '');
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell('-cmd'), "'-cmd");
    assert.equal(csvCell('@sum'), "'@sum");
    const row = { ...normaliseEvent(ev(1, 1700000000, 'verify_kicked', { detail: 'still unverified after 3 days', dm_delivered: 1 })), user: { username: 'alice', displayName: 'Ally, A' } };
    const text = toCsv([row]);
    const lines = text.split('\r\n');
    assert.equal(lines[0], CSV_HEADER.join(','));
    assert.equal(lines[1], `2023-11-14 22:13:20,${U1},alice,"Ally, A",Verification,Kicked,still unverified after 3 days,delivered`);
    assert.equal(lines[2], '');
    assert.equal(toCsv([]), CSV_HEADER.join(',') + '\r\n');
});

test('answered inactivity warnings show when and where the member came back', async () => {
    const { markAnsweredWarnings } = await import('../core/verification-log-logic.js');
    const rows = [
        { action: 'prune_inactive_warned', sec: 1000, userId: 'a', pill: 'Warned', tone: 'warn', detail: 'no message for 90 days' },
        { action: 'prune_inactive_warned', sec: 1000, userId: 'b', pill: 'Warned', tone: 'warn', detail: 'x' },
        { action: 'prune_inactive_kicked', sec: 1000, userId: 'a', pill: 'Removed', tone: 'bad', detail: 'y' },
        { action: 'prune_inactive_warned', sec: 1000, userId: 'c', pill: 'Warned', tone: 'warn', detail: 'z' },
    ];
    markAnsweredWarnings(rows, new Map([
        ['a', { msgSec: 4000, msgChannelId: '10', messageId: '20', voiceSec: 2000, voiceChannelId: '30' }],
        ['b', { msgSec: 900 }],
        ['c', { msgSec: 1500, voiceSec: 5000, voiceChannelId: '31' }],
    ]));
    assert.equal(rows[0].pill, 'Back');
    assert.equal(rows[0].tone, 'ok');
    assert.deepEqual(rows[0].answer, { at: 4000000, kind: 'message', channelId: '10', messageId: '20' });
    assert.match(rows[0].detail, /cancelled: posted 1970-01-01 01:06 UTC/);
    assert.equal(rows[1].pill, 'Warned');
    assert.equal(rows[2].pill, 'Removed');
    assert.deepEqual(rows[3].answer, { at: 5000000, kind: 'voice', channelId: '31', messageId: null });
    assert.match(rows[3].detail, /joined voice/);
    // a bare time (activity recorded before channel ids were kept) still marks it, without a link
    const old = [{ action: 'prune_inactive_warned', sec: 1000, userId: 'd', detail: '' }];
    markAnsweredWarnings(old, new Map([['d', 3000]]));
    assert.equal(old[0].answer.channelId, null);
});
