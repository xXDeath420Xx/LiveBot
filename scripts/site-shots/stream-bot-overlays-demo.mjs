/*
 * Stream bot overlays (/stream/bot/overlays and the OBS pages) filled with invented Maple Hollow data, for the guide screenshots
 * (scenes.mjs), tests/stream-bot-overlays-page.test.js and the headless-Chrome render test.
 *
 * Every name is made up (MapleFan_88 and BrambleByte_Live are the stream bot's own sample viewers). The locals are built with the
 * route's own helpers (overlayView, mediaView, FORM) and the settings with core/stream-bot/overlays/config.js, and the frames an
 * overlay page receives with the service's own pageConfig(), so what renders here is what the routes render.
 *
 *   overlayDemo({ root }) → { list: { template, locals }, edit(type) → { template, locals }, page(type, { demo }) → { template, locals },
 *                             frames(type) → [[event, data], …], overlays }
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const OVERLAY_SHOT_IDS = Object.freeze(['stream-bot-overlays', 'stream-bot-overlay-alerts', 'stream-bot-overlay-live']);

export async function overlayDemo({ root }) {
    const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);
    const [route, cfg, svcMod] = await Promise.all([
        imp('dashboard/routes/stream-bot-overlays.js'), imp('core/stream-bot/overlays/config.js'), imp('core/stream-bot/overlays/service.js'),
    ]);
    const { overlayView, mediaView, FORM } = route;
    const at = (h, m) => new Date(Date.UTC(2026, 10, 18, h, m)).toISOString();
    const alertsCfg = cfg.withDefaults('alerts', {
        general: { fontSize: 46, plate: 'soft', position: 'center' },
        alerts: {
            follow: { sound: 'a1b2c3d4e5f60718', media: '0f1e2d3c4b5a6978' },
            cheer: { media: '0f1e2d3c4b5a6978', sound: 'a1b2c3d4e5f60718', tts: true, ttsMin: 500,
                variations: [{ min: 1000, message: '{user.name} threw {amount} Bits!', layout: 'banner' }, { min: 10000, message: 'BIG ONE: {amount} Bits from {user.name}', durationMs: 12000 }] },
            raid: { layout: 'side', detail: 'with {viewers} viewers, welcome in' },
            kick_follow: { enabled: true },
        },
    });
    const rows = [
        { id: 11, type: 'alerts', name: 'Alerts', keyHint: 'Q7xz', config: alertsCfg, state: {}, lastSeenAt: at(20, 41) },
        { id: 12, type: 'chat', name: 'Chat (bottom left)', keyHint: 'p0Lk', config: cfg.withDefaults('chat', {}), state: {}, lastSeenAt: at(20, 40) },
        { id: 13, type: 'goal', name: 'Follower goal', keyHint: 'mm2A', config: cfg.withDefaults('goal', { title: 'Follower goal', target: 100 }), state: { current: 64 }, lastSeenAt: at(20, 40) },
        { id: 14, type: 'counter', name: 'Deaths', keyHint: 'X1c9', config: cfg.withDefaults('counter', { key: 'deaths', label: 'Deaths' }), state: {}, lastSeenAt: null },
        { id: 15, type: 'events', name: 'Recent events', keyHint: '4dDe', config: cfg.withDefaults('events', {}), state: {}, lastSeenAt: at(19, 2) },
    ];
    const status = { 11: { online: 1 }, 12: { online: 1 }, 13: { online: 1 } };
    const media = [
        { id: '0f1e2d3c4b5a6978', name: 'Maple leaf burst', kind: 'image', mime: 'image/gif', size: 812_000, createdAt: at(18, 0) },
        { id: '1e2d3c4b5a697807', name: 'Confetti', kind: 'video', mime: 'video/webm', size: 2_400_000, createdAt: at(18, 5) },
    ];
    const sounds = [{ id: 'a1b2c3d4e5f60718', name: 'chime' }, { id: 'b2c3d4e5f6071829', name: 'airhorn' }];
    const user = { id: '100000000000000777', username: 'juniper', global_name: 'Juniper' };
    const urlFor = (o) => `https://certifriedmultitool.com/stream/bot/overlay/${o.type}/sbo_${'A'.repeat(28)}${o.keyHint}`;

    const list = {
        template: 'stream-bot/overlays',
        locals: { user, ready: true, profile: { id: 7, displayName: 'Juniper' }, overlays: rows.map((o) => overlayView(o, status)), media: media.map(mediaView), form: FORM,
            mediaLimits: (await imp('core/stream-bot/overlays/media.js')).MEDIA_LIMITS, usedBytes: media.reduce((n, m) => n + m.size, 0), studioOnline: true },
    };
    const extra = (type) => {
        if (rows.some((r) => r.type === type)) return rows.find((r) => r.type === type);
        return { id: 20 + cfg.OVERLAY_TYPES.findIndex((t) => t.type === type), type, name: cfg.overlayType(type).label, keyHint: 'zZ00', config: cfg.defaultConfig(type), state: {}, lastSeenAt: null };
    };
    const edit = (type, { previewSrc = '' } = {}) => {
        const o = extra(type);
        return {
            template: 'stream-bot/overlay-edit',
            locals: {
                user, profile: { id: 7 }, overlay: overlayView(o, status), config: o.config, state: o.state, url: urlFor(o), form: FORM, media: media.map(mediaView), sounds,
                voices: [{ value: 'ryan', label: 'Ryan (medium, male) · US English' }, { value: 'amy', label: 'Amy (medium, female) · US English' }],
                editData: JSON.stringify({ id: o.id, type: o.type, config: o.config }).replace(/</g, '\\u003c'), previewSrc,
            },
        };
    };

    const svc = svcMod.createOverlayService({ store: {}, ostore: {}, timers: false });
    const hello = (o, state = {}) => ['hello', { ...svc.pageConfig(o), state, preview: false }];
    const fan = 'MapleFan_88';
    const frames = (type) => {
        const o = extra(type);
        switch (type) {
            case 'alerts': return [hello(o), ['alert', { id: 'demo1', key: 'cheer', label: 'Bits (Twitch)', layout: 'stacked', animation: 'rise', durationMs: 30000, title: `${fan} threw 1,000 Bits!`, name: fan,
                detail: '', message: 'Good luck on the boss, you have got this', media: { kind: 'image', src: 'media/0f1e2d3c4b5a6978' }, sound: { src: 'sound/a1b2c3d4e5f60718', volume: 40 }, tts: { src: 'tts/AAAAAAAAAAAA', volume: 60 }, variation: 0 }]];
            case 'chat': return [hello(o, { messages: [
                { id: 'tw:1', platform: 'twitch', userId: '1', login: 'maplefan_88', name: fan, color: '#ff7f50', badges: [{ kind: 'img', src: 'img/tw-badge/subscriber/12', title: 'subscriber', role: 'subscriber' }], parts: [{ t: 'text', v: 'that jump was clean ' }, { t: 'emote', src: 'img/tw-emote/25', alt: 'Kappa' }], at: 1 },
                { id: 'kk:2', platform: 'kick', userId: '2', login: 'pipsqueak', name: 'Pipsqueak', color: null, badges: [{ kind: 'role', role: 'moderator', title: 'Moderator' }], parts: [{ t: 'text', v: 'hello from Kick ' }, { t: 'emote', src: 'img/kick-emote/37226', alt: 'KEKW' }], at: 2 },
                { id: 'tw:3', platform: 'twitch', userId: '3', login: 'bramblebyte_live', name: 'BrambleByte_Live', color: '#1e90ff', badges: [{ kind: 'img', src: 'img/tw-badge/vip/1', title: 'vip', role: 'vip' }], parts: [{ t: 'text', v: 'raid crew checking in' }], at: 3 },
            ] }), ['chat', { id: 'tw:4', platform: 'twitch', userId: '4', login: 'juniper', name: 'Juniper', color: null, badges: [], parts: [{ t: 'text', v: 'first time here, love the overlay' }], at: 4 }]];
            case 'events': return [hello(o, { items: [
                { id: 3, type: 'cheer', platform: 'twitch', name: fan, text: `${fan} cheered 500 bits`, at: at(20, 41) },
                { id: 2, type: 'follow', platform: 'twitch', name: 'Wren', text: 'Wren followed', at: at(20, 37) },
                { id: 1, type: 'tip', platform: 'streamelements', name: 'Hazel', text: 'Hazel tipped 5 USD', at: at(20, 22) },
            ] }), ['event', { id: 4, type: 'raid', platform: 'twitch', name: 'BrambleByte_Live', text: 'BrambleByte_Live raided with 42 viewers', at: at(20, 50) }]];
            case 'goal': return [hello(o, { title: 'Follower goal', current: 64, target: 100, metric: 'followers' }), ['goal', { title: 'Follower goal', current: 65, target: 100, metric: 'followers' }]];
            case 'counter': return [hello(o, { value: '12' }), ['counter', { value: '13' }]];
            case 'nowplaying': return [hello(o, { now: { title: 'Golden Hour', artist: 'Maple Hollow Band', thumbnail: null, requester: 'Juniper', durationMs: 200000, positionMs: 62000, paused: false } })];
            case 'canvas': return [hello(o), ['action', { id: 'd_000000000000000000000000', action: 'overlay.text', params: { text: 'Deaths: 13', position: 'top-right', size: 'large', durationMs: 60000, animation: 'pop' } }],
                ['action', { id: 'd_111111111111111111111111', action: 'overlay.media', params: { media: { kind: 'image', src: 'media/0f1e2d3c4b5a6978' }, position: 'bottom-right', size: 'small', durationMs: 60000, volume: 0, animation: 'fade' } }]];
            default: return [hello(o)];
        }
    };
    const page = (type, { demo = false, preview = false } = {}) => ({
        template: 'stream-bot/overlay',
        locals: { ok: true, type, pageData: JSON.stringify({ type, base: `/stream/bot/overlay/${type}/sbo_${'B'.repeat(32)}`, preview, sound: !preview, demo }).replace(/</g, '\\u003c') },
    });
    return { list, edit, page, frames, overlays: rows };
}

export default { overlayDemo, OVERLAY_SHOT_IDS };
