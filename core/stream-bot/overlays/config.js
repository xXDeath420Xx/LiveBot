/*
 * Stream bot overlays: the overlay types, their settings, and which alert an event shows (pure; design §9).
 *
 *   OVERLAY_TYPES                 alerts, chat, events, goal, counter, nowplaying, canvas: label, the OBS source name
 *                                 CertiFried Studio gives it, and which overlay actions it carries out
 *   ALERT_KINDS                   the alert box's event types (follow, sub tier, resub months, gift count, Bits, raid,
 *                                 redemption, power-up, tip, hype train, Kick follow / sub / gift)
 *   alertKeyFor(ev, general)      the alert an event shows, or null
 *   alertAmount(key, ev)          the number a min-amount variation compares (tier, months, count, Bits, viewers …)
 *   pickVariation(alert, amount)  the alert's own settings with the highest matching variation laid over them
 *   defaultConfig(type)           what a new overlay starts with
 *   validateConfig(type, input, { mediaIds, soundIds })  → { ok, errors[], value }   a dashboard save
 *   withDefaults(type, stored)    stored JSON → complete settings (unknown keys dropped, bad values replaced)
 *   goalIncrement(metric, ev)     how much an event moves an automatic goal
 *   sampleFor(key)                the event a Test button shows for an alert
 *
 * Every overlay page is a transparent 1920×1080 canvas; widgets sit at one of nine positions with a margin.
 * Tested in tests/stream-bot-overlays.test.js.
 */
import { TIP_SOURCES } from '../events.js';

export const POSITIONS = Object.freeze(['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']);
export const POSITION_LABEL = Object.freeze({
    'top-left': 'Top left', top: 'Top centre', 'top-right': 'Top right', left: 'Middle left', center: 'Centre', right: 'Middle right',
    'bottom-left': 'Bottom left', bottom: 'Bottom centre', 'bottom-right': 'Bottom right',
});
/** Windows fonts only: the overlay loads nothing from outside CertiFried, and OBS runs on Windows. */
export const FONTS = Object.freeze({
    system: { label: 'Segoe UI (Windows default)', css: '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif' },
    bahnschrift: { label: 'Bahnschrift (condensed)', css: 'Bahnschrift, "Segoe UI", system-ui, sans-serif' },
    georgia: { label: 'Georgia (serif)', css: 'Georgia, "Times New Roman", serif' },
    mono: { label: 'Cascadia Mono (monospace)', css: '"Cascadia Mono", Consolas, monospace' },
});
export const LAYOUTS = Object.freeze(['stacked', 'side', 'banner', 'text']);
export const LAYOUT_LABEL = Object.freeze({ stacked: 'Image above the text', side: 'Image beside the text', banner: 'Lower-third banner', text: 'Text only' });
export const ANIMATIONS = Object.freeze(['rise', 'fade', 'pop', 'slide', 'none']);
export const ANIMATION_LABEL = Object.freeze({ rise: 'Rise in', fade: 'Fade', pop: 'Scale in', slide: 'Slide from the side', none: 'No animation' });
export const PLATES = Object.freeze(['none', 'soft', 'solid']);
export const PLATE_LABEL = Object.freeze({ none: 'No background (text shadow only)', soft: 'Soft dark panel', solid: 'Solid dark panel' });

