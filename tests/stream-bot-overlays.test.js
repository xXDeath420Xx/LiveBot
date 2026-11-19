import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pool from '../utils/db.js';
import { makeTables, makeProfile, fakeEncryption } from './fixtures/stream-bot-tables.js';
import { overlaysDdl, OVERLAY_TABLES } from '../migrations/459_stream_bot_overlays.js';
import {
    OVERLAY_TYPES, ALERT_KEYS, alertKeyFor, alertAmount, pickVariation, sampleFor, defaultConfig, validateConfig, withDefaults, goalIncrement, typesFor, tierNumber,
} from '../core/stream-bot/overlays/config.js';
import { createOverlayStore } from '../core/stream-bot/overlays/store.js';
import { createMediaLibrary, sniffMedia } from '../core/stream-bot/overlays/media.js';
import { createOverlayService } from '../core/stream-bot/overlays/service.js';
import { twitchChat, kickChat, visibleFor } from '../core/stream-bot/overlays/chat.js';
import { createImageProxy } from '../core/stream-bot/overlays/images.js';
import { newOverlayKey, isOverlayKeyShape, keyHash, openSse } from '../core/stream-bot/overlays/http.js';
import { overlayActionDefs, registerOverlayActions } from '../core/stream-bot/overlays/actions.js';
import { attachOverlays } from '../core/stream-bot/overlays/index.js';
import { overlaysExport, overlaysDelete } from '../core/stream-bot/overlays/privacy.js';
import * as actionsMod from '../core/stream-bot/actions.js';
import { createEngine } from '../core/stream-bot/engine.js';
import { createRenderer } from '../core/stream-bot/render.js';
import { createFeed } from '../core/stream-bot/feed.js';
import { createStreamBotPrivacy } from '../core/stream-bot/privacy.js';
import { classifyTable } from '../core/privacy-tables.js';

/*
 * Overlays and alerts (core/stream-bot/overlays, migration 459) on throwaway tables (sbto…_), with fake pages (SSE clients that
 * record what they are sent), a fake read-aloud synthesiser and a fake image server. Nothing reaches Twitch, Kick, OBS or a real
 * overlay: the settings and their validation, alert choice and variations, the store and the key, the media library, the live
 * service (alerts, event list, goals, counters, now playing, chat with removals, queued overlay actions and acks, Studio's
 * overlays.list), the editor's actions through the real engine, the wrapping in attachOverlays, emote and badge serving, and /privacy.
 */

