import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { importDdl, IMPORT_TABLES } from '../migrations/455_stream_bot_imports.js';
import { switchoverDdl, SWITCHOVER_TABLES } from '../migrations/466_stream_bot_switchover.js';
import { createImportStore, automationHash } from '../core/stream-bot/import/apply.js';
import { buildPlan, createSwitchover, replacementFor, suggestThreshold, unknownObsSources, VOICE_NOT_LISTENING } from '../core/stream-bot/switchover.js';
import { sanitiseState } from '../core/stream-bot/studio.js';
import { parseStreamerbot } from '../core/stream-bot/import/streamerbot.js';
import { buildPlan as importPlan } from '../core/stream-bot/import/mapper.js';
import { reportOf } from '../core/stream-bot/import/report.js';
import { streamerbotFiles } from './fixtures/stream-bot-import.js';

/*
 * The switchover's voice, chat commands, steps and held-item fixes (2026-11-20, studio-gap-audit items 2 to 6): the plan (pure),
 * apply and Undo on throwaway tables with a fake Studio, the importer keeping Streamer.bot's speech confidence, Studio's
 * state report carrying voice, and the page script. Nothing reaches a real Studio, OBS, Twitch or Kick.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const A = (id, name, actions, extra = {}) => ({ id, name, enabled: false, trigger_type: 'chat', trigger_config: {}, conditions: [], actions, ...extra });
const V = (id, name, actions, phrases, extra = {}) => A(id, name, actions, { trigger_type: 'voice.phrase', trigger_config: { phrases }, ...extra });
const SCENES = { scenes: {
    'IN-GAME': [{ source: 'Firebot', enabled: true }, { source: 'CertiFried Canvas', enabled: false, certifried: { overlayId: 3, replaces: 'Firebot' } }, { source: 'Work', enabled: false }, { source: 'Camera and Frame', enabled: true }],
    BRB: [{ source: 'Firebot', enabled: true }, { source: 'CertiFried Canvas', enabled: false, certifried: { overlayId: 3, replaces: 'Firebot' } }],
} };
const OBS_KNOWN = { known: true, scenes: new Set(['IN-GAME', 'BRB']), sources: new Set(['Firebot', 'CertiFried Canvas', 'Work', 'Camera and Frame']), inputs: new Set() };
const item = (id, n, extra = {}) => ({ id: 100 + id, target_kind: 'automation', target_ref: `automation:${id}`, source: 'streamerbot', kind: 'speech', source_id: `s${id}`, data: { hash: automationHash(n) }, ...extra });
const CAPABLE = { connected: true, apps: true, voice: true, voiceState: 'off', voiceEnabled: false, voiceThreshold: 0.7 };

// ── pure plan ───────────────────────────────────────────────────────────────────────────────

test('voice in the plan: a Studio step when a voice command will be on, a blocking line when Studio is offline or too old, nothing without voice commands', () => {
    const v1 = V(1, 'Streamer.bot: Reset counters', [{ type: 'counter.set', name: 'x' }], ['reset counters']);
    const chat = A(2, 'Firebot: !died', [{ type: 'chat.send', text: 'RIP' }]);
    const base = { automations: [v1, chat], importItems: [item(1, v1), item(2, chat)], obs: OBS_KNOWN, sceneItems: SCENES };
    const ok = buildPlan({ ...base, studio: CAPABLE });
    assert.equal(ok.voice.step, 'enable');
    assert.equal(ok.voice.blocking, null);
    assert.equal(ok.voice.on, 1);
    assert.equal(ok.counts.voice, 1);
    assert.equal(ok.voice.studio.state, 'off');
    assert.deepEqual(ok.voice.obsSources, ['Camera and Frame', 'CertiFried Canvas', 'Firebot', 'Work'], 'the picker list is what Studio reported');

    const offline = buildPlan({ ...base, studio: { connected: false, apps: false }, sceneItems: null });
    assert.equal(offline.voice.step, null);
    assert.match(offline.voice.blocking, /Studio is not connected/);
    const old = buildPlan({ ...base, studio: { connected: true, apps: true, voice: false } });
    assert.match(old.voice.blocking, /too old/);
    assert.equal(old.voice.step, null);

    const none = buildPlan({ automations: [chat], importItems: [item(2, chat)], obs: OBS_KNOWN, sceneItems: SCENES, studio: { connected: false } });
    assert.equal(none.voice.blocking, null, 'no voice command, no voice line');
    assert.equal(none.voice.step, null);
});

test('held voice items carry the phrase, the OBS sources OBS does not have and the Go Live stop; a checked phrase stops being flagged', () => {
    const away = V(5, 'Streamer.bot: I am not here (Work)', [{ type: 'obs.source', scene: 'IN-GAME', source: 'Gone to Work', visible: 'show' }, { type: 'obs.source', scene: 'IN-GAME', source: 'Cam', visible: 'hide' }], ['i am not here work']);
    const goLive = V(14, 'Streamer.bot: Go Live', [{ type: 'obs.stream', state: 'stop' }], ['go live on stream right now']);
    const notes = new Map([['streamerbot|speech|s5', ['The voice phrase is not in the file; check it']], ['streamerbot|speech|s14', ['Streamer.bot had this set to Stop streaming; check that is what you want before turning it on']]]);
    const plan = buildPlan({ automations: [away, goLive], importItems: [item(5, away), item(14, goLive)], notes, obs: OBS_KNOWN, sceneItems: SCENES, studio: CAPABLE });
    const row = (id) => plan.automations.find((a) => a.id === id);
    assert.equal(row(5).state, 'attention');
    assert.deepEqual(row(5).phrases, ['i am not here work']);
    assert.deepEqual(row(5).unknownSources, ['Gone to Work', 'Cam']);
    assert.ok(row(5).reasons.some((r) => /guessed/.test(r)));
    assert.equal(row(5).voice, true);
    assert.equal(row(14).streamStop, true);
    assert.equal(row(14).state, 'attention');
    assert.equal(plan.voice.held, 2);
    assert.equal(plan.voice.on, 0);

    const checked = buildPlan({ automations: [away], importItems: [item(5, away, { data: { hash: automationHash(away), phraseChecked: true } })], notes, obs: OBS_KNOWN, sceneItems: SCENES, studio: CAPABLE });
    assert.ok(!checked.automations[0].reasons.some((r) => /guessed/.test(r)), 'a phrase the streamer checked here is not flagged again');
    assert.deepEqual(unknownObsSources(away, { known: false }), [], 'OBS not read: no judgement');
});

test('Chat commands switch: one item per channel with a command going on, none when it is already on, held when only held commands are there', () => {
    const items = [{ id: 1, target_kind: 'channel_command', target_ref: 'cc:10,cc:11,cc:12', source: 'firebot', kind: 'command', source_id: 'cc' }];
    const commands = new Map([
        [10, { id: 10, channel_id: 5, command_name: 'tip', is_enabled: 0, updated_at: null, platform: 'twitch' }],
        [11, { id: 11, channel_id: 6, command_name: 'tip', is_enabled: 0, updated_at: null, platform: 'kick' }],
        [12, { id: 12, channel_id: 7, command_name: 'so', is_enabled: 0, updated_at: null, platform: 'twitch' }],
    ]);
    const channels = new Map([[5, { id: 5, platform: 'twitch', name: 'maplehollow_tv', commandsOn: false }], [6, { id: 6, platform: 'kick', name: 'maplehollow', commandsOn: true }], [7, { id: 7, platform: 'twitch', name: 'other', commandsOn: false }]]);
    const plan = buildPlan({ importItems: items, commands, channels, studio: { connected: false } });
    assert.deepEqual(plan.channelSwitches.map((s) => [s.key, s.name, s.state, s.commandKeys]), [
        ['f:5', 'Turn on Chat commands for #maplehollow_tv', 'turn_on', ['c:10']], ['f:7', 'Turn on Chat commands for #other', 'turn_on', ['c:12']],
    ]);
    assert.deepEqual(plan.counts.channelSwitches, { turn_on: 2 }, 'shown in the preview counts');
    const held = buildPlan({ importItems: [{ ...items[0], data: { sourceOn: false } }], commands, channels, studio: { connected: false } });
    assert.deepEqual(held.channelSwitches.map((s) => s.state), ['held', 'held']);
});

test('steps naming a replaced source: rewritten to the replacing source on untouched imports only, by scene', () => {
    const kill = A(20, 'Streamer.bot: Kill Counters', [{ type: 'obs.source', scene: 'IN-GAME', source: 'Firebot', visible: 'hide' }]);
    const bring = A(21, 'Streamer.bot: Lets Have Counters', [{ type: 'obs.source', source: 'Firebot', visible: 'show' }, { type: 'random', branches: [{ actions: [{ type: 'obs.source', scene: 'BRB', source: 'Firebot', visible: 'show' }] }] }]);
    const mine = A(22, 'Streamer.bot: edited', [{ type: 'obs.source', scene: 'IN-GAME', source: 'Firebot', visible: 'show' }]);
    const other = A(23, 'Streamer.bot: other source', [{ type: 'obs.source', scene: 'IN-GAME', source: 'Work', visible: 'show' }]);
    const kept = A(24, 'linked by hand', [{ type: 'obs.source', scene: 'IN-GAME', source: 'Firebot', visible: 'show' }]);
    const items = [item(20, kill), item(21, bring), { ...item(22, mine), data: { hash: 'older-hash' } }, item(23, other), { ...item(24, kept), data: { keep: true, linkedBy: 'name' } }];
    const plan = buildPlan({ automations: [kill, bring, mine, other, kept], importItems: items, obs: OBS_KNOWN, sceneItems: SCENES, studio: CAPABLE });
    assert.deepEqual(plan.rewrites.map((r) => [r.id, r.hits.map((h) => `${h.scene || '*'}:${h.from}>${h.to}`)]), [[20, ['IN-GAME:Firebot>CertiFried Canvas']], [21, ['*:Firebot>CertiFried Canvas', 'BRB:Firebot>CertiFried Canvas']]]);
    assert.equal(plan.counts.rewrites, 2);
    assert.equal(buildPlan({ automations: [kill], importItems: [item(20, kill)], obs: { known: false }, studio: { connected: false } }).rewrites.length, 0, 'OBS not read: nothing rewritten');
    const pairs = [{ scene: 'A', oldSource: 'X', newSource: 'N1' }, { scene: 'B', oldSource: 'X', newSource: 'N2' }];
    assert.equal(replacementFor(pairs, 'A', 'X'), 'N1');
    assert.equal(replacementFor(pairs, null, 'X'), null, 'two different replacements and no scene: ambiguous, left alone');
    assert.equal(replacementFor(pairs, 'C', 'X'), null);
});

test('Streamer.bot speech confidence: the importer keeps it; the switchover only mentions it and never suggests or applies it (2026-11-20)', () => {
    const files = streamerbotFiles({ 'settings.json': { speechToText: { confidenceThreshold: 0.2, commands: [{ id: 's1', enabled: true, command: 'Lets play a game' }] }, timedActions: { timers: [] } } });
    const bundle = parseStreamerbot({ files });
    assert.deepEqual(bundle.speech, { confidenceThreshold: 0.2 });
    const plan = importPlan([bundle], { channels: [], channelBots: [], builtins: new Set() });
    assert.deepEqual(plan.speech, [{ source: 'streamerbot', confidenceThreshold: 0.2 }]);
    assert.deepEqual(reportOf(plan).speech, [{ source: 'streamerbot', confidenceThreshold: 0.2 }], 'kept in the import report the switchover reads');
    assert.equal(parseStreamerbot({ files: streamerbotFiles() }).speech, undefined, 'no setting, no suggestion');
    assert.equal(suggestThreshold(0.2), 0.2);
    assert.equal(suggestThreshold(0.12), 0.2);
    assert.equal(suggestThreshold(0.47), 0.45);
    assert.equal(suggestThreshold(1), 0.95);
    assert.equal(suggestThreshold('x'), null);
    const v1 = V(1, 'x', [{ type: 'chat.send', text: 'a' }], ['go']);
    const pv = buildPlan({ automations: [v1], importItems: [item(1, v1)], studio: CAPABLE, speech: 0.2 }).voice;
    assert.equal(pv.suggestedThreshold, null, 'never suggested: Studio scores differently, and 0.2 fired commands nobody said');
    assert.equal(pv.streamerbotThreshold, 0.2, 'shown for the explanation only');
    assert.equal(pv.studioDefault, 0.7);
});

test('Studio state report carries voice: state, switch, phrase count and confidence, cleaned', () => {
    const s = sanitiseState({ obs: {}, voice: { enabled: 1, state: 'listening', error: 'x\u0000y', phrases: 14, threshold: 0.2 } });
    assert.deepEqual(s.voice, { enabled: true, state: 'listening', error: 'x y', phrases: 14, threshold: 0.2 });
    assert.equal(sanitiseState({ obs: {}, voice: { state: 'weird', phrases: 9999, threshold: 0.01 } }).voice.state, 'off');
    assert.equal(sanitiseState({ obs: {}, voice: { threshold: 0.01 } }).voice.threshold, 0.2);
    assert.equal(sanitiseState({ obs: {}, voice: 'no' }).voice, null);
    assert.equal(sanitiseState({ obs: {} }).voice, null, 'an older Studio sends none');
});

// ── on throwaway tables with a fake Studio ──────────────────────────────────────────────────

let T, importStore, ch, profile;
test.before(async () => {
    T = await makeTables(pool, 'v');
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

/** A fake CertiFried Studio: OBS scenes, optional voice (with the state it answers voice.enable with). */
function fakeHub({ voice = true, voiceAnswer = 'listening', voiceState = 'off', scenes = SCENES, offline = false, swapFails = false } = {}) {
    const sent = [];
    const notified = [];
    const obs = JSON.parse(JSON.stringify(scenes));
    const answers = new Map();
    let seq = 0;
    return {
        sent, notified, obs,
        connected: () => offline ? [] : [{ kind: 'studio', capabilities: voice ? ['obs', 'apps', 'voice'] : ['obs', 'apps'], client: { version: '0.2.8' }, state: voice ? { voice: { enabled: voiceState !== 'off', state: voiceState, phrases: 0, threshold: 0.7 } } : null }],
        notify: (pid, kind, msg) => { notified.push(msg.type); sent.push({ actionType: `notify:${msg.type}` }); },
        async dispatch(d) {
            sent.push({ actionType: d.actionType, params: d.params, capability: d.capability });
            if (offline && d.actionType !== 'obs.scene_items') return { id: 'none', status: 'none', devices: 0 };
            const id = `d_${++seq}`;
            let result = {};
            if (d.actionType === 'obs.scene_items') result = obs;
            if (d.actionType === 'obs.set_scene_items') result = { changes: d.params.changes.map((c) => { const it = (obs.scenes[c.scene] || []).find((x) => x.source === c.source); if (!it) return { ...c, ok: false, error: 'source_not_found' }; const previous = it.enabled; it.enabled = c.enabled; return { ...c, ok: true, previous, changed: previous !== c.enabled }; }) };
            if (d.actionType === 'voice.set') result = { enabled: d.params.enabled, state: d.params.enabled ? 'listening' : 'off', threshold: d.params.threshold ?? 0.7 };
            if (d.actionType === 'voice.enable') result = { enabled: true, state: voiceAnswer, error: voiceAnswer === 'error' ? 'No recogniser' : null, phrases: 14, threshold: d.params.threshold ?? 0.7 };
            if (d.actionType === 'studio.close_apps') result = { apps: [{ app: 'firebot', closed: true, stillRunning: false }, { app: 'streamerbot', closed: true, stillRunning: false }] };
            answers.set(id, swapFails && d.actionType === 'obs.set_scene_items' ? { status: 'failed', result: null, error: 'obs_live' } : { status: 'acked', result, error: null });
            return { id, status: 'sent', devices: 1 };
        },
        onAck(id, fn) { setImmediate(() => fn(answers.get(id))); return () => {}; },
    };
}
const rows = async () => (await pool.query(`SELECT id, status, previous FROM \`${T.prefix}switchovers\` WHERE profile_id = ? ORDER BY id`, [profile.id]))[0]
    .map((r) => ({ ...r, previous: typeof r.previous === 'string' ? JSON.parse(r.previous) : r.previous }));