export const OVERLAY_TYPES = Object.freeze([
    { type: 'alerts', label: 'Alert box', sourceName: 'CertiFried Alerts', capabilities: ['alert', 'show'], audio: true,
        description: 'Follows, subs, Bits, raids, tips and more, one at a time, with your images, sounds and wording.' },
    { type: 'chat', label: 'Chat', sourceName: 'CertiFried Chat', capabilities: ['show'], audio: false,
        description: 'Twitch and Kick chat together, with badges and emotes. Deleted messages and banned viewers disappear.' },
    { type: 'events', label: 'Recent events', sourceName: 'CertiFried Events', capabilities: ['show'], audio: false,
        description: 'A short list of the latest follows, subs, Bits, raids and tips.' },
    { type: 'goal', label: 'Goal bar', sourceName: 'CertiFried Goal', capabilities: ['show'], audio: false,
        description: 'Progress towards a follower, sub, Bits or tip goal, counted from your events or set by hand.' },
    { type: 'counter', label: 'Counter', sourceName: 'CertiFried Counter', capabilities: ['show'], audio: false,
        description: 'A stream bot counter or value on screen, such as Deaths or Dabs, updated the moment it changes.' },
    { type: 'nowplaying', label: 'Now playing', sourceName: 'CertiFried Now Playing', capabilities: ['show'], audio: false,
        description: 'The song request playing now: the same card as the music player, shown on its own.' },
    { type: 'canvas', label: 'Text and media', sourceName: 'CertiFried Canvas', capabilities: ['show'], audio: true,
        description: 'An empty layer for the Show text and Show an image or video actions.' },
]);
const TYPE = new Map(OVERLAY_TYPES.map((t) => [t.type, t]));
export const overlayType = (t) => TYPE.get(t) || null;
export const isOverlayType = (t) => TYPE.has(t);
/** Overlay types a capability is carried out on ('alert': the overlay.alert action; 'show': text and media). */
export const typesFor = (capability) => OVERLAY_TYPES.filter((t) => t.capabilities.includes(capability)).map((t) => t.type);

export const LIMITS = Object.freeze({
    overlays: 20, name: 80, template: 300, variations: 10, durationMs: [2000, 30000], volume: [0, 100], fontSize: [16, 120],
    margin: [0, 400], width: [160, 1920], chatMessages: [1, 50], chatFade: [0, 600], events: [1, 20], goalTarget: [1, 1e9], gapMs: [0, 5000],
    ttsMin: [0, 1e6], ttsChars: 200,
});

// ── alerts ─────────────────────────────────────────────────────────────────────────────────

const f = (label, opts) => ({ label, ...opts });
export const ALERT_KINDS = Object.freeze({
    follow: f('Follow (Twitch)', { platform: 'twitch', amountLabel: null, message: '{user.name} followed', detail: '' }),
    sub: f('Subscription (Twitch)', { platform: 'twitch', amountLabel: 'Tier at least (1, 2 or 3)', message: '{user.name} subscribed', detail: 'Tier {tier}' }),
    resub: f('Resubscription (Twitch)', { platform: 'twitch', amountLabel: 'Months at least', message: '{user.name} resubscribed', detail: '{months} months', showMessage: true }),
    gift_sub: f('Gift subs (Twitch)', { platform: 'twitch', amountLabel: 'Gifts at least', message: '{user.name} gifted {count} subs', detail: '' }),
    cheer: f('Bits (Twitch)', { platform: 'twitch', amountLabel: 'Bits at least', message: '{user.name} cheered {amount} Bits', detail: '', showMessage: true, ttsCapable: true }),
    raid: f('Raid (Twitch)', { platform: 'twitch', amountLabel: 'Viewers at least', message: '{user.name} is raiding', detail: 'with {viewers} viewers' }),
    redemption: f('Channel points (Twitch)', { platform: 'twitch', amountLabel: 'Cost at least', message: '{user.name} redeemed {reward}', detail: '', showMessage: true }),
    powerup: f('Power-up (Twitch)', { platform: 'twitch', amountLabel: 'Bits at least', message: '{user.name} used a {powerup}', detail: '' }),
    tip: f('Tip', { platform: 'tips', amountLabel: 'Amount at least', message: '{user.name} tipped {amount} {currency}', detail: '', showMessage: true, ttsCapable: true }),
    hype_train: f('Hype train (Twitch)', { platform: 'twitch', amountLabel: 'Level at least', message: 'Hype train level {level}', detail: '' }),
    kick_follow: f('Follow (Kick)', { platform: 'kick', amountLabel: null, message: '{user.name} followed', detail: '' }),
    kick_sub: f('Subscription (Kick)', { platform: 'kick', amountLabel: 'Months at least', message: '{user.name} subscribed', detail: '' }),
    kick_gift: f('Gift subs (Kick)', { platform: 'kick', amountLabel: 'Gifts at least', message: '{user.name} gifted {count} subs', detail: '' }),
});
export const ALERT_KEYS = Object.freeze(Object.keys(ALERT_KINDS));

