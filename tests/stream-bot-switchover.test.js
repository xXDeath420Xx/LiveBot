import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { importDdl, IMPORT_TABLES } from '../migrations/455_stream_bot_imports.js';
import { switchoverDdl, SWITCHOVER_TABLES, up as up466 } from '../migrations/466_stream_bot_switchover.js';
import { createImportStore, automationHash } from '../core/stream-bot/import/apply.js';
import { importExport } from '../core/stream-bot/import/privacy.js';
import { buildPlan, attentionFor, obsPairs, obsChanges, createSwitchover, isSongRequest } from '../core/stream-bot/switchover.js';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import * as demo from '../scripts/site-shots/demo-data.mjs';

/*
 * The one-click switchover from Firebot / Streamer.bot (core/stream-bot/switchover.js, migration 466, the route and page).
 * Pure: what the plan turns on, leaves alone (already on, changed after the import) and holds back (needs a look), the
 * OBS swaps from what Studio reports (Sound Alerts and Blerp never). On throwaway tables (sbtw…_ plus copies of the channel
 * bot tables) with a fake hub standing in for CertiFried Studio: apply turns things on and swaps OBS, stores the previous
 * state, and Undo restores it exactly; Studio offline leaves OBS alone; closing apps only when ticked. The migration does
 * nothing without stream_bot_profiles. The page in Dark, Light and Sand. Nothing reaches a real Studio, OBS, Twitch or Kick.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const A = (id, name, actions, extra = {}) => ({ id, name, enabled: false, trigger_type: 'chat', trigger_config: {}, conditions: [], actions, ...extra });
const SCENES = { scenes: {
    'IN-GAME': [
        { source: 'StreamLabs', enabled: true }, { source: 'CertiFried Alerts', enabled: false, certifried: { overlayId: 2, replaces: 'StreamLabs' } },
        { source: 'songs', enabled: false }, { source: 'CertiFried Now Playing', enabled: false, certifried: { overlayId: 4, replaces: 'songs' } },
        { source: 'Sound Alerts', enabled: true }, { source: 'CertiFried Bits', enabled: false, certifried: { overlayId: 9, replaces: 'Sound Alerts' } },
        { source: 'Webcam', enabled: true },
    ],
    BRB: [{ source: 'BrB', enabled: true }, { source: 'CertiFried Scene - Be right back', enabled: true, certifried: { overlayId: 6, replaces: 'BrB' } }],
    Empty: null,
} };

test('the plan: turned on, already on, changed after the import, needs a look, song requests from the Music page', () => {
    const goLive = A(1, 'Streamer.bot: Go Live', [{ type: 'obs.stream', state: 'stop' }], { trigger_type: 'voice.phrase' });
    const dab = A(2, 'Firebot: !dab+', [{ type: 'chat.send', text: 'dab' }, { type: 'random', branches: [{ actions: [{ type: 'overlay.media', media: 'dab gif' }] }] }]);
    const died = A(3, 'Firebot: !died', [{ type: 'chat.send', text: 'RIP' }]);
    const edited = A(4, 'Firebot: !reset', [{ type: 'chat.send', text: 'changed by hand' }]);
    const on = A(5, 'Firebot: Follow', [{ type: 'chat.send', text: 'thanks' }], { enabled: true });
    const music = A(6, 'Song requests: !sr', [{ type: 'music.command', command: 'sr' }]);
    const scene = A(7, 'Streamer.bot: Kill Counters', [{ type: 'obs.source', scene: 'IN-GAME', source: 'Counters', visible: 'hide' }]);
    const items = [
        { target_kind: 'automation', target_ref: 'automation:1', source: 'streamerbot', kind: 'speech', source_id: 's1', data: { hash: automationHash(goLive) } },
        { target_kind: 'automation', target_ref: 'automation:2', source: 'firebot', kind: 'command', source_id: 'c2', data: { hash: automationHash(dab) } },
        { target_kind: 'automation', target_ref: 'automation:3', source: 'firebot', kind: 'command', source_id: 'c3', data: { hash: automationHash(died) } },
        { target_kind: 'automation', target_ref: 'automation:4', source: 'firebot', kind: 'command', source_id: 'c4', data: { hash: 'something-else' } },
        { target_kind: 'automation', target_ref: 'automation:5', source: 'firebot', kind: 'event', source_id: 'e5', data: { hash: automationHash(on) } },
        { target_kind: 'automation', target_ref: 'automation:7', source: 'streamerbot', kind: 'speech', source_id: 's7', data: { hash: automationHash(scene) } },
        { target_kind: 'automation', target_ref: 'automation:99', source: 'firebot', kind: 'command', source_id: 'gone', data: {} },
        { target_kind: 'channel_command', target_ref: 'cc:10,cc:11', source: 'firebot', kind: 'command', source_id: 'cc' },
        { target_kind: 'bot_timer', target_ref: 'timer:20', source: 'firebot', kind: 'timer', source_id: 't' },
    ];
    const notes = new Map([['streamerbot|speech|s1', ['Streamer.bot had this set to Stop streaming; check that is what you want before turning it on']]]);
    const commands = new Map([[10, { id: 10, command_name: 'discord', is_enabled: 0, updated_at: null, platform: 'kick' }], [11, { id: 11, command_name: 'socials', is_enabled: 0, updated_at: new Date(), platform: 'twitch' }]]);
    const timers = new Map([[20, { id: 20, name: 'Thoughts', is_enabled: 0 }]]);
    const obs = { known: true, scenes: new Set(['IN-GAME', 'BRB']), sources: new Set(['StreamLabs', 'Webcam']), inputs: new Set() };
    const plan = buildPlan({ automations: [goLive, dab, died, edited, on, music, scene], importItems: items, notes, commands, timers, mediaNames: new Set(), soundNames: new Set(), obs, sceneItems: SCENES, studio: { connected: true, apps: true } });
    const st = Object.fromEntries(plan.automations.map((a) => [a.id, a.state]));
    assert.deepEqual(st, { 1: 'attention', 2: 'attention', 3: 'turn_on', 4: 'edited', 5: 'already_on', 7: 'attention', 6: 'turn_on' });
    const reasons = (id) => plan.automations.find((a) => a.id === id).reasons;
    assert.ok(reasons(1).some((r) => /Stop streaming/.test(r)) && reasons(1).includes('It stops your stream.'));
    assert.deepEqual(reasons(2), ['It shows "dab gif", which is not in your overlay media.'], 'steps inside random choices are checked');
    assert.deepEqual(reasons(7), ['OBS has no source called "Counters".']);
    assert.equal(plan.automations.find((a) => a.id === 6).source, 'music', 'song requests made on the Music page are included');
    assert.deepEqual(plan.commands.map((c) => [c.id, c.state]), [[10, 'turn_on'], [11, 'edited']]);
    const again = buildPlan({ automations: [], importItems: items, commands, touched: { commands: new Set([11]) } });
    assert.equal(again.commands.find((c) => c.id === 11).state, 'turn_on', 'only a switchover changed it, so it is not "changed by you"');
    assert.deepEqual(plan.timers.map((t) => [t.id, t.state]), [[20, 'turn_on']]);
    assert.equal(plan.counts.songs, 1);
    assert.equal(plan.apps.canClose, true);
    assert.ok(isSongRequest(music) && !isSongRequest(dab));
    assert.deepEqual(attentionFor(A(8, 'x', [{ type: 'overlay.media', media: '{args}' }, { type: 'sound.play', sound: 'https://x.example/a.mp3' }]), { mediaNames: new Set(), soundNames: new Set() }), [], 'templates, links and files are not judged');
});

test('OBS: show the CertiFried source where the old one shows and hide the old; hidden pairs stay hidden; Sound Alerts and Blerp never', () => {
    const { pairs, kept } = obsPairs(SCENES);
    assert.deepEqual(pairs.map((p) => [p.scene, p.newSource, p.oldSource, p.change]), [
        ['IN-GAME', 'CertiFried Alerts', 'StreamLabs', 'swap'], ['IN-GAME', 'CertiFried Now Playing', 'songs', 'none'], ['BRB', 'CertiFried Scene - Be right back', 'BrB', 'hide_old'],
    ]);
    assert.deepEqual(kept, ['Sound Alerts']);
    assert.deepEqual(obsChanges({ obs: { pairs } }), [
        { scene: 'IN-GAME', source: 'CertiFried Alerts', enabled: true }, { scene: 'IN-GAME', source: 'StreamLabs', enabled: false }, { scene: 'BRB', source: 'BrB', enabled: false },
    ]);
    assert.equal(obsChanges({ obs: { pairs } }).some((c) => /sound alerts|blerp/i.test(c.source)), false);
    assert.equal(buildPlan({ studio: { connected: false } }).obs.reason, 'studio_offline');
    assert.equal(buildPlan({ studio: { connected: true } }).obs.reason, 'studio_no_answer');
});

// ── on throwaway tables with a fake Studio ──────────────────────────────────────────────────

let T, importStore, ch, profile;
test.before(async () => {
    T = await makeTables(pool, 'w');
    for (const sql of importDdl(T.prefix)) await pool.query(sql);
    for (const sql of switchoverDdl(T.prefix)) await pool.query(sql);
    ch = { channels: `${T.prefix}tc`, commands: `${T.prefix}tcc`, timers: `${T.prefix}ttm` };
    await pool.query(`CREATE TABLE \`${ch.channels}\` LIKE tokes_channels`);
    await pool.query(`CREATE TABLE \`${ch.commands}\` LIKE tokes_custom_commands`);
    await pool.query(`CREATE TABLE \`${ch.timers}\` LIKE tokes_timers`);
    importStore = createImportStore({ db: pool, prefix: T.prefix, channelTables: ch });
    profile = await makeProfile(T.store);
});
test.after(async () => {
    for (const t of [ch.channels, ch.commands, ch.timers]) await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    for (const t of [...SWITCHOVER_TABLES, ...[...IMPORT_TABLES].reverse()]) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${t}\``);
    await T.drop();
    await pool.end();
});

function fakeHub({ connected = true, apps = true, scenes = SCENES, failObs = false } = {}) {
    const sent = [];
    const notified = [];
    const obs = JSON.parse(JSON.stringify(scenes));
    let seq = 0;
    const answers = new Map();
    return {
        sent, notified, obs,
        connected: () => (connected ? [{ kind: 'studio', capabilities: apps ? ['obs', 'apps'] : ['obs'], client: { version: '0.2.7' } }] : []),
        notify: (pid, kind, msg) => notified.push(msg.type),
        async dispatch(d) {
            sent.push({ actionType: d.actionType, params: d.params, capability: d.capability });
            if (!connected) return { id: 'none', status: 'none', devices: 0 };
            const id = `d_${++seq}`;
            let result = {};
            if (d.actionType === 'obs.scene_items') result = obs;
            if (d.actionType === 'obs.set_scene_items') {
                result = { changes: d.params.changes.map((c) => {
                    const it = (obs.scenes[c.scene] || []).find((x) => x.source === c.source);
                    if (!it) return { ...c, ok: false, error: 'source_not_found' };
                    const previous = it.enabled; it.enabled = c.enabled;
                    return { ...c, ok: true, previous, changed: previous !== c.enabled };
                }) };
            }
            if (d.actionType === 'studio.close_apps') result = { apps: [{ app: 'firebot', closed: true, stillRunning: false }, { app: 'streamerbot', closed: false, stillRunning: true }] };
            answers.set(id, failObs && d.actionType === 'obs.set_scene_items' ? { status: 'failed', result: null, error: 'obs_live' } : { status: 'acked', result, error: null });
            return { id, status: 'sent', devices: 1 };
        },
        onAck(id, fn) { setImmediate(() => fn(answers.get(id))); return () => {}; },
    };
}

async function seed() {
    const mk = async (name, actions) => T.store.createAutomation(profile.id, { name, enabled: false, trigger_type: 'chat', trigger_config: {}, conditions: [], actions });
    const okId = await mk('Firebot: !died', [{ type: 'chat.send', text: 'RIP' }]);
    const attnId = await mk('Streamer.bot: Go Live', [{ type: 'obs.stream', state: 'stop' }]);
    const songId = await mk('Song requests: !sr', [{ type: 'music.command', command: 'sr' }]);
    const okA = await T.store.getAutomation(profile.id, okId);
    const attnA = await T.store.getAutomation(profile.id, attnId);
    await importStore.upsertItem(profile.id, { importId: null, source: 'firebot', kind: 'command', sourceId: 'died', name: '!died', status: 'changed', targetKind: 'automation', targetRef: `automation:${okId}`, data: { hash: automationHash(okA) } });
    await importStore.upsertItem(profile.id, { importId: null, source: 'streamerbot', kind: 'speech', sourceId: 'golive', name: 'Go Live', status: 'changed', targetKind: 'automation', targetRef: `automation:${attnId}`, data: { hash: automationHash(attnA) } });
    const [chRow] = await pool.query(`INSERT INTO \`${ch.channels}\` (owner_id, connection_id, platform, channel_id, channel_name) VALUES (1, 1, 'kick', '800000001', 'maplehollow')`);
    const ccId = await importStore.insertChannelCommand({ channelId: chRow.insertId, name: 'discord', response: 'join us', cooldown: 5, modOnly: false, broadcasterOnly: false, createdBy: 'Imported from Firebot' });
    await importStore.upsertItem(profile.id, { importId: null, source: 'firebot', kind: 'command', sourceId: 'discord', name: '!discord', status: 'as_is', targetKind: 'channel_command', targetRef: `cc:${ccId}` });
    const tmId = await importStore.insertBotTimer(profile.id, { name: 'Thoughts', message: 'Thinking out loud', extraMessages: [], rotation: 'rotate', intervalMin: 10, onlyLive: true, minChatLines: 5, automationId: null, platforms: 'all' }, 'Imported from Firebot');
    await importStore.upsertItem(profile.id, { importId: null, source: 'firebot', kind: 'timer', sourceId: 'thoughts', name: 'Thoughts', status: 'changed', targetKind: 'bot_timer', targetRef: `timer:${tmId}` });
    return { okId, attnId, songId, ccId, tmId };
}
const enabled = async (id) => (await T.store.getAutomation(profile.id, id)).enabled;
const flag = async (table, id) => Number((await pool.query(`SELECT is_enabled FROM \`${table}\` WHERE id = ?`, [id]))[0][0].is_enabled);

test('apply turns on what is safe, swaps OBS through Studio, stores the previous state; Undo puts every bit back', async () => {
    const ids = await seed();
    const hub = fakeHub();
    const sw = createSwitchover({ db: pool, store: T.store, importStore, hub, prefix: T.prefix, channelTables: ch, ackWaitMs: 2000 });
    const plan = await sw.preview(profile.id);
    assert.equal(plan.automations.find((a) => a.id === ids.attnId).state, 'attention');
    assert.equal(plan.obs.available, true);
    assert.equal(hub.sent.filter((s) => s.actionType === 'obs.scene_items').length, 1, 'the preview asks Studio about OBS');

    const r = await sw.apply(profile.id, { include: [], obs: true, closeApps: false });
    assert.equal(r.status, 'applied');
    assert.deepEqual([await enabled(ids.okId), await enabled(ids.attnId), await enabled(ids.songId)], [true, false, true], 'the Go Live item stays off');
    assert.equal(await flag(ch.commands, ids.ccId), 1);
    assert.equal(await flag(ch.timers, ids.tmId), 1);
    assert.ok(hub.notified.includes('automations_changed'), 'Studio refreshes its automations (VOD-safe music for song requests)');
    const set = hub.sent.find((s) => s.actionType === 'obs.set_scene_items');
    assert.deepEqual(set.params.changes.map((c) => `${c.scene}/${c.source}=${c.enabled}`), ['IN-GAME/CertiFried Alerts=true', 'IN-GAME/StreamLabs=false', 'BRB/BrB=false']);
    assert.equal(hub.obs.scenes['IN-GAME'].find((x) => x.source === 'Sound Alerts').enabled, true, 'Sound Alerts untouched');
    assert.ok(!hub.sent.some((s) => s.actionType === 'studio.close_apps'), 'apps are only closed when ticked');

    const u = await sw.undo(profile.id);
    assert.equal(u.ok, true);
    assert.deepEqual([await enabled(ids.okId), await enabled(ids.attnId), await enabled(ids.songId)], [false, false, false]);
    assert.equal(await flag(ch.commands, ids.ccId), 0);
    assert.equal(await flag(ch.timers, ids.tmId), 0);
    const obsNow = Object.fromEntries(Object.entries(hub.obs.scenes).filter(([, l]) => l).flatMap(([s, l]) => l.map((x) => [`${s}/${x.source}`, x.enabled])));
    const before = Object.fromEntries(Object.entries(SCENES.scenes).filter(([, l]) => l).flatMap(([s, l]) => l.map((x) => [`${s}/${x.source}`, x.enabled])));
    assert.deepEqual(obsNow, before, 'OBS exactly as before');
    assert.equal((await sw.undo(profile.id)).ok, false, 'nothing left to undo');
    const hist = await sw.history(profile.id);
    assert.equal(hist[0].status, 'undone');
    const exp = await importExport(pool, profile.id, T.prefix);
    assert.ok(exp.switchovers?.length >= 1, '/privacy export lists switchovers');

    // Ticked "needs a look" item and closing the apps.
    const mark = hub.sent.length;
    const r2 = await sw.apply(profile.id, { include: [`a:${ids.attnId}`], obs: false, closeApps: true });
    assert.equal(await enabled(ids.attnId), true, 'turned on because it was ticked');
    const close = hub.sent.find((s) => s.actionType === 'studio.close_apps');
    assert.deepEqual([close.capability, close.params.apps], ['apps', ['firebot', 'streamerbot']]);
    assert.deepEqual(r2.result.apps.apps.map((a) => a.stillRunning), [false, true]);
    assert.ok(!hub.sent.slice(mark).some((s) => s.actionType === 'obs.set_scene_items'), 'OBS left alone when unticked');
    await sw.undo(profile.id);
    assert.equal(await enabled(ids.attnId), false);
});

test('Studio offline or OBS refusing: the database part still happens, OBS is left alone and the switchover says so', async () => {
    const hub = fakeHub({ connected: false });
    const sw = createSwitchover({ db: pool, store: T.store, importStore, hub, prefix: T.prefix, channelTables: ch, ackWaitMs: 500 });
    const plan = await sw.preview(profile.id);
    assert.equal(plan.obs.available, false);
    const r = await sw.apply(profile.id, { closeApps: false });
    assert.equal(r.status, 'applied');
    assert.ok(!hub.sent.some((s) => s.actionType === 'obs.set_scene_items'));
    await sw.undo(profile.id);
    const refusing = fakeHub({ failObs: true });
    const sw2 = createSwitchover({ db: pool, store: T.store, importStore, hub: refusing, prefix: T.prefix, channelTables: ch, ackWaitMs: 500 });
    const r2 = await sw2.apply(profile.id, {});
    assert.equal(r2.status, 'partial');
    assert.equal(r2.result.obs.status, 'failed');
    assert.ok((await sw2.undo(profile.id)).ok, 'undo of the database part works, no OBS changes to put back');
});

test('migration 466 creates nothing without stream_bot_profiles, and its DDL hangs off the profile', async () => {
    const calls = [];
    await up466({ query: async (sql, params) => { calls.push(sql); return [[]]; } });
    assert.equal(calls.length, 1, 'only the existence check ran');
    assert.match(switchoverDdl('x_')[0], /FOREIGN KEY \(profile_id\) REFERENCES `x_profiles` \(id\) ON DELETE CASCADE/);
});

test('the page in Dark, Light and Sand; scripts build no markup from strings; routes need a session; server.js mounts it', async () => {
    const views = path.join(root, 'dashboard/views');
    const engine = createViewEngine({ viewsDir: views, publicDir: path.join(root, 'dashboard/public'), cache: false });
    const locals = (theme, extra = {}) => ({ user: demo.user, uiTheme: theme, uiStyle: 'cards', uiDensity: 'comfortable', csrfToken: 't', clientId: demo.BOT_ID,
        userPrefs: { pinnedPages: [], recentPages: [], siteStyle: 'cards', theme, dashboardLayout: 'grid', density: 'comfortable' }, settings: {}, _locals: {},
        active: 'import', profile: { id: 7 }, studio: { connected: true, version: '0.2.7', canClose: true }, canUndo: true,
        history: [{ id: 1, status: 'applied', createdAt: '2026-11-19T20:00:00.000Z', undoneAt: null, automations: 52, commands: 18, timers: 5, obs: 9, apps: [{ app: 'firebot', closed: true, stillRunning: false }] }], ...extra });
    for (const theme of ['dark', 'light', 'sand']) {
        const html = await engine.renderFile(path.join(views, 'stream-bot/switchover.ejs'), locals(theme));
        assert.match(html, new RegExp(`<html data-theme="${theme}"`));
        assert.equal((html.match(/<h1\b/g) || []).length, 1);
        assert.match(html, /href="\/stream\/bot\/import" aria-current="page">Import</);
        const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
        assert.deepEqual(ids.filter((x, i) => ids.indexOf(x) !== i), []);
        for (const m of html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)) assert.ok(ids.includes(m[1]), `label for ${m[1]}`);
        assert.match(html, /52 automations, 18 commands and 5 timers turned on; 9 OBS changes; Firebot closed/);
    }
    const off = await engine.renderFile(path.join(views, 'stream-bot/switchover.ejs'), locals('dark', { studio: { connected: false, canClose: false }, history: [], canUndo: false }));
    assert.match(off, /id="sbs-close" disabled/);
    assert.match(off, /CertiFried Studio is not connected/);
    assert.match(off, /id="sbs-undo" disabled/);
    const js = read('dashboard/public/js/stream-bot-switchover.js');
    assert.doesNotMatch(js, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write\(/);
    const src = read('dashboard/routes/stream-bot-switchover.js');
    for (const m of src.matchAll(/router\.(get|post)\('([^']+)',\s*([^\n]*)/g)) assert.match(m[3], m[2].startsWith('/stream/bot/api/') ? /^needApi\b/ : /^needPage\b/, m[2]);
    const server = read('dashboard/server.js');
    assert.match(server, /import\('\.\/routes\/stream-bot-switchover\.js'\)/);
    assert.match(read('dashboard/views/stream-bot/import.ejs'), /href="\/stream\/bot\/import\/switchover"/, 'the Import page links to it');
});

test('import notes: the newest report that lists an item wins, also with no notes left (a re-import clears an old hold)', async () => {
    const auto = { id: 14, name: 'Streamer.bot: Go Live', enabled: false, trigger_type: 'voice.phrase', trigger_config: { phrases: ['Go Live On Stream Right Now'] }, conditions: [],
        actions: [{ type: 'chat.send', platform: 'twitch', text: '!reset' }, { type: 'chat.clear' }, { type: 'obs.stream', state: 'start' }, { type: 'obs.scene', scene: 'START' }] };
    const other = { id: 15, name: 'Streamer.bot: Other', enabled: false, trigger_type: 'chat.command', trigger_config: {}, conditions: [], actions: [{ type: 'obs.scene', scene: 'X' }] };
    const item = (a, sourceId) => ({ id: a.id, source: 'streamerbot', kind: 'speech', source_id: sourceId, target_kind: 'automation', target_ref: `automation:${a.id}`, data: { hash: automationHash(a) } });
    const view = (sourceId, why) => ({ source: 'streamerbot', kind: 'speech', sourceId, why });
    const reports = {
        1: { groups: { changed: [view('go', ['Streamer.bot had this set to Stop streaming; check that is what you want before turning it on']), view('other', ['check it before you turn it on'])] } },
        2: { groups: { as_is: [view('go', [])] } },   // the re-import: Go Live has no notes now; "other" is not in it
    };
    const importStore = { listImports: async () => [{ id: 2 }, { id: 1 }], getImport: async (_p, id) => ({ id, report: reports[id] }), listItems: async () => [item(auto, 'go'), item(other, 'other')] };
    const store = { listAutomations: async () => [auto, other], listChannels: async () => [], getSettingsKey: async () => null };
    const db = { query: async () => [[]] };
    const sw = createSwitchover({ db, store, importStore, prefix: 'sbtw_notes_' });
    const plan = await sw.preview(2, { sceneItems: null });
    const row = (id) => plan.automations.find((a) => a.id === id);
    assert.equal(row(14).state, 'turn_on', JSON.stringify(row(14).reasons));
    assert.equal(row(15).state, 'attention', 'an item the newer report does not list keeps its older note');
});

test('"add a role condition" (Firebot !clear for anyone) stops holding once a Moderator or Broadcaster role condition is there', () => {
    const note = ['Anyone in chat could run this in Firebot, and here it really clears your Twitch chat: check it before turning it on (add a role condition)'];
    const clear = (conditions) => ({ conditions, actions: [{ type: 'chat.clear' }] });
    assert.equal(attentionFor(clear([]), { notes: note }).length, 1);
    assert.deepEqual(attentionFor(clear([{ type: 'role', roles: ['moderator', 'broadcaster'], mode: 'any' }]), { notes: note }), []);
    assert.equal(attentionFor(clear([{ type: 'role', roles: ['everyone'], mode: 'any' }]), { notes: note }).length, 1, 'everyone is no limit');
    assert.equal(attentionFor(clear([{ type: 'role', roles: ['moderator'], mode: 'none' }]), { notes: note }).length, 1, '"not a moderator" is no limit');
    // Other notes still hold it.
    assert.equal(attentionFor(clear([{ type: 'role', roles: ['moderator'], mode: 'any' }]), { notes: [...note, 'Streamer.bot had this set to Stop streaming; check that is what you want before turning it on'] }).length, 1);
});