const mkSw = (hub) => createSwitchover({ db: pool, store: T.store, importStore, hub, prefix: T.prefix, channelTables: ch, ackWaitMs: 2000 });
const enabled = async (id) => (await T.store.getAutomation(profile.id, id)).enabled;
const itemFor = async (id) => (await importStore.listItems(profile.id)).find((i) => i.target_ref === `automation:${id}`);
const feats = async (id) => { const v = (await pool.query(`SELECT features_enabled FROM \`${ch.channels}\` WHERE id = ?`, [id]))[0][0].features_enabled; return (typeof v === 'string' ? JSON.parse(v) : v) || {}; };

async function resetAll() {
    for (const a of await T.store.listAutomations(profile.id)) await T.store.deleteAutomation(profile.id, a.id);
    await pool.query(`DELETE FROM \`${T.prefix}import_items\` WHERE profile_id = ?`, [profile.id]);
    await pool.query(`DELETE FROM \`${ch.commands}\``);
    await pool.query(`DELETE FROM \`${ch.channels}\``);
    await pool.query(`DELETE FROM \`${T.prefix}switchovers\` WHERE profile_id = ?`, [profile.id]);
}

async function seed(tag) {
    await resetAll();
    const mk = async (name, trigger_type, trigger_config, actions) => T.store.createAutomation(profile.id, { name, enabled: false, trigger_type, trigger_config, conditions: [], actions });
    const reset = await mk(`${tag} Reset counters`, 'voice.phrase', { phrases: ['reset counters'] }, [{ type: 'chat.send', text: 'reset' }]);
    const away = await mk(`${tag} I am not here`, 'voice.phrase', { phrases: ['i am not here work'] }, [{ type: 'obs.source', scene: 'IN-GAME', source: 'Gone to Work', visible: 'show' }]);
    const kill = await mk(`${tag} Kill Counters`, 'voice.phrase', { phrases: ['kill the counters'] }, [{ type: 'obs.source', scene: 'IN-GAME', source: 'Firebot', visible: 'hide' }, { type: 'obs.source', scene: 'BRB', source: 'Firebot', visible: 'hide' }]);
    const keep = await mk(`${tag} Mine`, 'chat', {}, [{ type: 'obs.source', scene: 'IN-GAME', source: 'Firebot', visible: 'show' }]);
    const ids = { reset, away, kill, keep };
    for (const [k, id] of Object.entries(ids)) {
        const a = await T.store.getAutomation(profile.id, id);
        await importStore.upsertItem(profile.id, { importId: null, source: 'streamerbot', kind: 'speech', sourceId: `${tag}${k}`, name: a.name, status: 'changed', targetKind: 'automation', targetRef: `automation:${id}`, data: { hash: automationHash(a) } });
    }
    // "keep" was edited after the import: its stored hash is of something else.
    await importStore.setItemData(profile.id, (await itemFor(keep)).id, { hash: 'edited-later' });
    const [row] = await pool.query(`INSERT INTO \`${ch.channels}\` (owner_id, connection_id, platform, channel_id, channel_name) VALUES (1, 1, 'kick', '800000001', 'maplehollow')`);
    const ccId = await importStore.insertChannelCommand({ channelId: row.insertId, name: `${tag}discord`, response: 'join us', cooldown: 5, modOnly: false, broadcasterOnly: false, createdBy: 'Imported from Firebot' });
    await importStore.upsertItem(profile.id, { importId: null, source: 'firebot', kind: 'command', sourceId: `${tag}discord`, name: '!discord', status: 'as_is', targetKind: 'channel_command', targetRef: `cc:${ccId}` });
    return { ...ids, ccId, channelRow: Number(row.insertId) };
}
const cleanup = () => resetAll();

