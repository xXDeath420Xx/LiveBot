import './fixtures/test-log-dir.js';
/*
 * Google OAuth verification fixes (2026-11-21), on throwaway tables (needs the database; run on staging):
 *
 *   store      a YouTube viewer record never gains points (add, set higher, a gift to it, watch-time bulk), taking points
 *              away still works; linking keeps the points on the Twitch or Kick record and leaves a YouTube balance frozen
 *              where it is; an import brings YouTube viewers in with no points
 *   sweep      a `<table>__youtube` style sweep deletes only YouTube rows older than 30 days
 *   gate       the YouTube linking gate on a real table: closed until saved, reviewers, the switch, survives a new instance
 *
 * The parts without a database are in tests/youtube-no-rewards.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { viewersDdl } from '../migrations/464_stream_bot_viewers.js';
import { createViewerStore } from '../core/stream-bot/viewers/store.js';
import { sweepTable, resolvePolicy } from '../jobs/retention-sweeper.js';
import { createYouTubeGate, gateDdl, OWNER_DISCORD_ID } from '../core/stream-bot/youtube/gate.js';

const FAN = 'UCfAnOfMaPlE000000000001';
let T = null;
const extra = [];

test.before(async () => {
    T = await makeTables(pool, 'ynr');
    for (const sql of viewersDdl(T.prefix)) await pool.query(sql);
});
test.after(async () => {
    if (T) {
        for (const t of ['viewer_history', 'viewers']) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${t}\``).catch(() => {});
        await T.drop().catch(() => {});
    }
    for (const t of extra) await pool.query(`DROP TABLE IF EXISTS \`${t}\``).catch(() => {});
    await pool.end().catch(() => {});
});

test('store: a YouTube record never gains points; taking away works; transfers and the watch-time bulk skip it', async () => {
    const profile = await makeProfile(T.store);
    const vs = createViewerStore({ db: pool, prefix: T.prefix });
    const [yt] = await vs.seen(profile.id, 'youtube', [{ id: FAN, login: 'maplefan88', name: 'MapleFan88' }]);
    const [tw] = await vs.seen(profile.id, 'twitch', [{ id: '700000001', login: 'leaf', name: 'Leaf' }]);
    await pool.query(`UPDATE \`${T.prefix}viewers\` SET points = 40 WHERE id = ?`, [yt.row.id]);   // a balance from before the fix
    assert.deepEqual(await vs.changePoints(profile.id, yt.row.id, 50), { ok: false, error: 'youtube', balance: 40 });
    assert.deepEqual(await vs.changePoints(profile.id, yt.row.id, 100, { mode: 'set' }), { ok: false, error: 'youtube', balance: 40 });
    const down = await vs.changePoints(profile.id, yt.row.id, -15);
    assert.deepEqual([down.ok, down.balance], [true, 25], 'taking points away is allowed');
    assert.equal((await vs.changePoints(profile.id, tw.row.id, 500)).ok, true);
    assert.deepEqual(await vs.transfer(profile.id, tw.row.id, yt.row.id, 100), { ok: false, error: 'youtube' });
    assert.deepEqual(await vs.transfer(profile.id, yt.row.id, tw.row.id, 10), { ok: false, error: 'youtube' }, 'frozen: cannot be moved out either');
    await vs.addPointsBulk(profile.id, new Map([[yt.row.id, 10], [tw.row.id, 10]]));
    assert.equal((await vs.get(profile.id, yt.row.id)).points, 25, 'no watch-time points on YouTube');
    assert.equal((await vs.get(profile.id, tw.row.id)).points, 510);
});

test('store: linking keeps the points on the Twitch record, a YouTube balance stays frozen, and the YouTube row cannot route points', async () => {
    const profile = await makeProfile(T.store);
    const vs = createViewerStore({ db: pool, prefix: T.prefix });
    const [yt] = await vs.seen(profile.id, 'youtube', [{ id: FAN, login: 'maplefan88', name: 'MapleFan88' }]);
    const [tw] = await vs.seen(profile.id, 'twitch', [{ id: '700000002', login: 'maplefan88', name: 'MapleFan88' }]);
    await pool.query(`UPDATE \`${T.prefix}viewers\` SET points = 40 WHERE id = ?`, [yt.row.id]);
    await pool.query(`UPDATE \`${T.prefix}viewers\` SET points = 300 WHERE id = ?`, [tw.row.id]);
    const r = await vs.link(profile.id, yt.row.id, tw.row.id, { actor: 'test' });   // the YouTube record asked first
    assert.deepEqual([r.ok, r.primaryId, r.moved], [true, tw.row.id, 0], 'the Twitch record is the primary; nothing moved');
    const after = await vs.get(profile.id, yt.row.id);
    assert.deepEqual([after.personId, after.points], [tw.row.id, 40], 'the YouTube balance is left where it is (frozen)');
    assert.equal((await vs.get(profile.id, tw.row.id)).points, 300, 'no YouTube points reached the Twitch record');
    assert.deepEqual(await vs.changePoints(profile.id, yt.row.id, 5), { ok: false, error: 'youtube', balance: 300 }, 'nothing can be added through the YouTube record');
    assert.equal((await vs.changePoints(profile.id, tw.row.id, 5)).ok, true, 'the Twitch record still earns');
});

test('store: an import brings YouTube viewers in with no points (and Twitch with theirs)', async () => {
    const profile = await makeProfile(T.store);
    const vs = createViewerStore({ db: pool, prefix: T.prefix });
    await vs.importRows(profile.id, 'youtube', [{ id: 'UCiMpOrTeD00000000000001', login: 'imported', name: 'Imported', lastSeen: new Date(), minutes: 120, messages: 9, points: 5000 }], 'streamerbot');
    await vs.importRows(profile.id, 'twitch', [{ id: '700000099', login: 'imported_tw', name: 'Imported', lastSeen: new Date(), minutes: 60, messages: 3, points: 700 }], 'firebot');
    const y = await vs.byAccount(profile.id, 'youtube', 'UCiMpOrTeD00000000000001');
    assert.deepEqual([y.points, y.watchMinutes, y.messages], [0, 120, 9]);
    assert.equal((await vs.byAccount(profile.id, 'twitch', '700000099')).points, 700);
    await vs.importRows(profile.id, 'youtube', [{ id: 'UCiMpOrTeD00000000000001', points: 9000 }], 'streamerbot');
    assert.equal((await vs.byAccount(profile.id, 'youtube', 'UCiMpOrTeD00000000000001')).points, 0, 'importing again adds none either');
});

test('sweep: the YouTube condition deletes only YouTube rows past 30 days', async () => {
    const t = `${T.prefix}ev_sweep`;
    extra.push(t);
    await pool.query(`CREATE TABLE \`${t}\` (id INT AUTO_INCREMENT PRIMARY KEY, platform VARCHAR(16), created_at DATETIME(3) NOT NULL, KEY (created_at))`);
    await pool.query(`INSERT INTO \`${t}\` (platform, created_at) VALUES ('youtube', NOW() - INTERVAL 40 DAY), ('youtube', NOW() - INTERVAL 5 DAY), ('twitch', NOW() - INTERVAL 40 DAY), ('kick', NOW() - INTERVAL 31 DAY)`);
    const [[{ schema }]] = await pool.query('SELECT DATABASE() AS `schema`');
    const out = await sweepTable(schema, { table_name: t, timestamp_column: 'created_at', retain_days: 30, guard: resolvePolicy('stream_bot_events__youtube').guard });
    assert.equal(out.deleted, 1);
    const [rows] = await pool.query(`SELECT platform FROM \`${t}\` ORDER BY id`);
    assert.deepEqual(rows.map((r) => r.platform), ['youtube', 'twitch', 'kick'], 'the recent YouTube row and every Twitch and Kick row stay');
    const unknown = await sweepTable(schema, { table_name: 'stream_bot_events__kick', timestamp_column: 'created_at', retain_days: 30 });
    assert.equal(unknown.skipped, true, 'an unknown scoped row is skipped, never swept');
});

test('gate: on a real table, closed until saved, reviewers and the switch persist', async () => {
    const table = `${T.prefix}yt_gate`;
    extra.push(table);
    await pool.query(gateDdl(table));
    const g = createYouTubeGate({ db: pool, table, cacheMs: 0, ownerIds: [OWNER_DISCORD_ID] });
    assert.equal((await g.state()).stored, false);
    assert.equal(await g.allows('123456789012345678'), false);
    assert.equal((await g.addReviewer('123456789012345678', 'Google review account', OWNER_DISCORD_ID)).ok, true);
    const again = createYouTubeGate({ db: pool, table, cacheMs: 0, ownerIds: [OWNER_DISCORD_ID] });
    assert.equal(await again.allows('123456789012345678'), true, 'saved');
    assert.equal(await again.allows('876543210987654321'), false);
    await again.setOpen(true, OWNER_DISCORD_ID);
    assert.equal(await g.allows('876543210987654321'), true);
    const st = await g.state();
    assert.deepEqual([st.open, st.reviewers.length, st.updatedBy], [true, 1, OWNER_DISCORD_ID]);
});
