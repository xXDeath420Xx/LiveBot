// core/user-lookup.js: Discord user lookups for people who left (cache/TTL, dedupe, rate cap,
// 429 pause, fallback order) and the resolve route / cf-user.js wiring that uses them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createUserLookup, bitsFromUser, classifyLookupError, retryAfterMs, applyLookups, isNamed, LOOKUP_DEFAULTS } from '../core/user-lookup.js';
import { resolveMany } from '../core/user-display.js';

const ROOT = path.join(import.meta.dirname, '..');
const A = '111111111111111111';
const B = '222222222222222222';
const C = '333333333333333333';
const id = (i) => String(500000000000000000n + BigInt(i));
const HOUR = 3600 * 1000;

// A fake clock with manual timers: advance(ms) fires every due timer in time order.
function fakeTime() {
    let t = 1_000_000;
    let timers = [];
    const clock = {
        now: () => t,
        schedule: (fn, ms) => { timers.push({ at: t + Math.max(0, ms), fn }); },
        async advance(ms) {
            const end = t + ms;
            for (;;) {
                await flushMicro();
                timers.sort((x, y) => x.at - y.at);
                const next = timers[0];
                if (!next || next.at > end) break;
                timers = timers.slice(1);
                t = next.at;
                next.fn();
            }
            t = end;
            await flushMicro();
        },
    };
    return clock;
}
const flushMicro = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

const discordUser = (uid, username, globalName = null) => ({ id: uid, username, globalName, displayAvatarURL: () => `https://cdn/u/${uid}.png` });
const notFound = () => Object.assign(new Error('Unknown User'), { code: 10013, status: 404 });

function setup(over = {}, behaviour = (uid) => discordUser(uid, `user${uid.slice(-2)}`)) {
    const clock = fakeTime();
    const calls = [];
    const lk = createUserLookup({
        now: clock.now,
        schedule: clock.schedule,
        fetchUser: async (client, uid) => { calls.push({ uid, at: clock.now(), client }); return behaviour(uid, calls.length); },
        ...over,
    });
    return { clock, calls, lk };
}
const CLIENT = { name: 'guild-bot' };

test('bitsFromUser: global name as display name, small avatar, never in the server', () => {
    assert.deepEqual(bitsFromUser(discordUser(A, 'alice', 'Alice')), { id: A, username: 'alice', displayName: 'Alice', avatar: `https://cdn/u/${A}.png`, inServer: false });
    assert.equal(bitsFromUser(discordUser(B, 'bob')).displayName, 'bob');
    assert.equal(bitsFromUser({ id: C, username: 'c', displayAvatarURL() { throw new Error('x'); } }).avatar, null);
    assert.equal(bitsFromUser(null), null);
});

test('error classification and retry-after', () => {
    assert.equal(classifyLookupError(notFound()), 'unknown');
    assert.equal(classifyLookupError({ status: 404 }), 'unknown');
    assert.equal(classifyLookupError({ status: 429 }), 'ratelimit');
    assert.equal(classifyLookupError({ name: 'RateLimitError', timeToReset: 900 }), 'ratelimit');
    assert.equal(classifyLookupError(new Error('socket hang up')), 'error');
    assert.equal(retryAfterMs({ retryAfter: 1234 }), 1234);
    assert.equal(retryAfterMs({ rawError: { retry_after: 2.5 } }), 2500);
    assert.equal(retryAfterMs({}, 777), 777);
});

test('cache: a found user is kept ~24 h, then looked up again', async () => {
    const { clock, calls, lk } = setup();
    const p = lk.lookup(CLIENT, A);
    await clock.advance(1);
    assert.equal((await p).username, 'user11');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].client, CLIENT, 'uses the client it was handed (the guild\'s bot)');
    await clock.advance(LOOKUP_DEFAULTS.positiveTtlMs - 10);
    assert.equal(lk.peek(A).bits.username, 'user11');
    await lk.lookup(CLIENT, A);
    assert.equal(calls.length, 1, 'served from the cache');
    await clock.advance(20);
    assert.equal(lk.peek(A), null, 'expired');
    const again = lk.lookup(CLIENT, A);
    await clock.advance(1);
    await again;
    assert.equal(calls.length, 2);
});