test('apply: Studio turns voice on after the automations (voice.enable, capability voice), phrases refresh, the Chat commands switch goes on, steps point at CertiFried; Undo puts it all back', async () => {
    const ids = await seed('a');
    // an earlier import report with Streamer.bot's speech confidence
    const impId = await importStore.createImport(profile.id, { sources: 'streamerbot', fileNames: null, categories: [] });
    await importStore.finishImport(impId, { summary: {}, report: { groups: {}, speech: [{ source: 'streamerbot', confidenceThreshold: 0.2 }] } });
    const hub = fakeHub();
    const sw = mkSw(hub);
    const plan = await sw.preview(profile.id);
    assert.equal(plan.voice.suggestedThreshold, null);
    assert.equal(plan.voice.streamerbotThreshold, 0.2);
    assert.equal(plan.voice.step, 'enable');
    assert.deepEqual(plan.channelSwitches.map((s) => [s.name, s.state]), [['Turn on Chat commands for #maplehollow', 'turn_on']]);
    assert.deepEqual(plan.rewrites.map((r) => r.id), [ids.kill], 'untouched imports only: the edited one is left');
    assert.equal((await feats(ids.channelRow)).commands, undefined);

    const killBefore = (await T.store.getAutomation(profile.id, ids.kill)).actions;
    const r = await sw.apply(profile.id, { include: [], obs: true, closeApps: false, voiceThreshold: true });
    assert.equal(r.status, 'applied');
    assert.equal(r.result.channels, 1);
    assert.equal(r.result.steps, 2);
    assert.deepEqual(r.result.voice, { status: 'acked', error: null, state: 'listening', phrases: 14, threshold: 0.7, detail: null }, 'Studio kept its own confidence, even with the old voiceThreshold flag');

    const order = hub.sent.map((s) => s.actionType);
    const enableAt = order.indexOf('voice.enable');
    assert.ok(order.indexOf('notify:automations_changed') < enableAt, 'Studio is told the automations changed before it fetches phrases');
    const en = hub.sent[enableAt];
    assert.deepEqual([en.capability, en.params], ['voice', {}], 'no threshold is sent');
    assert.deepEqual(hub.notified, ['automations_changed', 'automations_changed'], 'once for the turned-on automations, once after the steps were pointed at CertiFried');
    assert.equal(await enabled(ids.reset), true, 'a voice command with a plain phrase goes on');
    assert.equal(await enabled(ids.away), false, 'the one with a missing OBS source stays held');
    assert.equal(await enabled(ids.kill), true);

    assert.equal((await feats(ids.channelRow)).commands, true, 'the Chat commands switch is on');
    const killNow = (await T.store.getAutomation(profile.id, ids.kill)).actions;
    assert.deepEqual(killNow.map((s) => s.source), ['CertiFried Canvas', 'CertiFried Canvas']);
    assert.deepEqual(killNow.map((s) => s.visible), ['hide', 'hide']);
    assert.equal((await T.store.getAutomation(profile.id, ids.keep)).actions[0].source, 'Firebot', 'the edited one is untouched');
    assert.equal((await T.store.getAutomation(profile.id, ids.away)).actions[0].source, 'Gone to Work', 'a source CertiFried does not replace is not guessed');
    assert.equal((await itemFor(ids.kill)).data.hash, automationHash(await T.store.getAutomation(profile.id, ids.kill)), 'the import item follows the new steps');
    const row = (await pool.query(`SELECT previous FROM \`${T.prefix}switchovers\` WHERE id = ?`, [r.id]))[0][0];
    const prev = typeof row.previous === 'string' ? JSON.parse(row.previous) : row.previous;
    assert.deepEqual(prev.channels, [{ id: ids.channelRow, existed: false, value: null }]);
    assert.deepEqual(prev.steps[0].actions, killBefore, 'the old steps are kept for Undo');

    const again = await sw.preview(profile.id);
    assert.equal(again.automations.find((a) => a.id === ids.kill).state, 'already_on', 'not read as the streamer’s edit afterwards');

    const u = await sw.undo(profile.id);
    assert.equal(u.ok, true);
    assert.deepEqual([u.result.channels, u.result.steps, u.result.stepsSkipped], [1, 1, 0]);
    assert.equal((await feats(ids.channelRow)).commands, undefined, 'the switch is as it was (no key)');
    assert.deepEqual((await T.store.getAutomation(profile.id, ids.kill)).actions, killBefore);
    assert.equal((await itemFor(ids.kill)).data.hash, automationHash(await T.store.getAutomation(profile.id, ids.kill)));
    assert.equal(await enabled(ids.reset), false);
    await cleanup(ids);
});