/** The alert an event shows (null: none). Test events from the automation editor are not alerts. */
export function alertKeyFor(ev, general = {}) {
    if (!ev || ev.test) return null;
    const p = ev.platform;
    const m = ev.metadata || {};
    switch (ev.type) {
        case 'follow': return p === 'twitch' ? 'follow' : p === 'kick' ? 'kick_follow' : null;
        case 'sub':
            if (p === 'kick') return 'kick_sub';
            if (p !== 'twitch') return null;
            return m.isGift && !general.showGiftedSubs ? null : 'sub';
        case 'resub': return p === 'twitch' ? 'resub' : p === 'kick' ? 'kick_sub' : null;
        case 'gift_sub': return p === 'twitch' ? 'gift_sub' : p === 'kick' ? 'kick_gift' : null;
        case 'cheer': return p === 'twitch' ? 'cheer' : null;
        case 'raid': return p === 'twitch' ? 'raid' : null;
        case 'redemption': return p === 'twitch' ? 'redemption' : null;
        case 'bits.used': return p === 'twitch' && m.kind === 'power_up' ? 'powerup' : null;
        case 'tip': return TIP_SOURCES.includes(p) ? 'tip' : null;
        case 'hype_train.begin': case 'hype_train.end': return p === 'twitch' ? 'hype_train' : null;
        default: return null;
    }
}

const num = (v) => { const n = typeof v === 'number' ? v : Number.parseFloat(v); return Number.isFinite(n) ? n : null; };
export function tierNumber(t) {
    const s = String(t ?? '').toLowerCase();
    if (s === 'prime') return 1;
    if (/^[123]000$/.test(s)) return Number(s[0]);
    return num(s) ?? 1;
}

/** The number an alert's variations compare against. */
export function alertAmount(key, ev) {
    const m = ev?.metadata || {};
    switch (key) {
        case 'sub': return tierNumber(m.tier);
        case 'resub': return num(m.months) ?? num(ev.amount) ?? 0;
        case 'kick_sub': return num(m.months) ?? num(ev.amount) ?? 1;
        case 'hype_train': return num(m.level) ?? num(ev.amount) ?? 1;
        case 'follow': case 'kick_follow': return 0;
        default: return num(ev?.amount) ?? 0;
    }
}

const VARIATION_FIELDS = ['message', 'detail', 'media', 'sound', 'layout', 'durationMs', 'animation'];
/** The alert's settings with the highest variation whose minimum the amount reaches laid over them. */
export function pickVariation(alert, amount) {
    const base = { ...alert, variation: null };
    delete base.variations;
    const list = (alert.variations || []).map((v, i) => ({ ...v, index: i })).filter((v) => Number(amount) >= Number(v.min)).sort((a, b) => b.min - a.min);
    const v = list[0];
    if (!v) return base;
    for (const k of VARIATION_FIELDS) if (v[k] !== undefined && v[k] !== null && v[k] !== '') base[k] = v[k];
    base.variation = v.index;
    return base;
}

