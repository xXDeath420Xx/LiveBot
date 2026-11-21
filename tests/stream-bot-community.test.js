import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../utils/db.js';
import { makeTables, makeProfile, fakeEncryption } from './fixtures/stream-bot-tables.js';
import { viewersDdl, VIEWER_TABLES } from '../migrations/464_stream_bot_viewers.js';
import { communityDdl, COMMUNITY_TABLES, RETENTION_ROWS } from '../migrations/475_stream_bot_community.js';
import { createViewerStore } from '../core/stream-bot/viewers/store.js';
import { createViewerService } from '../core/stream-bot/viewers/service.js';
import {
    gamesWithDefaults, validateGames, ttsWithDefaults, mediaWithDefaults, validateMedia, youtubeVideoId, spin, slotsResult, slotsNet, heistOutcome, drawRaffle, cleanSymbols,
} from '../core/stream-bot/community/settings.js';
import { maskProfanity, speakable, prepareSpeech, BUILT_IN_COUNT } from '../core/stream-bot/community/speech.js';
import { createCommunityStore } from '../core/stream-bot/community/store.js';
import { createQuotes, formatQuote } from '../core/stream-bot/community/quotes.js';
import { createGames, GAME_KEYS } from '../core/stream-bot/community/games.js';
import { createShop, validateItem, pickItem } from '../core/stream-bot/community/shop.js';
import { createMediaShare, isMediaKeyShape } from '../core/stream-bot/community/media.js';
import { registerCommunity, communityActions, setVoiceOptions, STORE_REDEEMED } from '../core/stream-bot/community/register.js';
import { commandDrafts, seedCommands, GROUPS } from '../core/stream-bot/community/seed.js';
import { communityExport, communityDelete } from '../core/stream-bot/community/privacy.js';
import { createStreamBotPrivacy } from '../core/stream-bot/privacy.js';
import { STREAM_BOT_SCOPES, FORBIDDEN_SCOPES } from '../core/stream-bot/scopes.js';
import { importDdl, IMPORT_TABLES } from '../migrations/455_stream_bot_imports.js';
import { createImportStore, applyPlan } from '../core/stream-bot/import/apply.js';
import { buildPlan } from '../core/stream-bot/import/mapper.js';
import { parseStreamerbot } from '../core/stream-bot/import/streamerbot.js';
import { parseFirebot } from '../core/stream-bot/import/firebot.js';
import * as actionsMod from '../core/stream-bot/actions.js';
import * as eventsMod from '../core/stream-bot/events.js';
import * as renderMod from '../core/stream-bot/render.js';
import { createEngine } from '../core/stream-bot/engine.js';
import { createLimiter, validateConditions, validateTrigger } from '../core/stream-bot/conditions.js';

/*
 * Wave 2 group B (core/stream-bot/community, migration 475) on throwaway tables (sbtc…_): the settings and games maths, the
 * profanity mask, quotes (commands, roles, imports land off), chat games on points (slots, duels, heists, the line-up,
 * raffles paid at the draw), the loyalty store (stock, limits, cooldown, strict points, refunds, the item's automation and
 * the redeemed trigger), media share (YouTube only, length limit, approval, the hand-off to the VOD-safe song queue, refunds,
 * status sweep), text to speech on the Media Share page, the engine hooks through the real engine, seeding and /privacy.
 */

let T, store, vs, vsvc, cs, profile;
const clock = { t: Date.parse('2026-11-20T20:00:00Z') };
const now = () => clock.t;
const TW = '900000001';
const fan = { id: '100000001', login: 'maplefan_88', name: 'MapleFan_88', roles: ['subscriber'] };
const wren = { id: '100000002', login: 'wren_reads', name: 'Wren_Reads', roles: [] };
const mod = { id: '100000003', login: 'mod_moss', name: 'Mod_Moss', roles: ['moderator'] };
const sent = [];
const fakeIo = {
    async channelsFor() { return [{ platform: 'twitch', platform_user_id: TW, login: 'maplehollow_tv', display_name: 'MapleHollow_TV' }, { platform: 'kick', platform_user_id: '800000001', login: 'maplehollow' }]; },
    async sendChat(m) { sent.push(m); return { ok: true }; },
    async streamInfo() { return { live: true, category: 'Stardew Valley' }; },
};
const chat = (user, message, platform = 'twitch') => ({ platform, type: 'chat', channelId: TW, user, message, amount: null, currency: null, metadata: {}, occurredAt: new Date(now()) });
const input = (ev) => String(ev.message).split(/\s+/).slice(1).join(' ');
const pts = async (u, platform = 'twitch') => (await vs.person(profile.id, (await vs.byAccount(profile.id, platform, u.id)).id)).points;
async function give(u, n) {
    const row = (await vs.byAccount(profile.id, 'twitch', u.id)) || (await vs.seen(profile.id, 'twitch', [u], { when: new Date(now()) }))[0].row;
    await vsvc.changePoints(profile.id, row.id, n, { mode: 'set', kind: 'edit', note: 'test' });
}