test('Chat commands switch: an existing false comes back on Undo; a switch the streamer changed since is left; a channel already on is not touched', async () => {
    const ids = await seed('b');
    await pool.query(`UPDATE \`${ch.channels}\` SET features_enabled = ? WHERE id = ?`, [JSON.stringify({ commands: false, shoutout: true }), ids.channelRow]);
    const sw = mkSw(fakeHub());
    await sw.apply(profile.id, { obs: false });
    assert.deepEqual(await feats(ids.channelRow), { commands: true, shoutout: true });
    await sw.undo(profile.id);
    assert.deepEqual(await feats(ids.channelRow), { commands: false, shoutout: true });

    await sw.apply(profile.id, { obs: false });
    await pool.query(`UPDATE \`${ch.channels}\` SET features_enabled = JSON_SET(features_enabled, '$.commands', false) WHERE id = ?`, [ids.channelRow]);
    const u = await sw.undo(profile.id);
    assert.equal(u.result.channels, 0, 'the streamer turned it off themselves: Undo leaves it');
    assert.equal((await feats(ids.channelRow)).commands, false);

    await pool.query(`UPDATE \`${ch.channels}\` SET features_enabled = ? WHERE id = ?`, [JSON.stringify({ commands: true }), ids.channelRow]);
    const plan = await sw.preview(profile.id);
    assert.deepEqual(plan.channelSwitches, [], 'already on: no item');
    await cleanup(ids);
});