test('cache: "unknown user" is kept ~1 h, other failures a minute', async () => {
    const { clock, calls, lk } = setup({}, (uid) => { if (uid === A) throw notFound(); throw new Error('ECONNRESET'); });
    const pa = lk.lookup(CLIENT, A);
    const pb = lk.lookup(CLIENT, B);
    await clock.advance(1000);
    assert.equal(await pa, null);
    assert.equal(await pb, null);
    assert.deepEqual(lk.peek(A), { bits: null });
    await clock.advance(LOOKUP_DEFAULTS.errorTtlMs);
    assert.equal(lk.peek(B), null, 'a transient failure is retried after a minute');
    assert.deepEqual(lk.peek(A), { bits: null });
    await clock.advance(LOOKUP_DEFAULTS.negativeTtlMs);
    assert.equal(lk.peek(A), null, 'unknown expires after an hour');
    assert.equal(calls.length, 2);
    assert.equal(lk.stats().unknown, 1);
    assert.equal(lk.stats().errors, 1);
});

test('LRU: the least recently used entry goes first', async () => {
    const { clock, lk } = setup({ maxEntries: 2, ratePerSec: 1000 });
    for (const x of [A, B]) lk.lookup(CLIENT, x);
    await clock.advance(10);
    lk.peek(A);                       // touch A: B is now the oldest
    lk.lookup(CLIENT, C);
    await clock.advance(10);
    assert.ok(lk.peek(A));
    assert.equal(lk.peek(B), null);
    assert.ok(lk.peek(C));
});

test('dedupe: concurrent lookups of one id make one Discord call', async () => {
    const { clock, calls, lk } = setup();
    const ps = [lk.lookup(CLIENT, A), lk.lookup(CLIENT, A), lk.lookup(CLIENT, A)];
    const r = lk.request(CLIENT, [A, A], { waitMs: 500 });
    await clock.advance(600);
    const got = await Promise.all(ps);
    assert.ok(got.every((b) => b.username === 'user11'));
    assert.deepEqual(Object.keys((await r).found), [A]);
    assert.equal(calls.length, 1);
});

test('rate cap: at most 5 lookups start per second, across every caller', async () => {
    const { clock, calls, lk } = setup();
    const ids = Array.from({ length: 12 }, (_, i) => id(i));
    lk.request(CLIENT, ids.slice(0, 6));
    lk.request({ name: 'other-bot' }, ids.slice(6));
    await clock.advance(999);
    assert.equal(calls.length, 5, 'one second: five');
    await clock.advance(1000);
    assert.equal(calls.length, 10);
    await clock.advance(1000);
    assert.equal(calls.length, 12);
    for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= 200, 'spaced 200 ms apart');
});

test('request: at most 50 new lookups per request; the rest come back pending with a retry hint', async () => {
    const { clock, calls, lk } = setup();
    const ids = Array.from({ length: 80 }, (_, i) => id(i));
    const r = await lk.request(CLIENT, ids, { max: 50 });
    assert.equal(Object.keys(r.found).length, 0);
    assert.equal(r.pending.length, 80, 'nothing finished yet: all pending');
    assert.ok(r.retryAfterMs >= 1500 && r.retryAfterMs <= 15000);
    assert.equal(lk.stats().queued + lk.stats().inFlight, 50, 'only 50 queued');
    await clock.advance(10_000);
    assert.equal(calls.length, 50);
    const r2 = lk.request(CLIENT, ids, { max: 50, waitMs: 2000 });
    await clock.advance(10_000);
    const done = await r2;
    const nFound = Object.keys(done.found).length;
    assert.ok(ids.slice(0, 50).every((x) => done.found[x]), 'the first 50 straight from the cache');
    assert.equal(nFound + done.pending.length, 80);
    assert.ok(done.pending.length >= 15 && done.pending.length <= 25, `about 10 of the next 30 finish within waitMs (pending ${done.pending.length})`);
    assert.equal(calls.length, 80);
});

test('request: waits at most waitMs, then reports what is still queued', async () => {
    const { clock, lk } = setup();
    const ids = Array.from({ length: 10 }, (_, i) => id(i));
    const r = lk.request(CLIENT, ids, { waitMs: 1000 });
    await clock.advance(1000);
    const out = await r;
    assert.equal(Object.keys(out.found).length + out.pending.length, 10);
    assert.ok(Object.keys(out.found).length >= 4 && out.pending.length >= 4, `split ${Object.keys(out.found).length}/${out.pending.length}`);
});