test.before(async () => {
    T = await makeTables(pool, 'c');
    for (const sql of viewersDdl(T.prefix)) await pool.query(sql);
    for (const sql of communityDdl(T.prefix)) await pool.query(sql);
    for (const sql of importDdl(T.prefix)) await pool.query(sql);
    store = T.store;
    profile = await makeProfile(store);
    vs = createViewerStore({ db: pool, prefix: T.prefix, now });
    vsvc = createViewerService({ db: pool, store, vstore: vs, io: fakeIo, now, rng: () => 0.1 });
    cs = createCommunityStore({ db: pool, prefix: T.prefix, now });
    for (const u of [fan, wren, mod]) await give(u, 1000);
});
test.after(async () => {
    for (const n of [...IMPORT_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${n}\``);
    for (const n of [...COMMUNITY_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${n}\``);
    for (const n of [...VIEWER_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${n}\``);
    await T.drop();
    await pool.end().catch(() => {});
});

// ── pure ────────────────────────────────────────────────────────────────────────────────────

test('settings: games, speech and media share defaults are off and cleaned; YouTube ids; slots, heist and raffle maths', () => {
    const g = gamesWithDefaults(null);
    assert.deepEqual([g.slots.enabled, g.duel.enabled, g.heist.enabled], [false, false, false], 'every game starts off');
    const c = gamesWithDefaults({ slots: { min: 50, max: 10, symbols: ['A', 'A', 'B'], payout2: 20, payout3: 5 }, heist: { target: 'moon' } });
    assert.equal(c.slots.max, 50);
    assert.equal(c.slots.symbols.length, 5, 'fewer than 3 different symbols: the defaults');
    assert.equal(c.slots.payout2, 5, 'two never pays more than three');
    assert.equal(c.heist.target, 'easy');
    assert.equal(validateGames({ slots: { symbols: 'A\nA', min: 5, max: 1, payout2: 9, payout3: 2 } }).errors.length, 3);
    assert.deepEqual(cleanSymbols('Kappa\n<b>\nLUL\nKappa'), ['Kappa', 'LUL']);
    assert.deepEqual(ttsWithDefaults({ voice: '../x', maxChars: 9999, volume: -4 }), { voice: 'ryan', mask: true, words: [], maxChars: 400, volume: 0, readNames: true });
    assert.deepEqual(mediaWithDefaults(null), { open: false, approval: 'all', maxSeconds: 180, maxPerUser: 2, maxQueue: 20, cost: 0, showCard: true });
    assert.equal(validateMedia({ approval: 'everyone' }).ok, false);
    for (const [u, id] of [['https://youtu.be/dQw4w9WgXcQ?t=3', 'dQw4w9WgXcQ'], ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x', 'dQw4w9WgXcQ'], ['https://youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
        ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'], ['https://www.youtube.com/playlist?list=PL123', null], ['https://evil.example/watch?v=dQw4w9WgXcQ', null], ['javascript:alert(1)', null]]) {
        assert.equal(youtubeVideoId(u), id, u);
    }
    const s = gamesWithDefaults({ slots: { payout3: 10, payout2: 1.5 } });
    assert.deepEqual(spin(['A', 'B', 'C'], () => 0), ['A', 'A', 'A']);
    assert.deepEqual(slotsResult(['A', 'A', 'A'], s), { kind: 'three', multiplier: 10 });
    assert.equal(slotsResult(['A', 'B', 'A'], s).kind, 'two');
    assert.equal(slotsResult(['A', 'B', 'C'], s).multiplier, 0);
    assert.equal(slotsNet(100, 1.5), 50);
    assert.equal(slotsNet(100, 0), -100);
    const h = heistOutcome([{ key: 'a', bet: 100 }, { key: 'b', bet: 50 }], { heist: { target: 'easy' } }, (() => { const r = [0.01, 0.99]; return () => r.shift(); })());
    assert.equal(h.target, 'Corner Store');
    assert.deepEqual(h.results.map((r) => [r.escaped, r.net]), [[true, 60], [false, -50]]);
    const w = drawRaffle([{ key: 'a', tickets: 1 }, { key: 'b', tickets: 9 }, { key: 'c', tickets: 0 }], 5, () => 0.5);
    assert.deepEqual(w.map((x) => x.key).sort(), ['a', 'b'], 'never twice, never someone with no tickets');
});

test('speech: built-in and own words bleeped through lookalikes; links, markup and length handled', () => {
    assert.ok(BUILT_IN_COUNT >= 30);
    assert.equal(maskProfanity('well sh1t that was fun'), 'well bleep that was fun');
    assert.equal(maskProfanity('what the FUCKING hell'), 'what the bleep hell');
    assert.equal(maskProfanity('a cockpit and a scrapbook'), 'a cockpit and a scrapbook', 'whole words only where the list says so');
    assert.equal(maskProfanity('you noobs', { extra: ['noob*'] }), 'you bleep');
    assert.equal(maskProfanity('sh1t', { enabled: false }), 'sh1t');
    assert.equal(speakable('see https://x.dev/a <b>now</b> {x}', 200), 'see a link now x');
    assert.equal(prepareSpeech('shit '.repeat(100), { maxChars: 20 }).length <= 20, true);
});

test('migration: four tables; redemptions 400 days and media requests 90 days', () => {
    assert.deepEqual(COMMUNITY_TABLES, ['quotes', 'store_items', 'store_redemptions', 'media_requests']);
    assert.deepEqual(RETENTION_ROWS.map((r) => [r[0], r[1], r[2]]), [['stream_bot_store_redemptions', 'created_at', 400], ['stream_bot_media_requests', 'created_at', 90]]);
    assert.ok(communityDdl('x_').every((s) => s.includes('ON DELETE CASCADE')));
});

// ── quotes ──────────────────────────────────────────────────────────────────────────────────

test('quotes: !addquote for mods and VIPs with the game, !quote by number, word and at random, !delquote; imports land off', async () => {
    const qs = createQuotes({ cstore: cs, io: fakeIo });
    const P = profile;
    const run = (u, msg, cmd) => qs.run(P, cmd, { ev: chat(u, msg), input: input(chat(u, msg)) });
    assert.equal((await run(wren, '!addquote hello', 'addquote')).reply, null, 'a viewer may not add');
    assert.equal((await run(mod, '!addquote @Wren_Reads "I love bees"', 'addquote')).reply, 'Added quote #1.');
    assert.equal((await run(mod, '!addquote the cow says moo', 'addquote')).reply, 'Added quote #2.');
    const q1 = await cs.quoteByNumber(P.id, 1);
    assert.deepEqual([q1.text, q1.saidBy, q1.game, q1.addedById], ['I love bees', 'Wren_Reads', 'Stardew Valley', mod.id]);
    assert.equal((await cs.quoteByNumber(P.id, 2)).saidBy, 'MapleHollow_TV', 'no @name: the channel said it');
    assert.match((await run(wren, '!quote 1', 'quote')).reply, /^Quote #1: "I love bees" \(Wren_Reads, Stardew Valley, \d{1,2} \w{3} \d{4}\)$/);
    assert.match((await run(wren, '!quote moo', 'quote')).reply, /^Quote #2: "the cow says moo"/);
    assert.equal((await run(wren, '!quote 99', 'quote')).reply, 'There is no quote #99.');
    assert.equal((await run(wren, '!delquote 2', 'delquote')).reply, null, 'a viewer may not delete');
    assert.equal((await run(mod, '!delquote 2', 'delquote')).reply, 'Deleted quote #2.');
    const imp = await cs.importQuotes(P.id, 'streamerbot', [{ sourceId: '7', text: 'imported line', author: 'Someone', game: 'Minecraft', createdAt: '2025-01-02T03:04:05Z' }, { sourceId: '8', text: '' }]);
    assert.deepEqual(imp, { created: 1, existing: 0, skipped: 1 });
    assert.deepEqual(await cs.importQuotes(P.id, 'streamerbot', [{ sourceId: '7', text: 'imported line' }]), { created: 0, existing: 1, skipped: 0 }, 'never twice');
    const off = (await cs.listQuotes(P.id)).find((x) => x.importedFrom === 'streamerbot');
    assert.equal(off.enabled, false, 'imports land switched off');
    assert.equal((await run(wren, '!quote imported', 'quote')).reply, 'No quote mentions "imported".', 'chat does not see them');
    assert.equal(await cs.enableImportedQuotes(P.id), 1);
    assert.match((await run(wren, '!quote imported', 'quote')).reply, /^Quote #\d+: "imported line" \(Someone, Minecraft, 2 Jan 2025\)$/);
    assert.equal(formatQuote(null), '');
});

// ── games ───────────────────────────────────────────────────────────────────────────────────

test('games: off until turned on; slots win and lose; duels; heists settle at the end; the line-up; raffles paid at the draw', async () => {
    const P = profile;
    const viewersRef = { current: { service: vsvc, vstore: vs } };
    let r0 = 0;
    const seq = [];
    const rng = () => (seq.length ? seq.shift() : r0);
    const g = createGames({ store, viewersRef, io: fakeIo, now, rng, timers: false });
    const run = (u, msg, cmd) => g.run(P, cmd, { ev: chat(u, msg), input: input(chat(u, msg)) });
    assert.deepEqual(GAME_KEYS, ['slots', 'duel', 'accept', 'decline', 'heist', 'join', 'leave', 'lineup', 'ticket', 'raffle']);
    assert.equal((await run(fan, '!slots 100', 'slots')).reply, 'Slots are turned off on this channel.');
    await g.saveSettings(P.id, { slots: { enabled: true, symbols: ['A', 'B', 'C'], payout3: 10, payout2: 1.5 }, duel: { enabled: true }, heist: { enabled: true, joinSec: 30, cooldownMin: 5 } });
    await give(fan, 1000); await give(wren, 1000);
    r0 = 0;   // A A A
    assert.equal((await run(fan, '!slots 100', 'slots')).reply, 'MapleFan_88 spun A | A | A and won 900 points (now 1,900).');
    seq.push(0, 0.4, 0.8);   // A B C
    assert.equal((await run(fan, '!slots 100', 'slots')).reply, 'MapleFan_88 spun A | B | C and lost 100 points (now 1,800).');
    assert.match((await run(fan, '!slots 5000', 'slots')).reply, /^Bet 10 to 1,000 points/);
    // duels: the challenger's 50/50 roll; the winner takes the bet
    assert.equal((await run(fan, '!duel @maplefan_88 10', 'duel')).reply, 'You cannot duel yourself.');
    assert.match((await run(fan, '!duel @wren_reads 200', 'duel')).reply, /^Wren_Reads, MapleFan_88 challenges you to a duel for 200 points\./);
    assert.match((await run(wren, '!duel @maplefan_88 5', 'duel')).reply, /^Bet 10 to 10,000 points/);
    assert.match((await run(wren, '!duel @maplefan_88 20', 'duel')).reply, /^MapleFan_88, Wren_Reads challenges you/);
    seq.push(0.9);   // the challenged one wins
    assert.equal((await run(wren, '!accept', 'accept')).reply, 'Wren_Reads won the duel against MapleFan_88 and takes 200 points.');
    assert.deepEqual([await pts(fan), await pts(wren)], [1600, 1200]);
    assert.equal((await run(fan, '!decline', 'decline')).reply, 'MapleFan_88 declined the duel with Wren_Reads.');
    // heists: nobody pays when joining; the end settles everyone
    assert.match((await run(fan, '!heist 100', 'heist')).reply, /^MapleFan_88 is planning a heist on the Corner Store\. Join with !heist <amount> in the next 30 seconds\.$/);
    assert.equal((await run(wren, '!heist 50', 'heist')).reply, 'Wren_Reads joined the heist with 50 points (2 in the crew).');
    assert.equal((await run(wren, '!heist 50', 'heist')).reply, 'Wren_Reads, you are already in this heist.');
    assert.equal(await pts(fan), 1600, 'nothing taken yet');
    seq.push(0.01, 0.99);   // fan escapes, wren is caught
    const out = await g.finishHeist(P.id);
    assert.match(out.text, /^The heist on the Corner Store is over: 1 of 2 got away\. MapleFan_88 \(\+60\)\. Caught: Wren_Reads \(-50\)\.$/);
    assert.deepEqual([await pts(fan), await pts(wren)], [1660, 1150]);
    assert.match((await run(fan, '!heist 100', 'heist')).reply, /^The crew is lying low/);
    assert.ok(sent.some((m) => m.text === out.text), 'announced in chat');
    // the line-up
    assert.equal((await run(fan, '!join', 'join')).reply, 'The line-up is closed.');
    assert.equal((await run(wren, '!lineup open', 'lineup')).reply, null, 'only moderators open it');
    assert.equal((await run(mod, '!lineup open', 'lineup')).reply, 'The line-up is open: type !join to get in.');
    assert.equal((await run(wren, '!join', 'join')).reply, 'Wren_Reads joined the line-up at #1.');
    await g.saveSettings(P.id, { ...(await g.settingsOf(P.id)), lineup: { subsFirst: true } });
    assert.equal((await run(fan, '!join', 'join')).reply, 'MapleFan_88 joined the line-up at #1.', 'subscribers first');
    assert.match((await run(wren, '!lineup', 'lineup')).reply, /^Line-up \(2\): 1\. MapleFan_88, 2\. Wren_Reads\. You are #2\.$/);
    assert.equal((await run(mod, '!lineup next', 'lineup')).reply, 'Up next: MapleFan_88.');
    assert.equal((await run(wren, '!leave', 'leave')).reply, 'Wren_Reads left the line-up.');
    // raffles: tickets checked when bought, paid at the draw
    assert.equal((await run(fan, '!ticket', 'ticket')).reply, 'No raffle is open right now.');
    assert.match((await run(mod, '!raffle open 100 1', 'raffle')).reply, /^A raffle is open: 100 points a ticket, up to 10 each, 1 winner\./);
    assert.equal((await run(fan, '!ticket 3', 'ticket')).reply, 'MapleFan_88 has 3 tickets (300 points, paid at the draw).');
    assert.equal((await run(wren, '!ticket 20', 'ticket')).reply, 'Wren_Reads has 10 tickets (1,000 points, paid at the draw).');
    await give(wren, 500);   // can no longer pay for 10
    r0 = 0;
    const d = await g.raffle.draw(P, 'test');
    assert.deepEqual([d.winners, d.entries], [['MapleFan_88'], 1], 'unpaid tickets are void');
    assert.deepEqual([await pts(fan), await pts(wren)], [1360, 500]);
    g.close();
});

// ── the loyalty store ───────────────────────────────────────────────────────────────────────

test('store: items validated; redeem takes stock and points strictly, keeps limits and cooldowns, runs the item automation, raises the trigger; refunds', async () => {
    const P = profile;
    assert.equal(validateItem({ name: '', cost: -1 }).errors.length, 2);
    assert.equal(validateItem({ name: 'Hydrate', cost: 5, automationId: 77 }, { automationIds: new Set([1]) }).ok, false);
    const ok = validateItem({ name: '  Hydrate ', cost: '500', stock: '2', perUserLimit: '1', limitWindow: 'day', cooldownSec: '30', enabled: true });
    assert.deepEqual([ok.value.name, ok.value.cost, ok.value.stock, ok.value.perUserLimit], ['Hydrate', 500, 2, 1]);
    const autoId = await store.createAutomation(P.id, { name: 'Store: hydrate text', enabled: false, trigger_type: 'chat', trigger_config: { match: { mode: 'command', text: '!never' } }, conditions: [], actions: [{ type: 'chat.send', platform: 'event', text: 'drink {args.item}' }] });
    const a = await cs.saveItem(P.id, null, { ...ok.value, automationId: autoId });
    const b = await cs.saveItem(P.id, null, { ...validateItem({ name: 'Free hug', cost: 0 }).value });
    assert.equal((await cs.saveItem(P.id, null, ok.value)).error, 'name_taken');
    const items = await cs.listItems(P.id, { enabledOnly: true });
    assert.equal(pickItem(items, 'hydr')?.name, 'Hydrate');
    assert.equal(pickItem(items, '2')?.name, 'Hydrate', 'numbers follow the !store order (cost)');
    const ran = [];
    const raised = [];
    const engineRef = { current: { async runAutomation(profile, automation, ev, o) { ran.push({ automation: automation.id, o }); return { runId: 1, status: 'ok' }; } } };
    const shop = createShop({ cstore: cs, store, viewersRef: { current: { service: vsvc, vstore: vs } }, engineRef, ingest: { async internal(pid, ev) { raised.push(ev); return 1; } }, now });
    const run = (u, msg, cmd) => shop.run(P, cmd, { ev: chat(u, msg), input: input(chat(u, msg)) });
    assert.equal((await run(wren, '!store', 'list')).reply, 'Store (points): 1. Free hug (0), 2. Hydrate (500). Redeem with !redeem <name or number>.');
    await give(wren, 300);
    assert.equal((await run(wren, '!redeem hydrate', 'redeem')).reply, 'Wren_Reads, Hydrate costs 500 points and you have 300.');
    await give(wren, 1200);
    assert.equal((await run(wren, '!redeem hydrate', 'redeem')).reply, 'Wren_Reads redeemed Hydrate for 500 points.');
    assert.equal(await pts(wren), 700);
    assert.equal((await cs.getItem(P.id, a.id)).stock, 1);
    assert.equal(ran[0].automation, autoId);
    assert.equal(ran[0].o.manual, true, 'runs even while switched off');
    assert.equal(ran[0].o.vars['args.item'], 'Hydrate');
    assert.deepEqual([raised[0].type, raised[0].platform, raised[0].metadata.item, raised[0].user.id], ['store.redeemed', 'bot', 'Hydrate', wren.id]);
    assert.match((await run(fan, '!redeem hydrate', 'redeem')).reply, /^Hydrate can be redeemed again in 30 seconds\.$/);
    clock.t += 31_000;
    assert.equal((await run(wren, '!redeem hydrate', 'redeem')).reply, 'Wren_Reads, you have redeemed Hydrate the most times allowed today.');
    assert.equal((await run(fan, '!redeem hydrate', 'redeem')).reply, 'MapleFan_88 redeemed Hydrate for 500 points.');
    clock.t += 31_000;
    assert.equal((await run(mod, '!redeem hydrate', 'redeem')).reply, 'Hydrate is sold out.');
    assert.equal((await run(mod, '!redeem free', 'redeem')).reply, 'Mod_Moss redeemed Free hug.');
    assert.match((await run(mod, '!redeem pizza', 'redeem')).reply, /^There is no "pizza" in the store\./);
    const list = await cs.listRedemptions(P.id);
    const wrenRed = list.find((x) => x.platformUserId === wren.id);
    assert.deepEqual(await shop.refund(P, wrenRed.id, 'test'), { ok: true });
    assert.equal((await shop.refund(P, wrenRed.id, 'test')).ok, false, 'only once');
    assert.equal(await pts(wren), 1200);
    assert.equal((await cs.getItem(P.id, a.id)).stock, 1, 'back in stock');
    await cs.deleteItem(P.id, b.id);
});

// ── media share and speech ──────────────────────────────────────────────────────────────────

test('media share: YouTube only, length and per-viewer limits, approval, the hand-off to the song queue, refunds, the status sweep; speech on the page', async () => {
    const P = profile;
    const requests = new Map();
    let nextId = 500;
    const nudged = [];
    const lookups = [];
    const music = {
        mstore: {
            async insertRequest(pid, r) { const id = nextId++; requests.set(id, { ...r, id, status: r.status }); return id; },
            async getRequest(pid, id) { return requests.get(id) || null; },
        },
        service: {
            resolver: { async lookup(parsed) { lookups.push(parsed); const long = /LongLongLng/.test(parsed.url); return { ok: true, items: [{ source: 'youtube', title: long ? 'Long one' : 'Cat video', artist: 'Cats Ltd', url: parsed.url, durationMs: long ? 3_600_000 : 95_000, thumbnail: null }] }; } },
            player: { nudge: async (pid) => { nudged.push(pid); }, nowPlaying: () => (current ? { playId: 'p1', requestId: current, positionMs: 12_000, paused: false } : null) },
            async decideById(pid, id, action) { if (requests.has(id)) requests.get(id).status = 'removed'; return { ok: true }; },
            gateOf: () => ({ vodSafe: true }),
        },
    };
    let current = null;
    const spoken = [];
    const m = createMediaShare({ store, db: pool, cstore: cs, musicRef: { current: music }, viewersRef: { current: { service: vsvc, vstore: vs } }, encryption: fakeEncryption,
        synthesize: async (text, voice) => { spoken.push([text, voice]); return Buffer.from('RIFFwav'); }, now, timers: false });
    const run = (u, msg, cmd) => m.run(P, cmd, { ev: chat(u, msg), input: input(chat(u, msg)) });
    assert.equal((await run(fan, '!media https://youtu.be/dQw4w9WgXcQ', 'request')).reply, 'MapleFan_88, media share is closed right now.');
    await m.saveSettings(P.id, { open: true, approval: 'all', maxSeconds: 120, maxPerUser: 1, cost: 50 });
    assert.match((await run(fan, '!media https://evil.example/x', 'request')).reply, /send a YouTube video link/);
    assert.match((await run(fan, '!media https://youtu.be/LongLongLng', 'request')).reply, /too long: the longest allowed is 2 min/);
    await give(fan, 1000);
    assert.match((await run(fan, '!media https://youtu.be/dQw4w9WgXcQ', 'request')).reply, /^MapleFan_88, "Cat video" is waiting for a moderator \(1 waiting\)\.$/);
    assert.equal(await pts(fan), 950, 'the cost is taken when asking');
    assert.match((await run(fan, '!media https://youtu.be/abcdefghijk', 'request')).reply, /1 video waiting at a time/);
    assert.equal((await run(wren, '!mediaapprove', 'approve')).reply, null, 'moderators only');
    assert.equal((await run(mod, '!mediaapprove', 'approve')).reply, 'Approved "Cat video" from MapleFan_88.');
    const row = (await cs.activeMedia(P.id))[0];
    assert.equal(row.status, 'queued');
    const req = requests.get(row.musicRequestId);
    assert.deepEqual([req.source, req.status, req.url, req.trackKey], ['youtube', 'queued', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'yt:dQw4w9WgXcQ'], 'handed to the VOD-safe song queue');
    assert.deepEqual(nudged, [P.id]);
    // the page shows the video, muted, at the music player's position
    const frames = [];
    const client = { send: (e, d) => { frames.push([e, d]); return true; }, close() {} };
    current = row.musicRequestId;
    const detach = await m.attach(P.id, client);
    assert.equal(frames[0][0], 'hello');
    assert.deepEqual([frames[0][1].video.videoId, frames[0][1].video.positionMs, frames[0][1].video.requester], ['dQw4w9WgXcQ', 12_000, 'MapleFan_88']);
    await m.syncPages();
    assert.equal(frames.at(-1)[0], 'video');
    assert.equal((await cs.getMedia(P.id, row.id)).status, 'playing');
    current = null;
    await m.syncPages();
    assert.equal(frames.at(-1)[0], 'stop');
    req.status = 'played';
    await m.sweepStatuses();
    assert.equal((await cs.getMedia(P.id, row.id)).status, 'played');
    // denied: the points go back
    await give(wren, 100);
    await run(wren, '!media https://youtu.be/abcdefghijk', 'request');
    assert.equal(await pts(wren), 50);
    assert.equal((await run(mod, '!mediadeny 1', 'deny')).reply, 'Denied "Cat video".');
    assert.equal(await pts(wren), 100);
    // the streamer adds one: no approval, no cost
    assert.equal((await m.request(P, { input: 'https://youtu.be/zzzzzzzzzzz', via: 'dashboard' })).reply, '"Cat video" is in the queue. Its sound plays with the song requests.');
    // speech: masked, on the open page; queued while no page is open
    const r = await m.say(P, { text: 'well sh1t, see https://x.dev' });
    assert.equal(r.status, 'ok');
    assert.equal(frames.at(-1)[0], 'speak');
    const id = frames.at(-1)[1].src.split('/')[1];
    assert.equal(String(await m.ttsAudio(P.id, id)), 'RIFFwav');
    assert.equal(await m.ttsAudio(P.id + 1, id), null, 'another profile cannot fetch it');
    assert.deepEqual(spoken[0], ['well bleep see a link', 'ryan']);
    detach();
    assert.equal((await m.say(P, { text: 'later' })).status, 'queued');
    const late = [];
    await m.attach(P.id, { send: (e, d) => { late.push([e, d]); return true; }, close() {} });
    assert.ok(late.some(([e]) => e === 'speak'), 'delivered when the page opens');
    assert.equal((await m.say(P, { text: 'hi', voice: 'not_a_voice' })).status, 'failed');
    // the page key
    const key = await m.pageKey(P.id);
    assert.ok(isMediaKeyShape(key));
    assert.equal(await m.pageKey(P.id), key, 'kept');
    assert.equal(await m.profileForKey(key), P.id);
    const key2 = await m.pageKey(P.id, { rotate: true });
    assert.notEqual(key2, key);
    assert.equal(await m.profileForKey(key2), P.id);
    m.close();
});

// ── engine hooks and seeds ──────────────────────────────────────────────────────────────────

test('engine hooks: the five actions validate and run through the real engine; the redeemed trigger and its variables', async () => {
    const P = profile;
    const said = [];
    const ref = { current: {
        quotes: createQuotes({ cstore: cs, io: fakeIo }),
        games: createGames({ store, viewersRef: { current: { service: vsvc, vstore: vs } }, io: fakeIo, now, timers: false }),
        shop: createShop({ cstore: cs, store, viewersRef: { current: { service: vsvc, vstore: vs } }, now }),
        media: { say: async (profile, o) => { said.push(o); return { ok: true, status: 'ok', detail: 'read' }; }, run: async () => ({ reply: 'Media share is closed right now.' }) },
    } };
    const reg = registerCommunity({ ref, actions: actionsMod, events: eventsMod, render: renderMod });
    for (const t of ['quotes.command', 'games.command', 'store.command', 'media.command', 'tts.say']) assert.ok(actionsMod.actionType(t), t);
    assert.equal(eventsMod.eventType('store.redeemed').label, STORE_REDEEMED.label);
    assert.equal(validateTrigger('store.redeemed', {}).ok, true);
    setVoiceOptions(actionsMod.actionType('tts.say'), [{ value: 'ryan', label: 'Ryan' }]);
    assert.deepEqual(actionsMod.actionType('tts.say').fields[1].options, ['', 'ryan']);
    const v = actionsMod.validateActions([{ type: 'games.command', command: 'nope' }, { type: 'tts.say', text: '', volume: 400 }]);
    assert.equal(v.errors.length, 3, v.errors.join(' | '));
    assert.equal(communityActions(ref).length, 5);
    assert.ok(reg);

    const render = renderMod.createRenderer({ variableStore: store.variableStore });
    const engine = createEngine({ store, render, io: fakeIo, limiter: createLimiter({ now }), now });
    const auto = (actions, text = '!x') => ({ id: 9100 + Math.floor(Math.random() * 800), name: 'T', enabled: true, trigger_type: 'chat', trigger_config: { match: { mode: 'command', text } }, conditions: [], actions });
    let r = await engine.runAutomation(P, auto([{ type: 'tts.say', text: '{user.name} says {message}', voice: '', dropCommand: 'yes' }], '!tts'), chat(fan, '!tts hello there'), { source: 'event' });
    assert.equal(r.status, 'ok', JSON.stringify(r.steps));
    assert.equal(said.at(-1).text, 'MapleFan_88 says hello there', 'the command word is left out');
    r = await engine.runAutomation(P, auto([{ type: 'quotes.command', command: 'quote', reply: 'yes' }], '!quote'), chat(wren, '!quote 1'), { source: 'event' });
    assert.equal(r.status, 'ok', JSON.stringify(r.steps));
    assert.match(sent.at(-1).text, /^Quote #1: "I love bees"/);
    r = await engine.runAutomation(P, auto([{ type: 'games.command', command: 'slots', reply: 'yes' }], '!slots'), chat(fan, '!slots 10'), { source: 'event', dryRun: true });
    assert.equal(r.steps[0].status, 'dry');
    const text = await render('{user.name} got {store.item} for {store.cost}', { ev: { platform: 'bot', type: 'store.redeemed', user: wren, metadata: { item: 'Hydrate', cost: 500 } }, profileId: P.id });
    assert.equal(text, 'Wren_Reads got Hydrate for 500');
});

test('seeded commands: switched off, valid, made once; no song request words; the Twitch grant gains no scope', async () => {
    let total = 0;
    for (const g of GROUPS) {
        const d = commandDrafts(g);
        assert.ok(d.length > 0, g);
        for (const x of d) {
            assert.equal(x.enabled, false, x.name);
            assert.equal(validateTrigger(x.trigger_type, x.trigger_config).ok, true, x.name);
            assert.equal(validateConditions(x.conditions).ok, true, x.name);
            assert.equal(actionsMod.validateActions(x.actions).ok, true, `${x.name}: ${actionsMod.validateActions(x.actions).errors}`);
            assert.ok(!/^!(queue|next|skip|sr)$/.test(x.trigger_config.match.text.trim()), `${x.name} does not take a song request word`);
        }
        total += d.length;
        const a = await seedCommands(store, profile.id, g);
        const b = await seedCommands(store, profile.id, g);
        assert.deepEqual([a.created, b.created], [d.length, 0], g);
    }
    assert.equal(total, 21);
    assert.ok(commandDrafts('tts')[0].conditions[0].roles.includes('vip'), 'chat TTS starts limited to moderators and VIPs');
    for (const s of FORBIDDEN_SCOPES) assert.equal(STREAM_BOT_SCOPES.includes(s), false);
});

// ── import ──────────────────────────────────────────────────────────────────────────────────

test('import: Streamer.bot quotes.dat and Firebot quotes.db rows become quotes, switched off, once; the owner files are empty', async () => {
    // The owner's real Streamer.bot quotes.dat (read only, 2026-11-20): a byte-order mark and an empty list.
    const ownerSb = parseStreamerbot({ files: new Map([['quotes.dat', Buffer.from('﻿{"version":0,"t":"2026-11-20T16:08:50.6440681-08:00","quotes":[]}')]]) });
    assert.equal(ownerSb.quotes.length, 0);
    const sb = parseStreamerbot({ files: new Map([['quotes.dat', Buffer.from(JSON.stringify({ version: 0, quotes: [{ id: 1, timestamp: '2024-05-01T10:00:00Z', userName: 'MapleFan_88', gameName: 'Celeste', quote: 'one more try' }] }))]]) });
    const fb = parseFirebot({ quotes: [{ id: 4, text: 'the floor is lava', originator: 'Wren_Reads', creator: 'mod_moss', game: 'Minecraft', created_at: '2023-02-03T04:05:06Z' }] });
    assert.deepEqual([sb.quotes.length, fb.quotes.length], [1, 1]);
    const plan = buildPlan([fb, sb], { channels: [], channelBots: new Map(), builtins: new Set(), wantViewers: false });
    const items = plan.items.filter((i) => i.category === 'quotes');
    assert.deepEqual(items.map((i) => [i.source, i.status, i.target.system]), [['firebot', 'changed', 'quotes'], ['streamerbot', 'changed', 'quotes']]);
    const importStore = createImportStore({ db: pool, prefix: T.prefix });
    const P = (await store.ensureProfile(`sbq${String(Date.now()).slice(-8)}`, 'Quote importer')).id;
    const run1 = await applyPlan({ store, importStore, profileId: P, plan, categories: ['quotes'], meta: { sources: 'firebot,streamerbot' } });
    assert.deepEqual(run1.results.map((r) => r.result), ['created', 'created'], JSON.stringify(run1.results));
    const list = await cs.listQuotes(P);
    assert.deepEqual(list.map((q) => [q.text, q.saidBy, q.game, q.enabled]).sort(), [['one more try', 'MapleFan_88', 'Celeste', false], ['the floor is lava', 'Wren_Reads', 'Minecraft', false]]);
    const run2 = await applyPlan({ store, importStore, profileId: P, plan, categories: ['quotes'], meta: { sources: 'firebot,streamerbot' } });
    assert.deepEqual(run2.results.map((r) => r.result), ['already', 'already']);
    assert.equal((await cs.listQuotes(P)).length, 2, 'nothing twice');
});

// ── /privacy ────────────────────────────────────────────────────────────────────────────────

test('/privacy: a viewer exports and deletes their redemptions and media requests; quotes they added lose their name; the streamer gets everything', async () => {
    const P = profile.id;
    const acct = [{ platform: 'twitch', id: wren.id }, { platform: 'twitch', id: mod.id }];
    const ex = await communityExport(pool, { accounts: acct, prefix: T.prefix });
    assert.ok(ex.tables[`${T.prefix}store_redemptions_about_you`].length >= 1);
    assert.ok(ex.tables[`${T.prefix}media_requests_about_you`].length >= 1);
    assert.ok(ex.tables[`${T.prefix}quotes_you_added`].length >= 1);
    const own = await communityExport(pool, { profileId: P, prefix: T.prefix });
    assert.ok(own.tables[`${T.prefix}quotes`].length >= 2 && own.tables[`${T.prefix}store_items`].length === 1);
    const del = await communityDelete(pool, { accounts: acct, prefix: T.prefix });
    assert.ok(del[`${T.prefix}store_redemptions`] >= 1 && del[`${T.prefix}media_requests`] >= 1 && del[`${T.prefix}quotes_added_by_cleared`] >= 1);
    assert.equal((await cs.quoteByNumber(P, 1)).addedById, null, 'the quote stays, without who added it');
    assert.deepEqual((await communityExport(pool, { accounts: acct, prefix: T.prefix })).tables, {});
    const priv = createStreamBotPrivacy({ store, db: pool });
    const out = await priv.exportForAccounts([{ platform: 'twitch', id: fan.id }]);
    assert.ok(out.tables[`${T.prefix}store_redemptions_about_you`], 'through core/stream-bot/privacy.js');
    const gone = await communityDelete(pool, { profileId: P, prefix: T.prefix });
    assert.ok(gone[`${T.prefix}quotes`] >= 2);
    assert.deepEqual(await communityExport(pool, { profileId: null, accounts: acct, prefix: 'sbtnone_' }), { tables: {} }, 'no tables: nothing, and no error');
});