test('closing the apps: refused while Studio is not listening and a voice command is on; allowed once it listens; refused when Studio cannot turn voice on', async () => {
    const ids = await seed('c');
    // Studio answers voice.enable with an error state: Streamer.bot stays open.
    const bad = fakeHub({ voiceAnswer: 'error' });
    let r = await mkSw(bad).apply(profile.id, { obs: false, closeApps: true });
    assert.equal(r.status, 'partial');
    assert.deepEqual([r.result.apps.status, r.result.apps.error], ['refused', VOICE_NOT_LISTENING]);
    assert.ok(!bad.sent.some((s) => s.actionType === 'studio.close_apps'), 'nothing was closed');
    assert.equal(r.result.voice.state, 'error');
    await mkSw(bad).undo(profile.id);

    // An older Studio: no voice capability, voice not listening.
    const old = fakeHub({ voice: false });
    r = await mkSw(old).apply(profile.id, { obs: false, closeApps: true });
    assert.equal(r.result.apps.status, 'refused');
    assert.equal(r.result.voice.status, 'unavailable');
    assert.match(r.result.voice.error, /too old/);
    assert.ok(!old.sent.some((s) => s.actionType === 'voice.enable' || s.actionType === 'studio.close_apps'));
    await mkSw(old).undo(profile.id);

    // Listening: closed.
    const good = fakeHub();
    r = await mkSw(good).apply(profile.id, { obs: false, closeApps: true });
    assert.equal(r.status, 'applied');
    assert.equal(r.result.apps.status, 'acked');
    assert.ok(good.sent.findIndex((s) => s.actionType === 'voice.enable') < good.sent.findIndex((s) => s.actionType === 'studio.close_apps'), 'Studio listens first, then the apps close');
    await mkSw(good).undo(profile.id);

    // Already listening before: no need to ask first for apps to close... still asks voice.enable to refresh the phrases.
    const was = fakeHub({ voiceState: 'listening' });
    r = await mkSw(was).apply(profile.id, { obs: false, closeApps: true });
    assert.equal(r.result.apps.status, 'acked');
    await mkSw(was).undo(profile.id);
    await cleanup(ids);
});