/** The event a Test button shows (invented viewers, like the stream bot's own samples). */
export function sampleFor(key, amount = null) {
    const fan = { id: '100000001', login: 'maplefan_88', name: 'MapleFan_88', roles: ['subscriber'] };
    const base = { channelId: null, user: fan, amount: null, currency: null, message: null, metadata: {}, occurredAt: new Date(), dedupeKey: null, raw: null };
    const ev = (platform, type, o = {}) => ({ ...base, platform, type, ...o, metadata: { ...(o.metadata || {}) } });
    const a = (d) => (amount == null ? d : amount);
    switch (key) {
        case 'follow': return ev('twitch', 'follow');
        case 'sub': return ev('twitch', 'sub', { metadata: { tier: `${Math.min(3, Math.max(1, Math.round(a(1))))}000`, isGift: false } });
        case 'resub': return ev('twitch', 'resub', { amount: a(7), currency: 'months', message: 'Seven months already!', metadata: { tier: '1000', months: a(7) } });
        case 'gift_sub': return ev('twitch', 'gift_sub', { amount: a(5), currency: 'subs', metadata: { tier: '1000', count: a(5) } });
        case 'cheer': return ev('twitch', 'cheer', { amount: a(500), currency: 'bits', message: 'Good luck on the boss' });
        case 'raid': return ev('twitch', 'raid', { user: { id: '100000002', login: 'bramblebyte_live', name: 'BrambleByte_Live', roles: [] }, amount: a(42), currency: 'viewers', metadata: { viewers: a(42) } });
        case 'redemption': return ev('twitch', 'redemption', { amount: a(500), currency: 'points', message: 'Play the sad trombone', metadata: { reward: 'Sound alert' } });
        case 'powerup': return ev('twitch', 'bits.used', { amount: a(100), currency: 'bits', message: 'Big text for a big win', metadata: { kind: 'power_up', powerUp: 'message_effect' } });
        case 'tip': return ev('streamelements', 'tip', { user: { id: null, login: null, name: 'Juniper', roles: [] }, amount: a(5), currency: 'USD', message: 'Coffee is on me' });
        case 'hype_train': return ev('twitch', 'hype_train.begin', { user: null, amount: a(1), currency: 'level', metadata: { level: a(1) } });
        case 'kick_follow': return ev('kick', 'follow', { user: { id: '200000001', login: 'pipsqueak', name: 'Pipsqueak', roles: [] } });
        case 'kick_sub': return ev('kick', 'sub', { user: { id: '200000001', login: 'pipsqueak', name: 'Pipsqueak', roles: ['subscriber'] }, metadata: { months: a(1) } });
        case 'kick_gift': return ev('kick', 'gift_sub', { user: { id: '200000001', login: 'pipsqueak', name: 'Pipsqueak', roles: [] }, amount: a(3), currency: 'subs', metadata: { count: a(3) } });
        default: return null;
    }
}

// ── defaults ───────────────────────────────────────────────────────────────────────────────

function defaultAlert(key) {
    const k = ALERT_KINDS[key];
    return {
        enabled: true, layout: 'stacked', animation: 'rise', message: k.message, detail: k.detail || '', showMessage: !!k.showMessage,
        media: '', sound: '', volume: 70, durationMs: 6000, tts: false, ttsMin: 0, variations: [],
    };
}

export const GOAL_METRICS = Object.freeze(['followers', 'subs', 'bits', 'tips', 'manual']);
export const GOAL_LABEL = Object.freeze({ followers: 'Followers (Twitch and Kick)', subs: 'Subs (new, resubs and gifts)', bits: 'Bits (cheers and power-ups)', tips: 'Tips', manual: 'Set by hand or by an automation' });
export const EVENT_LIST_TYPES = Object.freeze(['follow', 'sub', 'resub', 'gift_sub', 'cheer', 'raid', 'tip', 'redemption', 'bits.used', 'membership', 'hype_train.begin']);