let T, store, ostore, profile, mediaDir;
const clock = { t: Date.parse('2026-11-19T12:00:00Z') };
const now = () => clock.t;
const page = () => ({ sent: [], closed: false, send(e, d) { this.sent.push([e, JSON.parse(JSON.stringify(d))]); return true; }, close() { this.closed = true; }, last(e) { return [...this.sent].reverse().find((x) => x[0] === e)?.[1]; }, all(e) { return this.sent.filter((x) => x[0] === e).map((x) => x[1]); } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (o) => ({ channelId: '900000001', user: { id: '100000001', login: 'maplefan_88', name: 'MapleFan_88', roles: [] }, amount: null, currency: null, message: null, metadata: {}, occurredAt: new Date(now()).toISOString(), ...o });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

test.before(async () => {
    T = await makeTables(pool, 'o');
    for (const sql of overlaysDdl(T.prefix)) await pool.query(sql);
    store = T.store;
    ostore = createOverlayStore({ db: pool, prefix: T.prefix, encryption: fakeEncryption });
    profile = await makeProfile(store);
    mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbt-media-'));
});
test.after(async () => {
    for (const t of [...OVERLAY_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${t}\``);
    await T.drop();
    fs.rmSync(mediaDir, { recursive: true, force: true });
    await pool.end();
});

// ── settings ───────────────────────────────────────────────────────────────────────────────

test('every overlay type has defaults that validate, an OBS source name, and the alert box covers every requested event', () => {
    assert.deepEqual(OVERLAY_TYPES.map((t) => t.type), ['alerts', 'chat', 'events', 'goal', 'counter', 'nowplaying', 'canvas']);
    for (const t of OVERLAY_TYPES) {
        assert.match(t.sourceName, /^CertiFried /);
        const v = validateConfig(t.type, defaultConfig(t.type));
        assert.equal(v.ok, true, `${t.type}: ${v.errors}`);
        assert.deepEqual(v.value, defaultConfig(t.type), `${t.type} defaults round-trip`);
    }
    assert.equal(OVERLAY_TYPES.find((t) => t.type === 'alerts').sourceName, 'CertiFried Alerts');
    assert.deepEqual(ALERT_KEYS, ['follow', 'sub', 'resub', 'gift_sub', 'cheer', 'raid', 'redemption', 'powerup', 'tip', 'hype_train', 'kick_follow', 'kick_sub', 'kick_gift']);
    assert.deepEqual(typesFor('alert'), ['alerts']);
    assert.ok(typesFor('show').includes('canvas') && typesFor('show').includes('chat'));
});

test('validation replaces bad values, names the problems, and drops media or sounds that are gone', () => {
    const bad = validateConfig('alerts', {
        general: { font: 'comic', textColor: 'red', fontSize: 999, position: 'side', gapMs: -5 },
        alerts: { cheer: { enabled: 'on', layout: 'spiral', message: 'x'.repeat(500), media: 'ffffffffffffffff', sound: 'zz', durationMs: 1, tts: true, ttsMin: 100,
            variations: [{ min: 1000, message: 'Big {amount}' }, { min: -1 }, { min: 100, layout: 'side', durationMs: 99999 }] }, follow: { tts: true } },
    }, { mediaIds: new Set(['aaaaaaaaaaaaaaaa']), soundIds: new Set() });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => /Bits \(Twitch\): that image or video is no longer/.test(e)));
    assert.ok(bad.errors.some((e) => /minimum of 0 or more/.test(e)));
    const g = bad.value.general;
    assert.equal(g.font, 'system'); assert.equal(g.textColor, '#ffffff'); assert.equal(g.fontSize, 120); assert.equal(g.position, 'center'); assert.equal(g.gapMs, 0);
    const c = bad.value.alerts.cheer;
    assert.equal(c.enabled, true); assert.equal(c.layout, 'stacked'); assert.equal(c.message.length, 300); assert.equal(c.media, ''); assert.equal(c.durationMs, 2000);
    assert.equal(c.tts, true); assert.equal(c.ttsMin, 100);
    assert.deepEqual(c.variations.map((v) => v.min), [100, 1000], 'sorted, the bad one dropped');
    assert.equal(c.variations[0].durationMs, 30000);
    assert.equal(bad.value.alerts.follow.tts, false, 'read aloud only for Bits and tips');
    assert.equal(validateConfig('chat', { platforms: [] }).ok, false);
    assert.equal(validateConfig('counter', { key: 'Bad Key!' }).ok, false);
    assert.equal(validateConfig('goal', { target: 0 }).ok, false);
    assert.equal(validateConfig('nope', {}).ok, false);
    assert.equal(withDefaults('chat', { hideUsers: '@StreamElements, nightbot <x>' }).hideUsers, 'streamelements, nightbot');
});

test('which alert an event shows, the amount its variations compare, and the variation picked', () => {
    assert.equal(alertKeyFor(ev({ platform: 'twitch', type: 'follow' })), 'follow');
    assert.equal(alertKeyFor(ev({ platform: 'kick', type: 'follow' })), 'kick_follow');
    assert.equal(alertKeyFor(ev({ platform: 'twitch', type: 'sub', metadata: { tier: '1000', isGift: true } })), null, 'gifted subs fold into the gift alert');
    assert.equal(alertKeyFor(ev({ platform: 'twitch', type: 'sub', metadata: { isGift: true } }), { showGiftedSubs: true }), 'sub');
    assert.equal(alertKeyFor(ev({ platform: 'kick', type: 'resub' })), 'kick_sub');
    assert.equal(alertKeyFor(ev({ platform: 'kick', type: 'gift_sub' })), 'kick_gift');
    assert.equal(alertKeyFor(ev({ platform: 'twitch', type: 'bits.used', metadata: { kind: 'cheer' } })), null, 'a cheer arrives as cheer too');
    assert.equal(alertKeyFor(ev({ platform: 'twitch', type: 'bits.used', metadata: { kind: 'power_up' } })), 'powerup');
    assert.equal(alertKeyFor(ev({ platform: 'kofi', type: 'tip' })), 'tip');
    assert.equal(alertKeyFor(ev({ platform: 'twitch', type: 'hype_train.begin' })), 'hype_train');
    assert.equal(alertKeyFor(ev({ platform: 'twitch', type: 'chat' })), null);
    assert.equal(alertKeyFor({ ...ev({ platform: 'twitch', type: 'follow' }), test: true }), null, 'automation Test events are not alerts');
    assert.equal(tierNumber('3000'), 3); assert.equal(tierNumber('prime'), 1);
    assert.equal(alertAmount('sub', ev({ metadata: { tier: '2000' } })), 2);
    assert.equal(alertAmount('resub', ev({ amount: 9, metadata: { months: 12 } })), 12);
    assert.equal(alertAmount('cheer', ev({ amount: 1500 })), 1500);
    const a = { ...defaultConfig('alerts').alerts.cheer, variations: [{ min: 100, message: 'Hundred', media: '', sound: '', layout: '', durationMs: '' }, { min: 1000, message: 'Thousand', layout: 'banner', durationMs: 9000 }] };
    assert.equal(pickVariation(a, 50).message, a.message);
    assert.equal(pickVariation(a, 50).variation, null);
    assert.equal(pickVariation(a, 500).message, 'Hundred');
    assert.equal(pickVariation(a, 500).layout, 'stacked', 'an empty field keeps the alert own');
    const big = pickVariation(a, 1000);
    assert.equal(big.message, 'Thousand'); assert.equal(big.layout, 'banner'); assert.equal(big.durationMs, 9000); assert.equal(big.variation, 1);
    for (const k of ALERT_KEYS) assert.equal(alertKeyFor(sampleFor(k)), k, `${k} sample`);
});

test('goals count follows, subs (gifts once), Bits (cheers once) and tips, never test events', () => {
    assert.equal(goalIncrement('followers', ev({ platform: 'kick', type: 'follow' })), 1);
    assert.equal(goalIncrement('subs', ev({ platform: 'twitch', type: 'sub', metadata: { isGift: true } })), 0);
    assert.equal(goalIncrement('subs', ev({ platform: 'twitch', type: 'gift_sub', amount: 5 })), 5);
    assert.equal(goalIncrement('subs', ev({ platform: 'twitch', type: 'resub' })), 1);
    assert.equal(goalIncrement('bits', ev({ type: 'cheer', amount: 300 })), 300);
    assert.equal(goalIncrement('bits', ev({ type: 'bits.used', amount: 300, metadata: { kind: 'cheer' } })), 0);
    assert.equal(goalIncrement('bits', ev({ type: 'bits.used', amount: 100, metadata: { kind: 'power_up' } })), 100);
    assert.equal(goalIncrement('tips', ev({ type: 'tip', amount: 2.5 })), 2.5);
    assert.equal(goalIncrement('followers', { ...ev({ platform: 'twitch', type: 'follow' }), test: true }), 0);
    assert.equal(goalIncrement('manual', ev({ type: 'tip', amount: 5 })), 0);
});

// ── chat parsing ───────────────────────────────────────────────────────────────────────────

test('Twitch chat keeps badges and emotes as paths on this server; deletions, timeouts, bans and clears become removals', () => {
    const r = twitchChat('channel.chat.message', {
        broadcaster_user_id: '900000001', chatter_user_id: '42', chatter_user_login: 'Wren_Plays', chatter_user_name: 'Wren_Plays', message_id: 'abc-123', color: '#1E90FF',
        badges: [{ set_id: 'moderator', id: '1' }, { set_id: '../evil', id: '1' }, { set_id: 'subscriber', id: '12' }],
        message: { text: 'hi Kappa <b>', fragments: [{ type: 'text', text: 'hi ' }, { type: 'emote', text: 'Kappa', emote: { id: '25' } }, { type: 'text', text: ' <b>' }, { type: 'emote', text: 'bad', emote: { id: '../x' } }] },
    });
    assert.equal(r.kind, 'message');
    const m = r.message;
    assert.equal(m.id, 'tw:abc-123'); assert.equal(m.login, 'wren_plays'); assert.equal(m.color, '#1E90FF');
    assert.deepEqual(m.badges.map((b) => b.src), ['img/tw-badge/moderator/1', 'img/tw-badge/subscriber/12']);
    assert.deepEqual(m.parts, [{ t: 'text', v: 'hi ' }, { t: 'emote', src: 'img/tw-emote/25', alt: 'Kappa' }, { t: 'text', v: ' <b>' }, { t: 'text', v: 'bad' }]);
    assert.deepEqual(twitchChat('channel.chat.message_delete', { broadcaster_user_id: '9', message_id: 'abc-123' }), { kind: 'delete', channelId: '9', id: 'tw:abc-123' });
    assert.deepEqual(twitchChat('channel.chat.clear_user_messages', { broadcaster_user_id: '9', target_user_id: '42' }), { kind: 'clear_user', channelId: '9', platform: 'twitch', userId: '42' });
    assert.deepEqual(twitchChat('channel.ban', { broadcaster_user_id: '9', user_id: '42' }), { kind: 'clear_user', channelId: '9', platform: 'twitch', userId: '42' });
    assert.deepEqual(twitchChat('channel.chat.clear', { broadcaster_user_id: '9' }), { kind: 'clear', channelId: '9' });
    assert.equal(twitchChat('channel.follow', { broadcaster_user_id: '9' }), null);
});

test('Kick chat: role badges, emotes from positions or [emote:id:name] tokens; a ban clears the viewer', () => {
    const tokens = kickChat('chat.message.sent', { message_id: 'k1', broadcaster: { user_id: 800000001 }, content: 'gg [emote:37226:KEKW] nice',
        sender: { user_id: 7, username: 'Pipsqueak', channel_slug: 'pipsqueak', identity: { username_color: '#53FC18', badges: [{ type: 'moderator', text: 'Moderator' }, { type: 'weird' }] } } });
    assert.equal(tokens.channelId, '800000001');
    assert.deepEqual(tokens.message.badges, [{ kind: 'role', role: 'moderator', title: 'Moderator' }]);
    assert.deepEqual(tokens.message.parts, [{ t: 'text', v: 'gg ' }, { t: 'emote', src: 'img/kick-emote/37226', alt: 'KEKW' }, { t: 'text', v: ' nice' }]);
    const pos = kickChat('chat.message.sent', { message_id: 'k2', broadcaster: { user_id: 8 }, content: 'LUL ok', emotes: [{ emote_id: '99', positions: [{ s: 0, e: 2 }] }], sender: { user_id: 7, username: 'Pip' } });
    assert.deepEqual(pos.message.parts, [{ t: 'emote', src: 'img/kick-emote/99', alt: 'LUL' }, { t: 'text', v: ' ok' }]);
    assert.deepEqual(kickChat('moderation.banned', { broadcaster: { user_id: 8 }, banned_user: { user_id: 7 } }), { kind: 'clear_user', channelId: '8', platform: 'kick', userId: '7' });
    assert.equal(visibleFor(tokens.message, { platforms: ['twitch'] }), false);
    assert.equal(visibleFor({ ...pos.message, parts: [{ t: 'text', v: '!sr song' }] }, { hideCommands: true }), false);
    assert.equal(visibleFor(tokens.message, { hideUsers: 'pipsqueak' }), false);
    assert.equal(visibleFor(tokens.message, { platforms: ['kick'], hideUsers: '' }), true);
});

// ── key, store, media ──────────────────────────────────────────────────────────────────────

test('overlay keys: shape, stored only as a hash and encrypted; regenerating stops the old one at once', async () => {
    const k = newOverlayKey();
    assert.ok(isOverlayKeyShape(k));
    assert.equal(isOverlayKeyShape('sbm_' + k.slice(4)), false, 'a music key is not an overlay key');
    const { overlay, key } = await ostore.create(profile.id, { type: 'alerts', name: '  Main <alert> box ' });
    assert.equal(overlay.name, 'Main alert box');
    assert.equal(overlay.keyHint, key.slice(-4));
    const [raw] = await pool.query(`SELECT key_hash, key_enc FROM \`${T.prefix}overlays\` WHERE id = ?`, [overlay.id]);
    assert.equal(raw[0].key_hash, keyHash(key));
    assert.ok(!String(raw[0].key_enc).includes(key), 'the key is not stored in the clear');
    assert.equal(await ostore.keyOf(profile.id, overlay.id), key);
    assert.equal((await ostore.byKeyHash(keyHash(key))).id, overlay.id);
    const fresh = await ostore.rotateKey(profile.id, overlay.id);
    assert.notEqual(fresh, key);
    assert.equal(await ostore.byKeyHash(keyHash(key)), null);
    assert.equal((await ostore.byKeyHash(keyHash(fresh))).id, overlay.id);
    assert.equal(await ostore.keyOf(profile.id + 999, overlay.id), null, 'another profile cannot read it');
    await store.updateSettings(profile.id, { enabled: false });
    assert.equal(await ostore.byKeyHash(keyHash(fresh)), null, 'a switched-off profile serves no overlay');
    await store.updateSettings(profile.id, { enabled: true });
    await ostore.remove(profile.id, overlay.id);
});

test('the media library takes images and videos by their bytes, refuses SVG and junk, and keeps files per profile', async () => {
    const lib = createMediaLibrary({ ostore, dir: mediaDir });
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]);
    assert.deepEqual(sniffMedia(PNG), { kind: 'image', ext: 'png', mime: 'image/png' });
    assert.equal(sniffMedia(webm).kind, 'video');
    assert.equal(sniffMedia(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>')), null);
    assert.equal((await lib.add(profile.id, { name: 'x.svg', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>   ') })).ok, false);
    const a = await lib.add(profile.id, { name: 'party.png', buffer: PNG });
    assert.equal(a.ok, true); assert.equal(a.media.name, 'party');
    assert.equal((await lib.add(profile.id, { name: 'Party', buffer: PNG })).ok, false, 'names are unique');
    const v = await lib.add(profile.id, { name: 'confetti', buffer: webm });
    assert.ok(fs.existsSync(lib.filePath(profile.id, v.media)));
    assert.deepEqual((await lib.list(profile.id)).map((m) => m.name), ['confetti', 'party']);
    assert.equal(await lib.remove(profile.id, v.media.id), true);
    assert.equal(fs.existsSync(path.join(mediaDir, String(profile.id), `${v.media.id}.webm`)), false);
});

// ── the live service ───────────────────────────────────────────────────────────────────────

function makeService(extra = {}) {
    const render = createRenderer({ variableStore: store.variableStore });
    const sounds = { async get(pid, id) { return id === 'aaaaaaaaaaaaaaaa' ? { id, name: 'ding', mime: 'audio/mpeg' } : null; } };
    const media = createMediaLibrary({ ostore, dir: mediaDir });
    const said = [];
    const synthesize = async (text, voice) => { said.push([text, voice]); return Buffer.from('RIFF....WAVEfake'); };
    const svc = createOverlayService({ store, ostore, sounds, media, render, synthesize, now, timers: false, baseUrl: 'https://certifriedmultitool.com', ...extra });
    return { svc, said, media };
}

test('alert box: an event becomes one alert with rendered text, the variation, its sound and media paths, and the message read aloud', async () => {
    const { svc, said, media } = makeService();
    const art = (await media.add(profile.id, { name: 'bits art', buffer: PNG })).media;
    const cfg = defaultConfig('alerts');
    cfg.alerts.cheer = { ...cfg.alerts.cheer, sound: 'aaaaaaaaaaaaaaaa', volume: 55, tts: true, ttsMin: 100, variations: [{ min: 1000, message: '{user.name} threw {amount} Bits!', media: art.id, sound: '', layout: 'banner', animation: '', detail: '', durationMs: '' }] };
    cfg.alerts.follow.enabled = false;
    const { overlay } = await ostore.create(profile.id, { type: 'alerts', name: 'Alerts', config: cfg });
    const p = page();
    const detach = await svc.attach(await ostore.get(profile.id, overlay.id), p);
    const hello = p.last('hello');
    assert.equal(hello.type, 'alerts');
    assert.equal(hello.config.alerts, undefined, 'alert settings travel with each alert, not in hello');
    assert.match(hello.config.general.fontCss, /Segoe UI/);
    assert.equal(svc.isConnected(profile.id, 'alert'), true);

    await svc.onEvent(profile.id, ev({ platform: 'twitch', type: 'follow' }));
    assert.equal(p.all('alert').length, 0, 'a switched-off alert shows nothing');
    await svc.onEvent(profile.id, ev({ platform: 'twitch', type: 'cheer', amount: 1500, currency: 'bits', message: 'Cheer1000 Cheer500 take my <b>bits</b> https://evil.example' }));
    const a = p.last('alert');
    assert.equal(a.key, 'cheer'); assert.equal(a.variation, 0); assert.equal(a.layout, 'banner');
    assert.equal(a.title, 'MapleFan_88 threw 1,500 Bits!'); assert.equal(a.name, 'MapleFan_88');
    assert.equal(a.message, 'take my <b>bits</b> https://evil.example', 'cheermotes stripped; text stays text');
    assert.deepEqual(a.media, { kind: 'image', src: `media/${art.id}` });
    assert.deepEqual(a.sound, { src: 'sound/aaaaaaaaaaaaaaaa', volume: 55 });
    assert.match(a.tts.src, /^tts\/[A-Za-z0-9_-]{12}$/);
    const audio = await svc.ttsAudio(overlay, a.tts.src.slice(4));
    assert.ok(Buffer.isBuffer(audio));
    assert.deepEqual(said[0], ['take my bits a link', null], 'links and markup are not read out');
    assert.equal(await svc.ttsAudio({ ...overlay, id: overlay.id + 1 }, a.tts.src.slice(4)), null, 'another overlay cannot fetch it');
    await svc.onEvent(profile.id, ev({ platform: 'twitch', type: 'cheer', amount: 50, currency: 'bits', message: 'small' }));
    assert.equal(p.last('alert').tts, null, 'under the read-aloud minimum');
    await svc.onEvent(profile.id, { ...ev({ platform: 'twitch', type: 'cheer', amount: 50 }), test: true });
    assert.equal(p.all('alert').length, 2, 'automation test events do not pop alerts');

    const t = await svc.testAlert(profile.id, overlay.id, 'raid', 250);
    assert.equal(t.sent, 1);
    assert.equal(p.last('alert').test, true);
    assert.match(p.last('alert').title, /BrambleByte_Live is raiding/);
    assert.equal((await svc.testAlert(profile.id + 1, overlay.id, 'raid')).sent, 0, 'only the owner can test it');
    detach();
    assert.equal(svc.isConnected(profile.id), false);
    svc.close();
    await ostore.remove(profile.id, overlay.id);
});

test('overlay actions go to the chosen overlay, wait in the queue while none is open, and the page acknowledges them', async () => {
    const { svc, media } = makeService();
    await media.add(profile.id, { name: 'Wave', buffer: Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]) });
    const a = (await ostore.create(profile.id, { type: 'alerts', name: 'Alerts' })).overlay;
    const canvas = (await ostore.create(profile.id, { type: 'canvas', name: 'Canvas' })).overlay;
    const d1 = await svc.dispatch({ profileId: profile.id, runId: null, target: 'overlay', capability: 'show', actionType: 'overlay.text', params: { overlay: '', text: 'Hello', position: 'top', size: 'large', durationMs: 4000, animation: 'pop' }, queueSeconds: 60 });
    assert.equal(d1.status, 'queued');
    const none = await svc.dispatch({ profileId: profile.id, target: 'overlay', capability: 'show', actionType: 'overlay.text', params: { text: 'x' }, queueSeconds: 0 });
    assert.equal(none.status, 'none');
    assert.equal((await store.getDispatch(none.id)).status, 'expired');

    const preview = page();
    const offPreview = await svc.attach(canvas, preview, { preview: true });
    assert.equal(svc.isConnected(profile.id), false, 'a dashboard preview is not "connected"');
    const d2 = await svc.dispatch({ profileId: profile.id, target: 'overlay', capability: 'show', actionType: 'overlay.text', params: { text: 'only preview' }, queueSeconds: 30 });
    assert.equal(d2.status, 'queued', 'a preview alone does not take an action off the queue');

    const obs = page();
    const off = await svc.attach(canvas, obs);
    await wait(400);
    const flushed = obs.all('action');
    assert.deepEqual(flushed.map((f) => f.params.text), ['Hello', 'only preview'], 'queued actions arrive in order when the page opens');
    assert.equal(flushed[0].params.overlay, undefined);
    assert.equal((await store.getDispatch(d1.id)).status, 'sent');
    assert.equal(await svc.report(canvas, { dispatchId: d1.id, ok: true }), 'ok');
    assert.equal((await store.getDispatch(d1.id)).status, 'acked');
    assert.equal(await svc.report({ ...canvas, profileId: profile.id + 1 }, { dispatchId: d2.id }), 'ignored', 'another profile cannot ack it');

    const m = await svc.dispatch({ profileId: profile.id, target: 'overlay', capability: 'show', actionType: 'overlay.media', params: { overlay: '', media: 'wave', size: 'small' }, queueSeconds: 30 });
    assert.equal(m.status, 'sent');
    assert.match(obs.last('action').params.media.src, /^media\/[0-9a-f]{16}$/);
    const missing = await svc.dispatch({ profileId: profile.id, target: 'overlay', capability: 'show', actionType: 'overlay.media', params: { media: 'nothing' }, queueSeconds: 30 });
    assert.match((await store.getDispatch(missing.id)).error, /no image or video called "nothing"/);

    const alertsPage = page();
    const offA = await svc.attach(a, alertsPage);
    await svc.dispatch({ profileId: profile.id, target: 'overlay', capability: 'show', actionType: 'overlay.text', params: { overlay: a.id, text: 'to the alert box' }, queueSeconds: 30 });
    assert.equal(alertsPage.last('action').params.text, 'to the alert box');
    assert.notEqual(obs.last('action').params.text, 'to the alert box', 'only the chosen overlay');
    await svc.dispatch({ profileId: profile.id, target: 'overlay', capability: 'alert', actionType: 'overlay.alert', params: { title: 'Old style alert', message: 'still works', durationMs: 5000 }, queueSeconds: 30 });
    assert.equal(alertsPage.last('action').action, 'overlay.alert');
    offA(); off(); offPreview();
    svc.close();
    for (const o of [a, canvas]) await ostore.remove(profile.id, o.id);
});

test('event list, counter, goal (with progress kept between saves) and now playing follow the live feed', async () => {
    let np = { item: { title: 'Golden Hour', artist: 'Maple Hollow Band', thumbnail: 'https://i.example/x.jpg', durationMs: 200000 }, requester: 'Juniper', positionMs: 1000, paused: false };
    const { svc } = makeService({ nowPlaying: () => np });
    await store.insertEvent(profile.id, { ...ev({ platform: 'twitch', type: 'follow', user: { id: '5', login: 'fennel', name: 'Fennel', roles: [] } }), occurredAt: new Date(now()), raw: null, dedupeKey: null });
    const list = (await ostore.create(profile.id, { type: 'events', name: 'Events', config: { types: ['follow', 'tip'], max: 3 } })).overlay;
    const counter = (await ostore.create(profile.id, { type: 'counter', name: 'Deaths', config: { key: 'deaths', label: 'Deaths' } })).overlay;
    const goal = (await ostore.create(profile.id, { type: 'goal', name: 'Goal', config: { metric: 'followers', target: 10, title: 'Followers' } })).overlay;
    const now1 = (await ostore.create(profile.id, { type: 'nowplaying', name: 'Song', config: { showRequester: false } })).overlay;
    await store.variableStore.set(profile.id, 'server', 'deaths', '7');
    const pl = page(), pc = page(), pg = page(), pn = page();
    const offs = [await svc.attach(list, pl), await svc.attach(counter, pc), await svc.attach(goal, pg), await svc.attach(now1, pn)];
    assert.equal(pl.last('hello').state.items[0].text, 'Fennel followed');
    assert.equal(pc.last('hello').state.value, '7');
    assert.deepEqual(pg.last('hello').state, { title: 'Followers', current: 0, target: 10, metric: 'followers' });
    assert.equal(pn.last('hello').state.now.title, 'Golden Hour');
    assert.equal(pn.last('hello').state.now.requester, null, 'requester hidden by the setting');

    await svc.onEvent(profile.id, ev({ platform: 'kick', type: 'follow', user: { id: '6', login: 'pip', name: 'Pip', roles: [] } }));
    await svc.onEvent(profile.id, ev({ platform: 'twitch', type: 'cheer', amount: 100 }));
    assert.equal(pl.last('event').text, 'Pip followed');
    assert.equal(pl.all('event').length, 1, 'cheers are not ticked for this list');
    assert.equal(pg.last('goal').current, 1);
    await svc.onEvent(profile.id, { ...ev({ platform: 'twitch', type: 'follow' }), test: true });
    assert.equal(pg.last('goal').current, 1, 'test events do not count');
    await svc.onEvent(profile.id, { platform: 'bot', type: 'variable.changed', metadata: { key: 'deaths', scope: 'channel', value: '8' } });
    await svc.onEvent(profile.id, { platform: 'bot', type: 'variable.changed', metadata: { key: 'dabs', scope: 'channel', value: '3' } });
    assert.deepEqual(pc.all('counter'), [{ value: '8' }]);
    const r = await svc.changeGoal(profile.id, goal.id, 'add', 4);
    assert.deepEqual([r.ok, r.current, r.target], [true, 5, 10]);
    await ostore.update(profile.id, goal.id, { config: withDefaults('goal', { metric: 'followers', target: 20, title: 'Followers' }) });
    await svc.invalidate(goal.id, { profileId: profile.id });
    assert.deepEqual(pg.last('config').state, { title: 'Followers', current: 5, target: 20, metric: 'followers' }, 'a save restyles the page and keeps unsaved progress');
    np = { ...np, item: { ...np.item, title: 'Night Drive' } };
    await svc.onEvent(profile.id, { platform: 'studio', type: 'music.song_changed', metadata: {} });
    assert.equal(pn.last('nowplaying').now.title, 'Night Drive');
    assert.equal((await svc.changeGoal(profile.id, 999999, 'add', 1)).ok, false);
    offs.forEach((f) => f());
    await new Promise((res) => setTimeout(res, 2200));   // the debounced goal write
    svc.close();
    assert.equal(Number((await ostore.get(profile.id, goal.id)).state.current), 5);
    for (const o of [list, counter, goal, now1]) await ostore.remove(profile.id, o.id);
});

test('chat overlay: lines with badges and emotes, removed when deleted, timed out, banned or cleared; reconnects get the recent lines', async () => {
    const { svc } = makeService();
    const chat = (await ostore.create(profile.id, { type: 'chat', name: 'Chat', config: { hideCommands: true } })).overlay;
    assert.equal(await svc.onChat('twitch', twitchChat('channel.chat.message', { broadcaster_user_id: '900000001', chatter_user_id: '1', chatter_user_login: 'a', chatter_user_name: 'A', message_id: 'm0', message: { text: 'nobody watching' } })), 0, 'no chat overlay open: nothing to do');
    const p = page();
    const off = await svc.attach(chat, p);
    const msg = (id, uid, text) => twitchChat('channel.chat.message', { broadcaster_user_id: '900000001', chatter_user_id: uid, chatter_user_login: `u${uid}`, chatter_user_name: `U${uid}`, message_id: id, message: { text } });
    await svc.onChat('twitch', msg('m1', '1', 'hello'));
    await svc.onChat('twitch', msg('m2', '2', '!sr song'));
    await svc.onChat('twitch', msg('m3', '2', 'spam'));
    await svc.onChat('kick', kickChat('chat.message.sent', { message_id: 'k1', broadcaster: { user_id: 800000001 }, content: 'from kick', sender: { user_id: 9, username: 'Pip' } }));
    await svc.onChat('twitch', twitchChat('channel.chat.message', { broadcaster_user_id: '123', chatter_user_id: '3', chatter_user_login: 'x', chatter_user_name: 'X', message_id: 'other', message: { text: 'another channel' } }));
    assert.deepEqual(p.all('chat').map((m) => m.id), ['tw:m1', 'tw:m3', 'kk:k1'], 'commands hidden; other channels not shown');
    await svc.onChat('twitch', twitchChat('channel.chat.message_delete', { broadcaster_user_id: '900000001', message_id: 'm1' }));
    await svc.onChat('twitch', twitchChat('channel.chat.clear_user_messages', { broadcaster_user_id: '900000001', target_user_id: '2' }));
    assert.deepEqual(p.all('chat_remove'), [{ id: 'tw:m1' }, { platform: 'twitch', userId: '2' }]);
    const again = page();
    const off2 = await svc.attach(chat, again);
    assert.deepEqual(again.last('hello').state.messages.map((m) => m.id), ['kk:k1'], 'a reconnect gets what is still on screen');
    await svc.onChat('kick', kickChat('moderation.banned', { broadcaster: { user_id: 800000001 }, banned_user: { user_id: 9 } }));
    await svc.onChat('twitch', twitchChat('channel.chat.clear', { broadcaster_user_id: '900000001' }));
    assert.deepEqual(again.all('chat_remove'), [{ platform: 'kick', userId: '9' }, { platform: 'twitch', all: true }]);
    off(); off2();
    svc.close();
    await ostore.remove(profile.id, chat.id);
});

test('CertiFried Studio gets every overlay with its URL and source name; a new key closes open pages', async () => {
    const { svc } = makeService();
    const a = await ostore.create(profile.id, { type: 'alerts', name: 'Alerts' });
    const c = await ostore.create(profile.id, { type: 'chat', name: 'Chat' });
    const r = await svc.onStudioRequest({ profileId: profile.id }, 'overlays.list');
    assert.deepEqual(r.overlays.map((o) => [o.type, o.sourceName, o.width, o.height]), [['alerts', 'CertiFried Alerts', 1920, 1080], ['chat', 'CertiFried Chat', 1920, 1080]]);
    assert.equal(r.overlays[0].url, `https://certifriedmultitool.com/stream/bot/overlay/alerts/${a.key}`);
    assert.equal(r.overlays[0].audio, true);
    assert.equal((await svc.onStudioRequest({ profileId: profile.id + 1 }, 'overlays.list')).overlays.length, 0);
    await assert.rejects(svc.onStudioRequest({ profileId: profile.id }, 'overlays.delete'), (e) => e.code === 'unknown_method');
    const p = page();
    await svc.attach(a.overlay, p);
    await svc.invalidate(a.overlay.id, { closeAll: true });
    assert.ok(p.last('gone') && p.closed);
    svc.close();
    for (const o of [a.overlay, c.overlay]) await ostore.remove(profile.id, o.id);
});

// ── engine, actions and the wrapping ───────────────────────────────────────────────────────

test('the overlay actions validate, and run through the real engine as client actions (dry run, queue, needs an overlay)', async () => {
    const defs = overlayActionDefs();
    assert.deepEqual(defs.map((d) => d.type), ['overlay.text', 'overlay.media', 'overlay.goal']);
    const { svc } = makeService();
    const svcRef = { current: svc };
    registerOverlayActions(actionsMod, { serviceRef: svcRef });
    assert.equal(registerOverlayActions(actionsMod), 0, 'registering twice adds nothing');
    const v = actionsMod.validateActions([
        { type: 'overlay.text', overlay: '', text: '  Deaths: {sdb:get:deaths}  ', position: 'nowhere', size: 'giant', durationMs: 999999, animation: 'spin' },
        { type: 'overlay.media', overlay: 'abc', media: '' },
        { type: 'overlay.goal', overlay: '', value: '' },
    ]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.value[0], { type: 'overlay.text', overlay: '', text: 'Deaths: {sdb:get:deaths}', position: 'center', size: 'medium', durationMs: 60000, animation: 'rise', queueSeconds: 120 });
    assert.ok(v.errors.some((e) => /Show an image or video on stream: pick an overlay from the list/.test(e)));
    assert.ok(v.errors.some((e) => /pick an image or video/.test(e)));
    assert.ok(v.errors.some((e) => /Change a goal: pick the goal overlay/.test(e)));
    assert.equal(actionsMod.isClientAction('overlay.text'), true);
    assert.equal(actionsMod.isClientAction('overlay.goal'), false);

    const goal = (await ostore.create(profile.id, { type: 'goal', name: 'Tip goal', config: { metric: 'manual', target: 50 } })).overlay;
    await store.variableStore.set(profile.id, 'server', 'deaths', '13');
    const sent = [];
    const io = { channelsFor: async () => [], dispatch: async (d) => { sent.push(d); return svc.dispatch(d); }, sendChat: async () => ({ ok: true }) };
    const engine = createEngine({ store, render: createRenderer({ variableStore: store.variableStore }), io, now });
    const auto = { id: 1, name: 'Show deaths', enabled: true, trigger_type: 'chat', trigger_config: {}, conditions: [],
        actions: [{ type: 'overlay.text', overlay: '', text: 'Deaths: {sdb:get:deaths}', position: 'top-right', size: 'small', durationMs: 3000, animation: 'fade', queueSeconds: 30 },
            { type: 'overlay.goal', overlay: goal.id, mode: 'add', value: '{amount}' }] };
    const dry = await engine.runAutomation(profile, auto, ev({ platform: 'twitch', type: 'chat', message: '!deaths', amount: 12.5 }), { dryRun: true, skipTrigger: true });
    assert.equal(dry.steps[0].status, 'dry');
    assert.match(dry.steps[0].detail, /an overlay.*Deaths: 13/);
    assert.equal(dry.steps[1].status, 'dry');
    const run = await engine.runAutomation(profile, auto, ev({ platform: 'twitch', type: 'chat', message: '!deaths', amount: 12.5 }), { skipTrigger: true });
    assert.equal(run.steps[0].status, 'queued');
    assert.match(run.steps[0].detail, /Needs an overlay: queued for 30 s/);
    assert.equal(sent[0].params.text, 'Deaths: 13', 'the engine rendered the template before dispatch');
    assert.deepEqual([run.steps[1].status, run.steps[1].detail], ['ok', 'goal is now 12.5 of 50']);
    const runGoal = actionsMod.actionType('overlay.goal').execute;
    assert.equal((await runGoal({ overlay: goal.id, mode: 'add', value: 'lots' }, { profile, dryRun: false, render: async (t) => t })).status, 'failed');
    svc.close();
    await ostore.remove(profile.id, goal.id);
});

test('attachOverlays wraps dispatch, hasDevice, the feed, chat ingestion and Studio requests, leaving everything else as it was', async () => {
    const calls = [];
    const hub = {
        dispatch: async (d) => { calls.push(['hub', d.target]); return { id: 'x', status: 'sent', devices: 1 }; },
        hasDevice: (pid, target) => target === 'studio',
        use(h) { this.handlers = h; return this; },
    };
    const feed = createFeed();
    const ingest = { twitch: async (...a) => { calls.push(['twitch', a[0]]); return 1; }, kick: async (...a) => { calls.push(['kick', a[0]]); return 1; } };
    const box = { store, hub, feed, ingest, logger: null, pool, sounds: null, render: createRenderer({ variableStore: store.variableStore }) };
    const prior = async (conn, method) => ({ from: 'before', method });
    const ov = await attachOverlays(box, { onRequest: prior });
    try {
        assert.ok(ov.service && ov.ostore && ov.media && ov.images);
        await hub.dispatch({ profileId: profile.id, target: 'studio', actionType: 'obs.scene', params: {} });
        assert.deepEqual(calls.pop(), ['hub', 'studio'], 'Studio actions still go to the hub');
        const q = await hub.dispatch({ profileId: profile.id, target: 'overlay', capability: 'show', actionType: 'overlay.text', params: { text: 'x' }, queueSeconds: 5 });
        assert.equal(q.status, 'queued', 'overlay actions go to the overlay service');
        assert.equal(hub.hasDevice(profile.id, 'studio'), true);
        assert.equal(hub.hasDevice(profile.id, 'overlay'), false);
        assert.deepEqual(await hub.handlers.onRequest({ profileId: profile.id }, 'music.overlay', {}), { from: 'before', method: 'music.overlay' });
        assert.deepEqual((await hub.handlers.onRequest({ profileId: profile.id }, 'overlays.list', {})).overlays, []);
        let got = null;
        feed.subscribe(profile.id, (e) => { got = e; });
        feed.publish(profile.id, { type: 'follow', platform: 'twitch' });
        assert.equal(got.type, 'follow', 'the dashboard feed still gets every event');
        assert.equal(await ingest.twitch('channel.chat.message', { broadcaster_user_id: '1', message_id: 'z', message: { text: 'x' } }, 'channel.chat.message'), 1);
        assert.deepEqual(calls.pop(), ['twitch', 'channel.chat.message'], 'ingestion still runs');
        assert.equal(await ingest.kick('chat.message.sent', null), 1);
        assert.ok(actionsMod.actionType('overlay.text'), 'actions registered');
    } finally {
        ov.service.close();
    }
});

test('emotes and badges come only from Twitch and Kick image hosts, are cached, and badge images are looked up through Helix', async () => {
    const hits = [];
    const img = (url, type = 'image/png') => ({ ok: true, status: 200, url, headers: new Map([['content-type', type]]), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    const fetchImpl = async (url) => {
        hits.push(url);
        if (url.startsWith('https://api.twitch.tv/helix/chat/badges/global')) return { ok: true, json: async () => ({ data: [{ set_id: 'moderator', versions: [{ id: '1', image_url_2x: 'https://static-cdn.jtvnw.net/badges/v1/mod/2' }] }] }) };
        if (url.startsWith('https://api.twitch.tv/helix/chat/badges?')) return { ok: true, json: async () => ({ data: [{ set_id: 'subscriber', versions: [{ id: '12', image_url_2x: 'https://static-cdn.jtvnw.net/badges/v1/sub12/2' }, { id: '13', image_url_2x: 'https://evil.example/x.png' }] }] }) };
        if (url.includes('/emotes/5/')) return img(url, 'text/html');
        if (url.includes('/emotes/6/')) return img('https://evil.example/redirected.png');
        return img(url);
    };
    const proxy = createImageProxy({ fetchImpl, appToken: async () => 'app-token', clientId: 'cid', now });
    const e1 = await proxy.get('tw-emote', ['25']);
    assert.equal(e1.type, 'image/png');
    await proxy.get('tw-emote', ['25']);
    assert.equal(hits.filter((h) => h.includes('/emoticons/v2/25/')).length, 1, 'cached');
    assert.equal(await proxy.get('tw-emote', ['../../x']), null);
    assert.ok(await proxy.get('kick-emote', ['37226']));
    assert.equal(await proxy.get('kick-emote', ['5']), null, 'only images');
    assert.equal(await proxy.get('kick-emote', ['6']), null, 'a redirect to another host is refused');
    assert.ok(await proxy.get('tw-badge', ['subscriber', '12'], { twitchChannelId: '900000001' }));
    assert.equal(await proxy.get('tw-badge', ['subscriber', '13'], { twitchChannelId: '900000001' }), null, 'a badge URL on another host is not fetched');
    assert.ok(await proxy.get('tw-badge', ['moderator', '1'], { twitchChannelId: '900000001' }), 'global badges as the fallback');
    assert.equal(await proxy.get('tw-badge', ['nope', '1']), null);
    assert.equal(await proxy.get('other', ['1']), null);
    assert.ok(hits.every((h) => /^https:\/\/(static-cdn\.jtvnw\.net|files\.kick\.com|api\.twitch\.tv)\//.test(h)), hits.join(' '));
});

test('SSE helper: LiteSpeed-safe headers, named events, pings, and one detach when the page closes', async () => {
    const written = [];
    let head = null;
    const listeners = {};
    const res = { writeHead: (code, h) => { head = { code, h }; }, write: (s) => { written.push(s); return true; }, end: () => written.push('<end>') };
    const req = { on: (e, fn) => { listeners[e] = fn; } };
    let detached = 0;
    const c = openSse(req, res, { pingMs: 5, onClose: () => { detached++; } });
    assert.equal(head.code, 200);
    assert.equal(head.h['X-Accel-Buffering'], 'no');
    assert.equal(head.h['Cache-Control'], 'no-store');
    assert.equal(head.h['Referrer-Policy'], 'no-referrer');
    c.send('alert', { a: '</script>' });
    c.send('bad name!', {});
    assert.ok(written.includes('event: alert\ndata: {"a":"</script>"}\n\n'));
    assert.ok(written.some((w) => w.startsWith('event: message\n')));
    await new Promise((r) => setTimeout(r, 1100));
    assert.ok(written.includes(': ping\n\n'));
    listeners.close(); listeners.close();
    assert.equal(detached, 1);
    assert.equal(c.send('alert', {}), false, 'nothing is written after close');
});

// ── privacy ────────────────────────────────────────────────────────────────────────────────

test('/privacy: overlays are exported without their keys and deleted with their media files; the key table is secret', async () => {
    assert.equal(classifyTable('stream_bot_overlays'), 'secret');
    const owner = `sbov${Math.random().toString(16).slice(2, 10)}`;
    const p2 = await store.ensureProfile(owner, 'Other streamer');
    const { overlay, key } = await ostore.create(p2.id, { type: 'goal', name: 'Sub goal' });
    await ostore.setState(p2.id, overlay.id, { current: 3 });
    const media = createMediaLibrary({ ostore, dir: mediaDir });
    await media.add(p2.id, { name: 'logo', buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)]) });
    const ex = await overlaysExport(pool, p2.id, T.prefix);
    assert.equal(ex.overlays[0].name, 'Sub goal');
    assert.equal(ex.overlays[0].state.current, 3);
    assert.equal(ex.overlay_media[0].name, 'logo');
    assert.ok(!JSON.stringify(ex).includes(key) && !JSON.stringify(ex).includes(keyHash(key)), 'no key, no hash');
    const priv = createStreamBotPrivacy({ store, db: pool, mediaDir });
    const full = await priv.exportFor(owner);
    assert.ok(full.tables[`${T.prefix}overlays`] && full.tables[`${T.prefix}overlay_media`]);
    const del = await priv.deleteFor(owner);
    assert.equal(del.deleted[`${T.prefix}overlays`], 1);
    assert.equal(del.deleted[`${T.prefix}overlay_media`], 1);
    assert.equal(fs.existsSync(path.join(mediaDir, String(p2.id))), false, 'the files went too');
    assert.deepEqual(await overlaysDelete(pool, p2.id, T.prefix), {});
});