test('no voice command to turn on: no voice.enable, and closing the apps is not held back by voice', async () => {
    await resetAll();
    const id = await T.store.createAutomation(profile.id, { name: 'Plain chat', enabled: false, trigger_type: 'chat', trigger_config: {}, conditions: [], actions: [{ type: 'chat.send', text: 'x' }] });
    const a = await T.store.getAutomation(profile.id, id);
    await importStore.upsertItem(profile.id, { importId: null, source: 'firebot', kind: 'command', sourceId: 'plain', name: 'Plain', status: 'as_is', targetKind: 'automation', targetRef: `automation:${id}`, data: { hash: automationHash(a) } });
    const hub = fakeHub({ voice: false });
    const r = await mkSw(hub).apply(profile.id, { obs: false, closeApps: true });
    assert.equal(r.result.voice, null);
    assert.equal(r.result.apps.status, 'acked');
    assert.ok(!hub.sent.some((s) => s.actionType === 'voice.enable'));
    await mkSw(hub).undo(profile.id);
    await resetAll();
});

test('an edited rewrite is not put back by Undo; markFixed keeps a fixed item in the plan and clears the checked phrase flag', async () => {
    const ids = await seed('d');
    const hub = fakeHub();
    const sw = mkSw(hub);
    await sw.apply(profile.id, { obs: true });
    // the streamer edits the rewritten automation afterwards
    const a = await T.store.getAutomation(profile.id, ids.kill);
    await T.store.updateAutomation(profile.id, ids.kill, { ...a, actions: [...a.actions, { type: 'chat.send', text: 'edited' }] });
    const u = await sw.undo(profile.id);
    assert.deepEqual([u.result.steps, u.result.stepsSkipped], [0, 1]);
    assert.equal((await T.store.getAutomation(profile.id, ids.kill)).actions.length, 3, 'their edit stays');

    // fixing a held item through the automation PUT, then markFixed: the import item follows the saved automation
    const away = await T.store.getAutomation(profile.id, ids.away);
    await T.store.updateAutomation(profile.id, ids.away, { ...away, trigger_config: { phrases: ['i am away'] }, actions: [{ type: 'obs.source', scene: 'IN-GAME', source: 'Work', visible: 'show' }] });
    assert.equal((await sw.preview(profile.id)).automations.find((x) => x.id === ids.away).state, 'edited', 'before it is marked fixed it reads as the streamer’s edit');
    assert.deepEqual(await sw.markFixed(profile.id, ids.away, { phrase: true }), { ok: true });
    const row = (await sw.preview(profile.id)).automations.find((x) => x.id === ids.away);
    assert.equal(row.state, 'turn_on', 'the fixed phrase and source leave nothing to look at');
    assert.deepEqual(row.phrases, ['i am away']);
    assert.equal((await itemFor(ids.away)).data.phraseChecked, true);
    assert.equal((await sw.markFixed(profile.id, 999999999)).ok, false);
    await cleanup(ids);
});