const COMMON = { position: 'bottom-left', margin: 48 };
const DEFAULTS = {
    alerts: () => ({
        general: { font: 'system', textColor: '#ffffff', accentColor: '#b4e04f', fontSize: 44, position: 'center', plate: 'none', gapMs: 600,
            showGiftedSubs: false, ttsVoice: '', ttsVolume: 80 },
        alerts: Object.fromEntries(ALERT_KEYS.map((k) => [k, defaultAlert(k)])),
    }),
    chat: () => ({ ...COMMON, width: 460, font: 'system', fontSize: 22, textColor: '#ffffff', plate: 'soft', maxMessages: 12, fadeAfterSec: 0,
        showBadges: true, showPlatform: true, hideCommands: false, hideUsers: '', platforms: ['twitch', 'kick'] }),
    events: () => ({ ...COMMON, position: 'top-right', width: 440, font: 'system', fontSize: 20, textColor: '#ffffff', accentColor: '#b4e04f', plate: 'soft', max: 5,
        types: ['follow', 'sub', 'resub', 'gift_sub', 'cheer', 'raid', 'tip'] }),
    goal: () => ({ ...COMMON, position: 'bottom', width: 720, font: 'system', fontSize: 22, textColor: '#ffffff', barColor: '#b4e04f', plate: 'soft',
        title: 'Follower goal', metric: 'followers', target: 100, showNumbers: true }),
    counter: () => ({ ...COMMON, position: 'top-left', font: 'system', fontSize: 40, textColor: '#ffffff', accentColor: '#b4e04f', plate: 'none', key: 'deaths', label: 'Deaths' }),
    nowplaying: () => ({ ...COMMON, showArt: true, showRequester: true }),
    canvas: () => ({ font: 'system', textColor: '#ffffff', fontSize: 56, plate: 'none' }),
};
export const defaultConfig = (type) => (DEFAULTS[type] ? DEFAULTS[type]() : {});

// ── validation ─────────────────────────────────────────────────────────────────────────────

const COLOR = /^#[0-9a-f]{6}$/i;
const KEY = /^[a-z0-9_.-]{1,64}$/;
const MEDIA_ID = /^[0-9a-f]{16}$/;
const clampInt = (v, [lo, hi], d) => { const n = Math.round(Number(v)); return v === '' || v == null || !Number.isFinite(n) ? d : Math.min(hi, Math.max(lo, n)); };
const pick = (v, list, d) => (list.includes(v) ? v : d);
const bool = (v, d) => (v === undefined ? d : v === true || v === 'true' || v === 'on' || v === 1 || v === '1');
const color = (v, d) => (COLOR.test(String(v || '')) ? String(v).toLowerCase() : d);
const text = (v, max, d = '') => (v == null ? d : String(v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max));

function cleanAlert(raw, key, ids, errors) {
    const d = defaultAlert(key);
    const r = raw && typeof raw === 'object' ? raw : {};
    const label = ALERT_KINDS[key].label;
    const media = (v) => {
        const s = String(v ?? '');
        if (!s) return '';
        if (!MEDIA_ID.test(s) || (ids.mediaIds && !ids.mediaIds.has(s))) { errors?.push(`${label}: that image or video is no longer in your media.`); return ''; }
        return s;
    };
    const sound = (v) => {
        const s = String(v ?? '');
        if (!s) return '';
        if (!MEDIA_ID.test(s) || (ids.soundIds && !ids.soundIds.has(s))) { errors?.push(`${label}: that sound is no longer in your sound library.`); return ''; }
        return s;
    };
    const out = {
        enabled: bool(r.enabled, d.enabled),
        layout: pick(r.layout, LAYOUTS, d.layout),
        animation: pick(r.animation, ANIMATIONS, d.animation),
        message: text(r.message, LIMITS.template, d.message).trim() || d.message,
        detail: text(r.detail, LIMITS.template, d.detail),
        showMessage: bool(r.showMessage, d.showMessage),
        media: media(r.media),
        sound: sound(r.sound),
        volume: clampInt(r.volume, LIMITS.volume, d.volume),
        durationMs: clampInt(r.durationMs, LIMITS.durationMs, d.durationMs),
        tts: ALERT_KINDS[key].ttsCapable ? bool(r.tts, false) : false,
        ttsMin: ALERT_KINDS[key].ttsCapable ? Math.min(LIMITS.ttsMin[1], Math.max(0, Number(r.ttsMin) || 0)) : 0,
        variations: [],
    };
    const vars = Array.isArray(r.variations) ? r.variations : [];
    if (vars.length > LIMITS.variations) errors?.push(`${label}: at most ${LIMITS.variations} variations.`);
    for (const v of vars.slice(0, LIMITS.variations)) {
        if (!v || typeof v !== 'object') continue;
        const min = Number(v.min);
        if (!Number.isFinite(min) || min < 0) { errors?.push(`${label}: each variation needs a minimum of 0 or more.`); continue; }
        out.variations.push({
            min: Math.min(1e9, min),
            message: text(v.message, LIMITS.template).trim(),
            detail: text(v.detail, LIMITS.template),
            media: media(v.media),
            sound: sound(v.sound),
            layout: v.layout ? pick(v.layout, LAYOUTS, '') : '',
            animation: v.animation ? pick(v.animation, ANIMATIONS, '') : '',
            durationMs: v.durationMs === '' || v.durationMs == null ? '' : clampInt(v.durationMs, LIMITS.durationMs, ''),
        });
    }
    out.variations.sort((a, b) => a.min - b.min);
    return out;
}

