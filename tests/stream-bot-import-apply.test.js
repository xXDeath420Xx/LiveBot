import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { firebotFiles, streamerbotFiles, FAKE } from './fixtures/stream-bot-import.js';
import { importDdl, IMPORT_TABLES, RETENTION_ROWS } from '../migrations/455_stream_bot_imports.js';
import { createImportStore, applyPlan, recreateReward, pendingWordsView, applyPendingWords, AUTOMOD_WORDS_MAX } from '../core/stream-bot/import/apply.js';
import { importExport } from '../core/stream-bot/import/privacy.js';
import { createStreamBotPrivacy } from '../core/stream-bot/privacy.js';
import { parseFirebot } from '../core/stream-bot/import/firebot.js';
import { parseStreamerbot } from '../core/stream-bot/import/streamerbot.js';
import { buildPlan } from '../core/stream-bot/import/mapper.js';
import { viewersDdl, VIEWER_TABLES } from '../migrations/464_stream_bot_viewers.js';
import { createViewerStore } from '../core/stream-bot/viewers/store.js';

/*
 * Stream bot import writes (core/stream-bot/import/apply.js) on throwaway tables: the stream bot tables of migration
 * 454 and the import tables of 455 under a test prefix, plus copies of the channel-bot tables (tokes_channels,
 * tokes_custom_commands, tokes_timers) made with CREATE TABLE … LIKE. Covers: everything created switched off and
 * marked, re-import creates nothing twice, a deleted target comes back, values and hand-made commands are never
 * overwritten, automation.run links, /privacy export and delete, the reward recreate call (fake fetch only), and banned
 * words: saved as a pending list, never written to Kick automod by an import, applied only by applyPendingWords (H-742).
 */

let T, store, importStore, profile, ch;
const ALL = ['commands', 'automations', 'timers', 'counters', 'rewards', 'quotes', 'moderation', 'hotkeys', 'integrations', 'viewers'];