test('a full queue is not grown; no client means nothing is queued', async () => {
    const { lk } = setup({ maxQueue: 3 });
    const r = await lk.request(CLIENT, [id(1), id(2), id(3), id(4), id(5)]);
    assert.equal(lk.stats().queued + lk.stats().inFlight, 3);
    assert.equal(r.pending.length, 5);
    assert.equal(await lk.lookup(CLIENT, id(9)), undefined);
    const { lk: lk2 } = setup();
    assert.deepEqual((await lk2.request(null, [A])).pending, [A]);
    assert.equal(lk2.stats().queued, 0);
});

test('429: the queue pauses for retry-after, the id is retried first, nothing cached meanwhile', async () => {
    let limited = true;
    const { clock, calls, lk } = setup({}, (uid) => {
        if (uid === A && limited) { limited = false; throw Object.assign(new Error('429'), { status: 429, retryAfter: 3000 }); }
        return discordUser(uid, 'x' + uid.slice(-1));
    });
    const pa = lk.lookup(CLIENT, A);
    const pb = lk.lookup(CLIENT, B);
    await clock.advance(250);
    assert.equal(calls.length, 1, 'A hit a 429; B waits behind the pause');
    assert.equal(lk.peek(A), null, 'a 429 is not cached');
    assert.ok(lk.stats().pausedForMs > 2000);
    lk.lookup(CLIENT, C);
    await clock.advance(2000);
    assert.equal(calls.length, 1, 'paused: nothing starts');
    await clock.advance(1500);
    assert.deepEqual(calls.map((c) => c.uid), [A, A, B, C], 'the limited id goes first after the pause, then the rest at the capped rate');
    assert.equal((await pa).username, 'x1');
    assert.equal((await pb).username, 'x2');
    assert.equal(lk.stats().rateLimited, 1);
});

test('fallback order: member, then cached user, then Discord lookup, then the id', () => {
    const member = { user: { id: A, username: 'alice' }, displayName: 'Ally', displayAvatarURL: () => 'm.png' };
    const guild = {
        members: { cache: new Map([[A, member]]) },
        client: { users: { cache: new Map([[A, member.user], [B, { id: B, username: 'bob', displayAvatarURL: () => 'b.png' }]]) } },
    };
    const users = resolveMany(guild, [A, B, C, id(7)]);
    const found = {
        [A]: { id: A, username: 'alice-discord', displayName: 'Alice D', avatar: null, inServer: false },
        [B]: { id: B, username: 'bob-discord', displayName: 'Bob D', avatar: null, inServer: false },
        [C]: { id: C, username: 'carol', displayName: 'Carol', avatar: 'c.png', inServer: false },
    };
    applyLookups(users, found, { membersKnown: true });
    assert.equal(users[A].displayName, 'Ally', 'a member wins over a lookup');
    assert.equal(users[A].left, undefined);
    assert.equal(users[B].username, 'bob', 'the client cache wins over a lookup');
    assert.equal(users[B].left, true);
    assert.deepEqual(users[C], { id: C, username: 'carol', displayName: 'Carol', avatar: 'c.png', inServer: false, left: true });
    assert.equal(isNamed(users[id(7)]), false, 'nobody found: the id alone');
    assert.equal(users[id(7)].left, undefined, 'no "left" marker without a name');
    const unsure = applyLookups(resolveMany(guild, [C]), { [C]: found[C] }, { membersKnown: false });
    assert.equal(unsure[C].left, undefined, 'no "left" marker when the member fetch failed');
});

test('wiring: the resolve route uses the lookup and reports pending; cf-user.js re-polls and marks left', () => {
    const route = fs.readFileSync(path.join(ROOT, 'dashboard/routes/api/features/user-resolve.js'), 'utf8');
    assert.match(route, /userLookup\.request\(client, nameless, \{ max: LOOKUP_DEFAULTS\.perRequest/);
    assert.match(route, /guild\.client \|\|/, 'the guild\'s own bot client first');
    assert.match(route, /pending, retryAfterMs/);
    assert.doesNotMatch(route, /bot-resolver|\.rest\(/, 'no bot-resolver rest() internals');
    const js = fs.readFileSync(path.join(ROOT, 'dashboard/public/js/cf-user.js'), 'utf8');
    assert.match(js, /d\.pending/);
    assert.match(js, /retryAfterMs/);
    assert.match(js, /MAX_TRIES/);
    assert.match(js, /cf-user-left/);
    assert.doesNotMatch(js, /\.innerHTML\s*=/);
    const css = fs.readFileSync(path.join(ROOT, 'dashboard/public/css/cf-user.css'), 'utf8');
    assert.match(css, /\.cf-user-left\s*\{/);
});