test('I1: Undo puts Studio voice back (off and 0.7), through voice.set; offline Studio gets a clear line and the part stays for the next Undo', async () => {
    const ids = await seed('e');
    const impId = await importStore.createImport(profile.id, { sources: 'streamerbot', fileNames: null, categories: [] });
    await importStore.finishImport(impId, { summary: {}, report: { groups: {}, speech: [{ source: 'streamerbot', confidenceThreshold: 0.2 }] } });
    const sw = mkSw(fakeHub({ voiceState: 'off' }));
    const r = await sw.apply(profile.id, { obs: false, voiceThreshold: true });
    assert.deepEqual((await rows()).find((x) => x.id === r.id).previous.voice, { enabled: false, threshold: 0.7 }, 'the old switch and confidence are in the record');
    let u = await mkSw(fakeHub({ offline: true })).undo(profile.id);
    assert.equal(u.ok, false);
    assert.equal(u.status, 'partial');
    assert.match(u.error, /Turn voice commands off in Studio, or reconnect Studio and press Undo again\./);
    assert.equal(await enabled(ids.reset), false, 'the database part was undone');
    assert.deepEqual((await rows()).find((x) => x.id === r.id).previous.voice, { enabled: false, threshold: 0.7 }, 'the voice part is kept');
    const back = fakeHub();
    u = await mkSw(back).undo(profile.id);
    assert.equal(u.ok, true);
    const set = back.sent.find((s) => s.actionType === 'voice.set');
    assert.deepEqual([set.capability, set.params], ['voice', { enabled: false, threshold: 0.7 }]);
    assert.equal((await rows()).find((x) => x.id === r.id).status, 'undone');
    await cleanup();
});