function cleanBox(r, d) {
    return {
        position: pick(r.position, POSITIONS, d.position),
        margin: clampInt(r.margin, LIMITS.margin, d.margin),
    };
}
const textStyle = (r, d) => ({
    font: pick(r.font, Object.keys(FONTS), d.font),
    fontSize: clampInt(r.fontSize, LIMITS.fontSize, d.fontSize),
    textColor: color(r.textColor, d.textColor),
    plate: pick(r.plate, PLATES, d.plate),
});

/**
 * Stored or submitted settings → complete settings. `errors` (an array) collects plain-words problems for a save;
 * `ids` ({ mediaIds, soundIds } Sets) check that chosen media and sounds still exist (skipped when not given).
 */
export function withDefaults(type, raw, ids = {}, errors = null) {
    const d = defaultConfig(type);
    const r = raw && typeof raw === 'object' ? raw : {};
    switch (type) {
        case 'alerts': {
            const g = r.general && typeof r.general === 'object' ? r.general : {};
            const dg = d.general;
            const alerts = {};
            for (const k of ALERT_KEYS) alerts[k] = cleanAlert(r.alerts?.[k], k, ids, errors);
            return {
                general: {
                    ...textStyle(g, dg),
                    accentColor: color(g.accentColor, dg.accentColor),
                    position: pick(g.position, ['top', 'center', 'bottom'], dg.position),
                    gapMs: clampInt(g.gapMs, LIMITS.gapMs, dg.gapMs),
                    showGiftedSubs: bool(g.showGiftedSubs, dg.showGiftedSubs),
                    ttsVoice: /^[a-z0-9_-]{0,50}$/i.test(String(g.ttsVoice ?? '')) ? String(g.ttsVoice ?? '') : '',
                    ttsVolume: clampInt(g.ttsVolume, LIMITS.volume, dg.ttsVolume),
                },
                alerts,
            };
        }
        case 'chat': {
            const platforms = Array.isArray(r.platforms) ? ['twitch', 'kick'].filter((p) => r.platforms.includes(p)) : d.platforms;
            if (Array.isArray(r.platforms) && !platforms.length) errors?.push('Chat: show at least one of Twitch or Kick.');
            return {
                ...cleanBox(r, d), ...textStyle(r, d),
                width: clampInt(r.width, LIMITS.width, d.width),
                maxMessages: clampInt(r.maxMessages, LIMITS.chatMessages, d.maxMessages),
                fadeAfterSec: clampInt(r.fadeAfterSec, LIMITS.chatFade, d.fadeAfterSec),
                showBadges: bool(r.showBadges, d.showBadges), showPlatform: bool(r.showPlatform, d.showPlatform), hideCommands: bool(r.hideCommands, d.hideCommands),
                hideUsers: text(r.hideUsers, 500).split(/[\s,]+/).map((x) => x.replace(/^@/, '').toLowerCase()).filter((x) => /^[a-z0-9_]{1,40}$/.test(x)).slice(0, 30).join(', '),
                platforms: platforms.length ? platforms : d.platforms,
            };
        }
        case 'events': {
            const types = Array.isArray(r.types) ? EVENT_LIST_TYPES.filter((t) => r.types.includes(t)) : d.types;
            if (Array.isArray(r.types) && !types.length) errors?.push('Recent events: tick at least one kind of event.');
            return { ...cleanBox(r, d), ...textStyle(r, d), width: clampInt(r.width, LIMITS.width, d.width), accentColor: color(r.accentColor, d.accentColor),
                max: clampInt(r.max, LIMITS.events, d.max), types: types.length ? types : d.types };
        }
        case 'goal': {
            const target = Number(r.target);
            if (r.target !== undefined && (!Number.isFinite(target) || target < 1)) errors?.push('Goal: the target must be 1 or more.');
            return { ...cleanBox(r, d), ...textStyle(r, d), width: clampInt(r.width, LIMITS.width, d.width), barColor: color(r.barColor, d.barColor),
                title: text(r.title, 80, d.title).trim() || d.title, metric: pick(r.metric, GOAL_METRICS, d.metric),
                target: Number.isFinite(target) && target >= 1 ? Math.min(LIMITS.goalTarget[1], Math.round(target * 100) / 100) : d.target,
                showNumbers: bool(r.showNumbers, d.showNumbers) };
        }
        case 'counter': {
            const key = String(r.key ?? d.key).trim().toLowerCase();
            if (r.key !== undefined && !KEY.test(key)) errors?.push('Counter: the name may use 1 to 64 letters, numbers, _ . or -.');
            return { ...cleanBox(r, d), ...textStyle(r, d), accentColor: color(r.accentColor, d.accentColor), key: KEY.test(key) ? key : d.key,
                label: text(r.label, 60, d.label).trim() };
        }
        case 'nowplaying':
            return { ...cleanBox(r, d), showArt: bool(r.showArt, d.showArt), showRequester: bool(r.showRequester, d.showRequester) };
        case 'canvas':
            return { ...textStyle(r, d) };
        default:
            return {};
    }
}

