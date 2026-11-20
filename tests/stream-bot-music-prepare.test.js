import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMusicService } from '../core/stream-bot/music/service.js';

/*
 * H-758: the music player's music.prepare wait (core/stream-bot/music/service.js prepare) wakes on the realtime hub's
 * onAck instead of reading the dispatch row every 200 ms. The row still decides, so the answers are the ones the
 * polling gave: acked with vodSafe → ok + vodTrack; acked without it → not confirmed; failed / expired → the device's
 * reason without "vod_unsafe:"; nothing connected → not connected. A hub without onAck still polls.
 * In-memory dispatch rows and a fake hub; no database, no sockets.
 */

function rig({ withOnAck = true } = {}) {
    const rows = new Map();
    const watchers = new Map();
    let sleeps = 0;
    let n = 0;
    const store = { getDispatch: async (id) => rows.get(id) || null };
    const hub = {
        online: true,
        async dispatch() {
            if (!hub.online) return { id: null, status: 'none', devices: 0 };
            const id = `d_${++n}`;
            rows.set(id, { id, status: 'sent', result: null, error: null });
            return { id, status: 'sent', devices: 1 };
        },
        /** What realtime.js does on an ack: write the row, then tell the watchers. */
        answer(id, fields, { notify = true } = {}) {
            rows.set(id, { ...rows.get(id), ...fields });
            if (!notify) return;
            const set = watchers.get(id);
            watchers.delete(id);
            for (const fn of set || []) fn({ id, ...fields });
        },
        poke(id) { for (const fn of watchers.get(id) || []) fn({ id, status: 'sent' }); },
    };
    if (withOnAck) {
        hub.onAck = (id, fn) => {
            if (!watchers.has(id)) watchers.set(id, new Set());
            watchers.get(id).add(fn);
            return () => watchers.get(id)?.delete(fn);
        };
    }
    const service = createMusicService({ store, hub, sleep: (ms) => { sleeps++; return new Promise((r) => setTimeout(r, Math.min(ms, 5))); } });
    return { service, hub, rows, watchers, sleeps: () => sleeps, lastId: () => `d_${n}` };
}

test('an ack wakes the wait at once; no polling', async () => {
    const r = rig();
    const t0 = Date.now();
    const p = r.service.prepare(1);
    setTimeout(() => r.hub.answer(r.lastId(), { status: 'acked', result: { vodSafe: true, vodTrack: 2 } }), 30);
    assert.deepEqual(await p, { ok: true, vodTrack: 2 });
    assert.equal(r.sleeps(), 0, 'never slept in 200 ms steps');
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(r.watchers.get(r.lastId())?.size || 0, 0, 'the watcher is gone');
});

test('the same answers as the polling gave', async () => {
    const r = rig();
    let p = r.service.prepare(1);
    setTimeout(() => r.hub.answer(r.lastId(), { status: 'acked', result: { vodSafe: false } }), 5);
    assert.deepEqual(await p, { ok: false, reason: 'Studio did not confirm VOD protection.' });
    p = r.service.prepare(1);
    setTimeout(() => r.hub.answer(r.lastId(), { status: 'failed', error: 'vod_unsafe: Desktop Audio is on track 2' }), 5);
    assert.deepEqual(await p, { ok: false, reason: 'Desktop Audio is on track 2' });
    p = r.service.prepare(1);
    setTimeout(() => r.hub.answer(r.lastId(), { status: 'expired', error: null }), 5);
    assert.deepEqual(await p, { ok: false, reason: 'Studio could not confirm VOD protection.' });
    r.hub.online = false;
    assert.deepEqual(await r.service.prepare(1), { ok: false, reason: 'CertiFried Studio is not connected.' });
});

test('an answer written before the wait starts, or a wake without an answer, still ends right', async () => {
    const r = rig();
    const orig = r.hub.dispatch;
    r.hub.dispatch = async (d) => { const x = await orig(d); r.hub.answer(x.id, { status: 'acked', result: { vodSafe: true, vodTrack: null } }, { notify: false }); return x; };
    assert.deepEqual(await r.service.prepare(1), { ok: true, vodTrack: null }, 'read once right after registering');
    r.hub.dispatch = orig;
    const p = r.service.prepare(1);
    setTimeout(() => r.hub.poke(r.lastId()), 5);
    setTimeout(() => r.hub.answer(r.lastId(), { status: 'acked', result: { vodSafe: true, vodTrack: 3 } }), 30);
    assert.deepEqual(await p, { ok: true, vodTrack: 3 });
});

test('H-774: the player SSE route uses openSse, keeps stripping the key, and every music event name passes its filter', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { openSse } = await import('../core/stream-bot/overlays/http.js');
    const { EventEmitter } = await import('node:events');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const route = fs.readFileSync(path.join(root, 'dashboard/routes/stream-bot-music.js'), 'utf8');
    const body = route.slice(route.indexOf("'/stream/bot/overlay/music/:key/events'"), route.indexOf("'/stream/bot/overlay/music/:key/report'"));
    assert.ok(body.includes('openSse(req, res, { pingMs: 20_000, retryMs: 3_000'), 'same ping and retry as before');
    assert.ok(body.includes('{ ...data, key: undefined }'), 'the key never goes out in a frame');
    assert.ok(!body.includes('res.write('), 'no hand-written SSE left');
    const player = fs.readFileSync(path.join(root, 'core/stream-bot/music/player.js'), 'utf8');
    const names = new Set([...player.matchAll(/(?:broadcast\([^,()]+(?:\([^()]*\))?, |\.send\()'([a-z_]+)'/g)].map((m) => m[1]));
    for (const n of ['hello', 'play', 'pause', 'resume', 'seek', 'volume', 'card', 'idle', 'stop']) assert.ok(names.has(n), `player sends ${n}`);
    // Each name goes out under its own name (openSse turns anything else into "message").
    const req = new EventEmitter();
    const out = [];
    const res = { writeHead: (code, h) => out.push({ code, h }), write: (s) => { out.push(s); return true; }, end: () => {} };
    const sse = openSse(req, res, { pingMs: 20_000, retryMs: 3_000 });
    for (const n of names) sse.send(n, { key: undefined, a: 1 });
    sse.close();
    assert.equal(out[0].h['X-Accel-Buffering'], 'no');
    assert.equal(out[1], 'retry: 3000\n\n');
    for (const n of names) assert.ok(out.includes(`event: ${n}\ndata: {"a":1}\n\n`), n);
});

test('a hub without onAck polls as before', async () => {
    const r = rig({ withOnAck: false });
    const p = r.service.prepare(1);
    setTimeout(() => r.hub.answer(r.lastId(), { status: 'acked', result: { vodSafe: true, vodTrack: 2 } }, { notify: false }), 30);
    assert.deepEqual(await p, { ok: true, vodTrack: 2 });
    assert.ok(r.sleeps() >= 1, 'it slept between reads');
});