test('I2: a failure mid-apply leaves a partial record with what was done; Undo reverses only that switchover and leaves the older one intact', async () => {
    const ids = await seed('f');
    const first = await mkSw(fakeHub()).apply(profile.id, { obs: false });
    assert.equal(first.status, 'applied');
    assert.equal(await enabled(ids.reset), true);
    const extra = await T.store.createAutomation(profile.id, { name: 'Late chat', enabled: false, trigger_type: 'chat', trigger_config: {}, conditions: [], actions: [{ type: 'chat.send', text: 'late' }] });
    await importStore.upsertItem(profile.id, { importId: null, source: 'firebot', kind: 'command', sourceId: 'late', name: 'Late', status: 'as_is', targetKind: 'automation', targetRef: `automation:${extra}`, data: { hash: automationHash(await T.store.getAutomation(profile.id, extra)) } });
    // a second command whose channel switch will fail: the failure is injected into the Chat commands write
    await pool.query(`UPDATE \`${ch.channels}\` SET features_enabled = NULL WHERE id = ?`, [ids.channelRow]);
    const cc2 = await importStore.insertChannelCommand({ channelId: ids.channelRow, name: 'fsecond', response: 'x', cooldown: 5, modOnly: false, broadcasterOnly: false, createdBy: 'Imported from Firebot' });
    await importStore.upsertItem(profile.id, { importId: null, source: 'firebot', kind: 'command', sourceId: 'fsecond', name: '!fsecond', status: 'as_is', targetKind: 'channel_command', targetRef: `cc:${cc2}` });
    const real = pool.query.bind(pool);
    pool.query = (sql, ...rest) => (/JSON_SET\(COALESCE\(features_enabled/.test(String(sql)) ? Promise.reject(new Error('injected failure')) : real(sql, ...rest));
    let second;
    try { second = await mkSw(fakeHub()).apply(profile.id, { obs: false }); } finally { pool.query = real; }
    assert.equal(second.status, 'partial');
    assert.match(second.result.error, /injected failure/);
    const rs = await rows();
    assert.deepEqual(rs.map((x) => x.status), ['applied', 'partial']);
    assert.ok(rs[1].previous.automations.some((a) => a.id === extra), 'what was done before the failure is recorded');
    assert.equal(await enabled(extra), true);
    const u = await mkSw(fakeHub()).undo(profile.id);
    assert.equal(u.ok, true);
    assert.equal(await enabled(extra), false, 'the partial switchover is reversed');
    assert.equal(await enabled(ids.reset), true, 'the older switchover is untouched');
    assert.deepEqual((await rows()).map((x) => x.status), ['applied', 'undone']);
    await cleanup();
});

test('I3: a failed OBS swap leaves the steps as they were and says so; a confirmed swap rewrites them', async () => {
    const ids = await seed('g');
    const before = (await T.store.getAutomation(profile.id, ids.kill)).actions;
    const bad = fakeHub({ swapFails: true });
    const r = await mkSw(bad).apply(profile.id, { obs: true });
    assert.equal(r.status, 'partial');
    assert.equal(r.result.obs.status, 'failed');
    assert.equal(r.result.stepsSkipped, 'swap_failed');
    assert.equal(r.result.steps, 0);
    assert.deepEqual((await T.store.getAutomation(profile.id, ids.kill)).actions, before, 'steps untouched');
    assert.equal((await itemFor(ids.kill)).data.hash, automationHash(await T.store.getAutomation(profile.id, ids.kill)));
    await mkSw(bad).undo(profile.id);
    const good = fakeHub();
    const r2 = await mkSw(good).apply(profile.id, { obs: true });
    assert.equal(r2.result.stepsSkipped, null);
    assert.equal(r2.result.steps, 2);
    await mkSw(good).undo(profile.id);
    await cleanup();
});

// ── the page, the route and Studio ──────────────────────────────────────────────────────────

test('the page script and route: held voice items get a phrase box, an OBS source picker from Studio, Change to Start; saves go through the automation PUT; no markup from strings', () => {
    const js = read('dashboard/public/js/stream-bot-switchover.js');
    assert.doesNotMatch(js, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write\(/);
    assert.match(js, /Phrase you say/);
    assert.match(js, /Change to start/);
    assert.match(js, /document\.createElement\('select'\)/);
    assert.match(js, /call\('PUT', '\/stream\/bot\/api\/automations\//);
    assert.match(js, /\/stream\/bot\/api\/switchover\/fixed/);
    assert.match(js, /voiceThreshold: !!\(vt && vt\.checked\)/);
    assert.match(js, /v\.obsSources/);
    assert.doesNotMatch(js, /[\u{1F300}-\u{1FAFF}✨✅❌]/u, 'no emoji');
    const route = read('dashboard/routes/stream-bot-switchover.js');
    assert.match(route, /router\.post\('\/stream\/bot\/api\/switchover\/fixed', needApi,/);
    assert.match(route, /voiceThreshold: req\.body\?\.voiceThreshold === true/);
    assert.match(route, /invalidateChannel: invalidateChannelCache/);
    const css = read('dashboard/public/css/stream-bot-switchover.css');
    assert.doesNotMatch(css, /gradient\(/);
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'colours come from the site tokens, so Dark, Light and Sand all work');
});

test('Studio: voice.enable and voice.set behind capability voice, voice in the state report, phrases refreshed when automations change, the 0.2 floor, version 0.2.9', () => {
    const main = read('desktop/studio/src/main/main.js');
    const router = read('desktop/studio/src/main/router.js');
    assert.match(router, /handlers\.has\('voice\.enable'\) \? \['voice'\]/);
    assert.match(main, /'voice\.enable': \(p\) => enableVoice\(p \|\| \{\}\)/);
    assert.match(main, /async function enableVoice/);
    assert.match(main, /config\.update\(\{ voice: patch \}\);\s*try \{ await refreshVoicePhrases\(\)/);
    assert.match(main, /state\.voice = \{ enabled:/);
    assert.match(main, /engine\.on\('automations-changed', \(\) => \{ refreshAutomations\(\)\.catch\(\(\) => \{\}\); refreshVoicePhrases\(\)/);
    assert.match(main, /'voice\.set': \(p\) => setVoice\(p \|\| \{\}\)/);
    const [ma, mi, pa] = JSON.parse(read('desktop/studio/package.json')).version.split('.').map(Number);
    assert.ok(ma > 0 || mi > 2 || (mi === 2 && pa >= 9), 'Studio is 0.2.9 or later');
});