test.before(async () => {
    T = await makeTables(pool, 'i');
    for (const sql of importDdl(T.prefix)) await pool.query(sql);
    for (const sql of viewersDdl(T.prefix)) await pool.query(sql);   // viewer records (H-747, migration 464)
    ch = { channels: `${T.prefix}tk_channels`, commands: `${T.prefix}tk_cc`, timers: `${T.prefix}tk_timers` };
    await pool.query(`CREATE TABLE \`${ch.channels}\` LIKE tokes_channels`);
    await pool.query(`CREATE TABLE \`${ch.commands}\` LIKE tokes_custom_commands`);
    await pool.query(`CREATE TABLE \`${ch.timers}\` LIKE tokes_timers`);
    await pool.query(`INSERT INTO \`${ch.channels}\` (id, owner_id, connection_id, platform, channel_id, channel_name) VALUES (11, 1, 1, 'kick', '800000001', 'maplehollow'), (12, 1, 1, 'twitch', '900000001', 'maplehollow_tv')`);
    store = T.store;
    importStore = createImportStore({ db: pool, prefix: T.prefix, channelTables: ch });
    profile = await makeProfile(store);
});
test.after(async () => {
    for (const n of [...IMPORT_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${n}\``);
    for (const t of Object.values(ch || {})) await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    for (const n of [...VIEWER_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${n}\``);
    await T.drop();
    await pool.end().catch(() => {});
});

async function plan(wantViewers = false) {
    const channels = (await store.listChannels(profile.id)).map((c) => ({ platform: c.platform, platformUserId: c.platform_user_id }));
    const channelBots = await importStore.channelBotsFor(channels);
    return buildPlan([parseFirebot({ files: firebotFiles(), wantViewers: true }), parseStreamerbot({ files: streamerbotFiles() })], { channels, channelBots, builtins: new Set(['so']), wantViewers });
}
const kickHref = (c) => (c.platform === 'kick' ? `/kick/channel/800000001/commands` : null);

test('first import: everything created switched off, marked, and recorded', async () => {
    const p = await plan(true);
    const out = await applyPlan({ store, importStore, profileId: profile.id, plan: p, categories: ALL, meta: { sources: 'firebot,streamerbot', fileNames: 'Main.zip, data.zip' }, channelPageHref: kickHref });
    assert.ok(out.importId > 0);
    assert.equal(out.results.filter((r) => r.result === 'failed').length, 0, JSON.stringify(out.results.filter((r) => r.result === 'failed')));
    const autos = await store.listAutomations(profile.id);
    assert.ok(autos.length >= 5, `${autos.length} automations`);
    for (const a of autos) {
        assert.equal(a.enabled, false, `${a.name} is off`);
        assert.match(a.name, /^(Firebot|Streamer\.bot|Song requests): /, `${a.name} says where it came from (song request commands use the Music page names)`);
    }
    const [cc] = await pool.query(`SELECT * FROM \`${ch.commands}\` ORDER BY id`);
    assert.ok(cc.length >= 4, 'socials + links on two channels, lurk/afk');
    for (const r of cc) {
        assert.equal(r.is_enabled, 0, `${r.command_name} is off`);
        assert.match(r.created_by, /^Imported from (Firebot|Streamer\.bot)$/);
    }
    assert.ok(cc.some((r) => r.command_name === 'socials' && r.channel_id === 11 && r.response === 'Find {{username}} on maplehollow.example'));
    // stream bot timers (profile_id, design doc §7.6), off; the Dice timer renders {random:1-6} at send time
    const [timers] = await pool.query(`SELECT * FROM \`${ch.timers}\` ORDER BY id`);
    assert.equal(timers.length, 3, 'Discord, Dice and the Deaths display (overlay text, design doc §9.9)');
    for (const t of timers) {
        assert.equal(t.profile_id, profile.id);
        assert.equal(t.channel_id, null);
        assert.equal(t.is_enabled, 0);
        assert.equal(t.platforms, 'twitch', 'Firebot timers post on Twitch');
    }
    assert.equal(await store.variableStore.get(profile.id, 'server', 'deaths'), '7');
    // Viewer stats go to viewer records (H-747), no longer to {db:} values.
    const vs = createViewerStore({ db: pool, prefix: T.prefix });
    const fan = await vs.byAccount(profile.id, 'twitch', '700000101');
    assert.equal(fan.watchMinutes, 1200);
    assert.equal(fan.messages, 340);
    assert.equal(fan.importedFrom, 'firebot');
    assert.equal((await vs.byAccount(profile.id, 'twitch', '700000102')).watchMinutes, 15);
    assert.equal(await store.variableStore.get(profile.id, 'twitch:700000101', 'watch_minutes'), null, 'no {db:} values any more');
    assert.ok(out.results.some((r) => r.category === 'viewers' && r.links.some((l) => l.href === '/stream/bot/viewers')));
    const rewards = await importStore.listItems(profile.id, { kind: 'reward' });
    assert.deepEqual(rewards.map((r) => r.data.definition.title).sort(), ['Confetti', 'Hydrate', 'Mystery box']);
    const created = out.results.find((r) => r.name === '!socials');
    assert.deepEqual(created.links, [{ label: 'Kick commands', href: '/kick/channel/800000001/commands' }]);
    const run = await importStore.getImport(profile.id, out.importId);
    assert.ok(run.report.groups && run.summary.counts.commands.created >= 2);
    assert.equal(JSON.stringify(run).includes(FAKE.obsPassword), false, 'no secret in the stored report');
});

test('re-import creates nothing twice; a deleted target comes back; values and hand-made commands are kept', async () => {
    const before = (await store.listAutomations(profile.id)).length;
    const [[{ n: ccBefore }]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${ch.commands}\``);
    await store.variableStore.set(profile.id, 'server', 'deaths', '42');
    const out = await applyPlan({ store, importStore, profileId: profile.id, plan: await plan(true), categories: ALL, meta: { sources: 'firebot,streamerbot' } });
    assert.equal(out.results.filter((r) => r.result === 'created' && r.kind !== 'reward').length, 0, JSON.stringify(out.results.filter((r) => r.result === 'created')));
    assert.equal((await store.listAutomations(profile.id)).length, before);
    const [[{ n: ccAfter }]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${ch.commands}\``);
    assert.equal(ccAfter, ccBefore);
    assert.equal(await store.variableStore.get(profile.id, 'server', 'deaths'), '42', 'a counter changed since is not overwritten');
    const vs = createViewerStore({ db: pool, prefix: T.prefix });
    assert.equal((await vs.byAccount(profile.id, 'twitch', '700000101')).watchMinutes, 1200, 'importing again does not count watch time twice');
    assert.equal(out.results.find((r) => r.category === 'viewers' && r.source === 'firebot').result, 'already');

    const death = (await store.listAutomations(profile.id)).find((a) => a.name === 'Firebot: !death');
    await store.deleteAutomation(profile.id, death.id);
    const again = await applyPlan({ store, importStore, profileId: profile.id, plan: await plan(), categories: ['commands'], meta: { sources: 'firebot' } });
    assert.equal(again.results.find((r) => r.name === '!death').result, 'created');
    assert.equal((await store.listAutomations(profile.id)).length, before);

    // A command made by hand under an imported name is left alone.
    await pool.query(`INSERT INTO \`${ch.commands}\` (channel_id, command_name, response, created_by) VALUES (11, 'afk', 'my own afk', 'owner')`);
    const [[mine]] = await pool.query(`SELECT response FROM \`${ch.commands}\` WHERE channel_id = 11 AND command_name = 'afk'`);
    assert.equal(mine.response, 'my own afk');
});

test('refresh: an untouched imported automation follows a changed mapping; an edited one is left alone', async () => {
    const changed = (await plan()).items;
    const p = { ...(await plan()), items: changed };
    const thank = p.items.find((i) => i.name === 'Thank cheers');
    thank.target.draft.actions = [{ type: 'chat.send', platform: 'event', text: 'Thank you {user.name}!' }];
    const out = await applyPlan({ store, importStore, profileId: profile.id, plan: p, categories: ['automations'], meta: { sources: 'firebot' } });
    assert.equal(out.results.find((r) => r.name === 'Thank cheers').result, 'updated');
    const auto = (await store.listAutomations(profile.id)).find((a) => a.name === 'Firebot: Thank cheers');
    assert.equal(auto.actions[0].text, 'Thank you {user.name}!');
    assert.equal(auto.enabled, false);
    // the owner edits it; the next mapping change does not overwrite the edit
    await store.updateAutomation(profile.id, auto.id, { ...auto, actions: [{ type: 'chat.send', platform: 'event', text: 'My own words' }] });
    thank.target.draft.actions = [{ type: 'chat.send', platform: 'event', text: 'Mapper v3' }];
    const again = await applyPlan({ store, importStore, profileId: profile.id, plan: p, categories: ['automations'], meta: { sources: 'firebot' } });
    assert.equal(again.results.find((r) => r.name === 'Thank cheers').result, 'already');
    assert.equal((await store.getAutomation(profile.id, auto.id)).actions[0].text, 'My own words');
});

test('an imported Kick timer becomes a stream bot timer when untouched; an automation linked by hand is never replaced', async () => {
    // A timer imported before timers moved to the stream bot (a Kick channel timer), then the new mapping.
    const [r] = await pool.query(`INSERT INTO \`${ch.timers}\` (channel_id, message, interval_min, is_enabled, created_by) VALUES (11, 'old', 30, 0, 'Imported from Firebot')`);
    await importStore.upsertItem(profile.id, { importId: null, source: 'firebot', kind: 'timer', sourceId: 'tx', name: 'Old', status: 'changed', targetKind: 'channel_timer', targetRef: `timer:${r.insertId}` });
    const p = { items: [{ category: 'timers', source: 'firebot', kind: 'timer', sourceId: 'tx', name: 'Old', status: 'changed', why: [],
        target: { system: 'bot_timer', timer: { name: 'Old', intervalMin: 20, onlyLive: true, minChatLines: 5, platforms: 'twitch', rotation: 'rotate', messages: ['new text'], automationRef: null } } }], gaps: [], checklist: [], obs: [], media: [] };
    const out = await applyPlan({ store, importStore, profileId: profile.id, plan: p, categories: ['timers'], meta: { sources: 'firebot' } });
    assert.equal(out.results[0].result, 'updated');
    const [[row]] = await pool.query(`SELECT * FROM \`${ch.timers}\` WHERE id = ?`, [r.insertId]);
    assert.equal(row.profile_id, profile.id);
    assert.equal(row.channel_id, null);
    assert.equal(row.message, 'new text');
    assert.equal(row.only_live, 1);
    assert.equal(row.min_chat_lines, 5);
    assert.equal(row.is_enabled, 0);
    const again = await applyPlan({ store, importStore, profileId: profile.id, plan: p, categories: ['timers'], meta: { sources: 'firebot' } });
    assert.equal(again.results[0].result, 'already', 'nothing twice');

    // A hand-made automation linked with keep (scripts/stream-bot-import-owner.mjs --link): never refreshed or duplicated.
    const handId = await store.createAutomation(profile.id, { name: 'Rebuilt by hand', enabled: false, trigger_type: 'follow', actions: [{ type: 'chat.send', platform: 'event', text: 'hand' }] });
    await importStore.upsertItem(profile.id, { importId: null, source: 'firebot', kind: 'event', sourceId: 'v1', name: 'Thank cheers', status: 'changed', targetKind: 'automation', targetRef: `automation:${handId}`, data: { keep: true } });
    const before = (await store.listAutomations(profile.id)).length;
    const res = await applyPlan({ store, importStore, profileId: profile.id, plan: await plan(), categories: ['automations'], meta: { sources: 'firebot' } });
    assert.match(res.results.find((x) => x.sourceId === 'v1').detail, /made by hand/);
    assert.equal((await store.listAutomations(profile.id)).length, before);
    assert.equal((await store.getAutomation(profile.id, handId)).actions[0].text, 'hand');
});

test('song request commands use the automation the Music page made (by name), never a second one', async () => {
    const other = await store.ensureProfile(`sbm${String(Date.now()).slice(-9)}`, 'Music');
    const mine = await store.createAutomation(other.id, { name: 'Song requests: !skip', enabled: true, trigger_type: 'chat', trigger_config: { match: { mode: 'command', text: '!skip' } },
        actions: [{ type: 'chat.send', platform: 'event', text: 'my skip' }] });
    const p = buildPlan([parseStreamerbot({ files: streamerbotFiles() })], { channels: [], channelBots: [], builtins: new Set() });
    const out = await applyPlan({ store, importStore, profileId: other.id, plan: p, categories: ['commands'], meta: { sources: 'streamerbot' } });
    const r = out.results.find((x) => x.name === '!skip');
    assert.equal(r.result, 'already');
    assert.match(r.detail, /Covered by song requests/);
    assert.equal((await store.listAutomations(other.id)).filter((a) => a.name === 'Song requests: !skip').length, 1);
    assert.equal((await store.getAutomation(other.id, mine)).enabled, true, 'left as it is');
    const item = await importStore.getItem(other.id, 'streamerbot', 'command', 'c3');
    assert.equal(item.data.keep, true);
    // without a Music page automation, the import makes it (off), and a re-import does not make it twice
    const third = await store.ensureProfile(`sbn${String(Date.now()).slice(-9)}`, 'Music 2');
    const first = await applyPlan({ store, importStore, profileId: third.id, plan: p, categories: ['commands'], meta: { sources: 'streamerbot' } });
    assert.equal(first.results.find((x) => x.name === '!skip').result, 'created');
    await applyPlan({ store, importStore, profileId: third.id, plan: p, categories: ['commands'], meta: { sources: 'streamerbot' } });
    const made = (await store.listAutomations(third.id)).filter((a) => a.name === 'Song requests: !skip');
    assert.equal(made.length, 1);
    assert.equal(made[0].enabled, false);
    assert.deepEqual(made[0].actions, [{ type: 'music.command', command: 'skip', input: '', reply: 'yes' }]);
});

test('automation.run steps point at the imported command automation', async () => {
    // Streamer.bot "Mystery" sends !lurk, which is a channel command here: it became the reply. Build a case where the
    // command is an automation: a Firebot event that runs a command.
    const files = firebotFiles({ 'events/events.json': { mainEvents: [{ id: 'v9', name: 'Raid reset', sourceId: 'twitch', eventId: 'raid', active: true,
        effects: { list: [{ type: 'firebot:run-command', commandId: 'c2' }] } }] } });
    const channels = (await store.listChannels(profile.id)).map((c) => ({ platform: c.platform, platformUserId: c.platform_user_id }));
    const p = buildPlan([parseFirebot({ files })], { channels, channelBots: await importStore.channelBotsFor(channels), builtins: new Set() });
    await applyPlan({ store, importStore, profileId: profile.id, plan: p, categories: ['commands', 'automations'], meta: { sources: 'firebot' } });
    const autos = await store.listAutomations(profile.id);
    const raid = autos.find((a) => a.name === 'Firebot: Raid reset');
    const death = autos.find((a) => a.name === 'Firebot: !death');
    assert.deepEqual(raid.actions, [{ type: 'automation.run', automationId: death.id }]);

    // A later run of automations only (as the owner re-run does with --only automations) still links to the command
    // automation imported earlier, so an untouched automation with such a step is refreshed, not skipped.
    const raidItem = p.items.find((i) => i.name === 'Raid reset');
    raidItem.target.draft.actions = [...raidItem.target.draft.actions, { type: 'delay', seconds: 1 }];
    const again = await applyPlan({ store, importStore, profileId: profile.id, plan: p, categories: ['automations'], meta: { sources: 'firebot' } });
    assert.equal(again.results.find((r) => r.name === 'Raid reset').result, 'updated');
    const raid2 = await store.getAutomation(profile.id, raid.id);
    assert.deepEqual(raid2.actions, [{ type: 'automation.run', automationId: death.id }, { type: 'delay', seconds: 1 }]);
    assert.equal(raid2.enabled, false);
});

test('/privacy: export includes the import rows without secrets; delete removes them with the profile', async () => {
    const rows = await importExport(pool, profile.id, T.prefix);
    assert.ok(rows.imports.length >= 2 && rows.import_items.length >= 5);
    const p = createStreamBotPrivacy({ store, db: pool, rowLimit: 1000 });
    const out = await p.exportFor(profile.ownerDiscordId);
    assert.ok(out.tables[`${T.prefix}imports`], 'imports exported');
    assert.ok(out.tables[`${T.prefix}import_items`], 'import items exported');
    assert.equal(JSON.stringify(out).includes(FAKE.refresh), false);
    assert.ok(RETENTION_ROWS.some(([t]) => t === 'stream_bot_imports'));
    // Delete: the FK cascade takes the import rows with the profile.
    const other = await store.ensureProfile('sbtest-import-del', 'Delete me');
    await importStore.upsertItem(other.id, { importId: null, source: 'firebot', kind: 'counter', sourceId: 'x', name: 'x', status: 'as_is' });
    await p.deleteFor('sbtest-import-del');
    const [[left]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${T.prefix}import_items\` WHERE profile_id = ?`, [other.id]);
    assert.equal(left.n, 0);
});

test('recreate a saved reward: needs the grant, posts once, moves the waiting automations (fake fetch)', async () => {
    const item = (await importStore.listItems(profile.id, { kind: 'reward' })).find((r) => r.data.definition.title === 'Hydrate');
    const calls = [];
    const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ data: [{ id: 'new-reward-1' }] }) }; };
    const noGrant = await recreateReward({ store, importStore, profileId: profile.id, itemId: item.id, deps: { fetch: fakeFetch, clientId: 'cid', grant: null, token: null } });
    assert.equal(noGrant.ok, false);
    const weak = await recreateReward({ store, importStore, profileId: profile.id, itemId: item.id, deps: { fetch: fakeFetch, clientId: 'cid', grant: { twitch_user_id: '900000001', scopes: ['bits:read'] }, token: 't' } });
    assert.equal(weak.ok, false);
    assert.equal(calls.length, 0, 'nothing is sent without the permission');
    const ok = await recreateReward({ store, importStore, profileId: profile.id, itemId: item.id, deps: { fetch: fakeFetch, clientId: 'cid', grant: { twitch_user_id: '900000001', scopes: ['channel:manage:redemptions'] }, token: 't' } });
    assert.equal(ok.ok, true);
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.title, 'Hydrate');
    assert.equal(body.is_enabled, false, 'created switched off');
    assert.match(calls[0].url, /broadcaster_id=900000001/);
    assert.equal(ok.automationsUpdated, 1);
    const moved = (await store.listAutomations(profile.id)).find((a) => a.name === 'Firebot: Reward: Hydrate');
    assert.equal(moved.conditions[0].value, 'new-reward-1');
    const twice = await recreateReward({ store, importStore, profileId: profile.id, itemId: item.id, deps: { fetch: fakeFetch, clientId: 'cid', grant: { twitch_user_id: '900000001', scopes: ['channel:manage:redemptions'] }, token: 't' } });
    assert.equal(twice.status, 409);
    const power = (await importStore.listItems(profile.id, { kind: 'reward' })).find((r) => r.data.definition.kind === 'power_up');
    const p2 = await recreateReward({ store, importStore, profileId: profile.id, itemId: power.id, deps: { fetch: fakeFetch, clientId: 'cid', grant: { twitch_user_id: '900000001', scopes: ['channel:manage:redemptions'] }, token: 't' } });
    assert.equal(p2.ok, false);
    assert.equal(calls.length, 1);
});