/** A save from the dashboard. */
export function validateConfig(type, input, ids = {}) {
    if (!isOverlayType(type)) return { ok: false, errors: ['Unknown overlay type.'], value: {} };
    const errors = [];
    const value = withDefaults(type, input, ids, errors);
    return { ok: !errors.length, errors: [...new Set(errors)], value };
}

/** How much an event moves an automatic goal (0: not at all). Test events never count. */
export function goalIncrement(metric, ev) {
    if (!ev || ev.test) return 0;
    const amt = num(ev.amount) || 0;
    switch (metric) {
        case 'followers': return ev.type === 'follow' && ['twitch', 'kick'].includes(ev.platform) ? 1 : 0;
        case 'subs':
            if (ev.type === 'sub') return ev.metadata?.isGift ? 0 : 1;   // gifted ones are counted from the gift event
            if (ev.type === 'resub') return 1;
            if (ev.type === 'gift_sub') return Math.max(1, Math.round(amt));
            return 0;
        case 'bits':
            if (ev.type === 'cheer') return Math.max(0, amt);
            if (ev.type === 'bits.used' && ev.metadata?.kind !== 'cheer') return Math.max(0, amt);   // cheers arrive as 'cheer' too
            return 0;
        case 'tips': return ev.type === 'tip' ? Math.max(0, amt) : 0;
        default: return 0;
    }
}

export default {
    OVERLAY_TYPES, ALERT_KINDS, ALERT_KEYS, POSITIONS, FONTS, LAYOUTS, ANIMATIONS, PLATES, GOAL_METRICS, EVENT_LIST_TYPES, LIMITS,
    overlayType, isOverlayType, typesFor, alertKeyFor, alertAmount, pickVariation, sampleFor, defaultConfig, withDefaults, validateConfig, goalIncrement, tierNumber,
};