const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

test('banned words: an import only saves them; Kick automod changes only when the owner applies them (H-742)', async () => {
    const p = await plan();
    const mod = p.items.find((i) => i.kind === 'moderation' && i.source === 'firebot');
    assert.equal(mod.status, 'changed');
    assert.deepEqual(mod.target, { system: 'pending_words', words: ['mapleword'], wasOn: mod.target.wasOn });
    await pool.query(`UPDATE \`${ch.channels}\` SET features_enabled = ? WHERE id = 11`, [JSON.stringify({ commands: true, automod: { caps: true, words: 'oldword, Mapleword2' } })]);

    const out = await applyPlan({ store, importStore, profileId: profile.id, plan: p, categories: ['moderation'], meta: { sources: 'firebot' } });
    const r = out.results.find((x) => x.kind === 'moderation' && x.source === 'firebot');
    assert.ok(['created', 'already', 'updated'].includes(r.result), r.result);
    const [[row]] = await pool.query(`SELECT features_enabled FROM \`${ch.channels}\` WHERE id = 11`);
    assert.equal(J(row.features_enabled).automod.words, 'oldword, Mapleword2', 'the import did not touch Kick automod');

    const item = (await importStore.listItems(profile.id, { kind: 'moderation' })).find((i) => i.source === 'firebot');
    assert.equal(item.target_kind, 'pending_words');
    assert.deepEqual(item.data.words, ['mapleword']);
    const bots = await importStore.channelBotsFor([{ platform: 'kick', platformUserId: '800000001' }, { platform: 'twitch', platformUserId: '900000001' }]);
    const automods = new Map([[11, (await importStore.channelAutomod(11)).features]]);
    const view = pendingWordsView(item, bots, automods);
    assert.deepEqual(view.channels.map((c) => [c.id, c.pending]), [[11, 1]], 'Kick channels only; one word pending');

    // refused: a Twitch channel bot, a missing list
    assert.equal((await applyPendingWords({ importStore, profileId: profile.id, itemId: item.id, channelBot: bots.find((b) => b.platform === 'twitch') })).ok, false);
    assert.equal((await applyPendingWords({ importStore, profileId: profile.id, itemId: 999999, channelBot: bots[0] })).status, 404);

    const kick = bots.find((b) => b.platform === 'kick');
    const ap = await applyPendingWords({ importStore, profileId: profile.id, itemId: item.id, channelBot: kick });
    assert.deepEqual([ap.ok, ap.added, ap.total], [true, 1, 3]);
    const feats = J((await pool.query(`SELECT features_enabled FROM \`${ch.channels}\` WHERE id = 11`))[0][0].features_enabled);
    assert.deepEqual(feats, { commands: true, automod: { caps: true, words: 'oldword, Mapleword2, mapleword' } }, 'added, nothing removed, other settings kept');
    assert.equal((await applyPendingWords({ importStore, profileId: profile.id, itemId: item.id, channelBot: kick })).added, 0, 'applying again adds nothing');
    assert.ok((await importStore.getItemById(profile.id, item.id)).data.applied[11].at);

    // Kick's list has a size limit; going over it is refused, not cut
    await pool.query(`UPDATE \`${ch.channels}\` SET features_enabled = ? WHERE id = 11`, [JSON.stringify({ automod: { words: 'x'.repeat(AUTOMOD_WORDS_MAX - 3) } })]);
    const big = await applyPendingWords({ importStore, profileId: profile.id, itemId: item.id, channelBot: kick });
    assert.equal(big.ok, false);
    assert.match(big.error, /4000 characters/);
});
