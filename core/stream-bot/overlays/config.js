/*
 * Stream bot overlays: the overlay types, their settings, and which alert an event shows (pure; design §9).
 *
 *   OVERLAY_TYPES                 alerts, chat, events, goal, counter, nowplaying, canvas, scene, and the widgets train (hype train
 *                                 and sub train), tipjar, credits, emotewall, poll, labels, viewers, heartrate (Studio 0.2.14):
 *                                 label, the OBS source name
 *                                 CertiFried Studio gives it, and which overlay actions it carries out
 *   ALERT_KINDS                   the alert box's event types (follow, sub tier, resub months, gift count, Bits, raid,
 *                                 redemption, power-up, tip, hype train, watch streak, charity, Kick follow / sub / gift / Kicks,
 *                                 YouTube subscriber, Super Chat, Super Sticker, new member, member milestone and gift memberships)
 *   LABEL_KEYS                    the stream labels (latest follower, sub, tip, top cheer)
 *   TWITCH_NEEDS                  which Twitch features (scopes.js TWITCH_FEATURES keys) a widget needs
 *   CHAT_PLATFORMS                what a Chat overlay can show (YouTube only reaches it once YouTube is set up, §13.1)
 *   alertKeyFor(ev, general)      the alert an event shows, or null
 *   alertAmount(key, ev)          the number a min-amount variation compares (tier, months, count, Bits, viewers …)
 *   pickVariation(alert, amount)  the alert's own settings with the highest matching variation laid over them
 *   defaultConfig(type)           what a new overlay starts with
 *   validateConfig(type, input, { mediaIds, soundIds })  → { ok, errors[], value }   a dashboard save
 *   withDefaults(type, stored)    stored JSON → complete settings (unknown keys dropped, bad values replaced)
 *   goalIncrement(metric, ev)     how much an event moves an automatic goal
 *   sampleFor(key)                the event a Test button shows for an alert
 *
 * Every overlay page is a transparent 1920×1080 canvas; widgets sit at one of nine positions with a margin. A scene screen
 * (`scene`) fills the canvas with the streamer's artwork (cover fit) and places everything in % of that artwork.
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
export const LAYOUTS = Object.freeze(['stacked', 'side', 'banner', 'over', 'text']);
export const LAYOUT_LABEL = Object.freeze({ stacked: 'Image above the text', side: 'Image beside the text', banner: 'Lower-third banner', over: 'Text over the image', text: 'Text only' });
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
    { type: 'scene', label: 'Scene screen', sourceName: 'CertiFried Scene', capabilities: ['show'], audio: false,
        description: 'A full-screen starting soon, be right back or ending screen: your artwork, a title, a scrolling line, a countdown and weather effects.' },
    { type: 'train', label: 'Hype train and sub train', sourceName: 'CertiFried Hype Train', capabilities: ['show'], audio: false,
        description: 'A bar for a Twitch hype train, and a sub train that counts subs and gifts arriving close together on Twitch, Kick and YouTube.' },
    { type: 'tipjar', label: 'Tip jar', sourceName: 'CertiFried Tip Jar', capabilities: ['show'], audio: false,
        description: 'A jar that fills with coins as tips, Bits, Super Chats and Kicks arrive, towards a target you set.' },
    { type: 'credits', label: 'End credits', sourceName: 'CertiFried Credits', capabilities: ['show'], audio: false,
        description: 'Credits that roll for this stream: followers, subs, gifters, raiders, cheerers, tippers and mods.' },
    { type: 'emotewall', label: 'Emote wall', sourceName: 'CertiFried Emote Wall', capabilities: ['show'], audio: false,
        description: 'Emotes from chat float up the screen: Twitch and Kick emotes, and 7TV, BTTV and FFZ ones.' },
    { type: 'poll', label: 'Polls and predictions', sourceName: 'CertiFried Poll', capabilities: ['show'], audio: false,
        description: 'Twitch polls and predictions as they run, and chat polls you start here that Twitch, Kick and YouTube chat vote in.' },
    { type: 'labels', label: 'Stream labels', sourceName: 'CertiFried Labels', capabilities: ['show'], audio: false,
        description: 'Latest follower, latest sub, latest tip and top cheer as text, each one also as a plain text address.' },
    { type: 'viewers', label: 'Viewer count', sourceName: 'CertiFried Viewers', capabilities: ['show'], audio: false,
        description: 'How many people are watching on Twitch, Kick and YouTube, added up or one by one.' },
    { type: 'heartrate', label: 'Heart rate', sourceName: 'CertiFried Heart Rate', capabilities: ['show'], audio: false,
        description: 'Your heart rate from your watch, through CertiFried Studio: the number, a heart that beats with it and a graph.' },
]);
const TYPE = new Map(OVERLAY_TYPES.map((t) => [t.type, t]));
export const overlayType = (t) => TYPE.get(t) || null;
export const isOverlayType = (t) => TYPE.has(t);
/** Overlay types a capability is carried out on ('alert': the overlay.alert action; 'show': text and media). */
export const typesFor = (capability) => OVERLAY_TYPES.filter((t) => t.capabilities.includes(capability)).map((t) => t.type);

export const LIMITS = Object.freeze({
    overlays: 30, name: 80, template: 300, variations: 10, durationMs: [2000, 30000], volume: [0, 100], fontSize: [16, 120],
    margin: [0, 400], width: [160, 1920], chatMessages: [1, 50], chatFade: [0, 600], events: [1, 20], goalTarget: [1, 1e9], gapMs: [0, 5000],
    ttsMin: [0, 1e6], ttsChars: 200, mediaScale: [10, 200], textDelayMs: [0, 5000],
});

/** Scene screens (type `scene`): a title style, effect ranges, and the most glows. Positions are % of the artwork. */
export const TITLE_STYLES = Object.freeze(['plain', 'glow', 'shimmer']);
export const TITLE_STYLE_LABEL = Object.freeze({ plain: 'Plain, with a shadow', glow: 'Glowing', shimmer: 'Glowing, with a moving shine' });
export const GLOW_STYLES = Object.freeze(['pulse', 'flicker', 'lantern']);
export const GLOW_STYLE_LABEL = Object.freeze({ pulse: 'Slow pulse', flicker: 'Pulse and flicker (eyes)', lantern: 'Fast flicker (flame)' });
export const SCENE_LIMITS = Object.freeze({
    title: 80, subtitle: 160, socials: 200, glows: 6, titleSize: [24, 200], subtitleSize: [12, 80], pct: [0, 100], size: [0.5, 30],
    kenBurnsScale: [100, 130], kenBurnsSec: [5, 120], marqueeSec: [4, 120], minutes: [1, 180], embers: [0, 150], effect: [0, 100], grain: [0, 30],
});
export const NOWPLAYING_BACKGROUNDS = Object.freeze(['panel', 'cover']);
export const NOWPLAYING_BACKGROUND_LABEL = Object.freeze({ panel: 'Dark panel', cover: 'The song\'s cover art, blurred, under a dark wash' });

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
    watch_streak: f('Watch streak (Twitch)', { platform: 'twitch', amountLabel: 'Streams at least', message: '{user.name} watched {amount} streams in a row', detail: '', showMessage: true }),
    charity: f('Charity donation (Twitch)', { platform: 'twitch', amountLabel: 'Amount at least', message: '{user.name} gave {amount} {currency} to charity', detail: '' }),
    kick_follow: f('Follow (Kick)', { platform: 'kick', amountLabel: null, message: '{user.name} followed', detail: '' }),
    kick_sub: f('Subscription (Kick)', { platform: 'kick', amountLabel: 'Months at least', message: '{user.name} subscribed', detail: '' }),
    kick_gift: f('Gift subs (Kick)', { platform: 'kick', amountLabel: 'Gifts at least', message: '{user.name} gifted {count} subs', detail: '' }),
    kicks: f('Kicks (Kick)', { platform: 'kick', amountLabel: 'Kicks at least', message: '{user.name} sent {amount} Kicks', detail: '', showMessage: true, ttsCapable: true }),
    // YouTube (design §13.10). The editor lists them only when YouTube is set up on the server (youtube/config.js).
    yt_subscriber: f('Subscriber (YouTube)', { platform: 'youtube', amountLabel: null, message: '{user.name} subscribed', detail: '' }),
    yt_superchat: f('Super Chat (YouTube)', { platform: 'youtube', amountLabel: 'Amount at least', message: '{user.name} sent {amount} {currency}', detail: '', showMessage: true, ttsCapable: true }),
    yt_sticker: f('Super Sticker (YouTube)', { platform: 'youtube', amountLabel: 'Amount at least', message: '{user.name} sent a Super Sticker', detail: '{amount} {currency}' }),
    yt_member: f('New member (YouTube)', { platform: 'youtube', amountLabel: null, message: '{user.name} became a member', detail: '{tier}' }),
    yt_milestone: f('Member milestone (YouTube)', { platform: 'youtube', amountLabel: 'Months at least', message: '{user.name} has been a member for {months} months', detail: '', showMessage: true }),
    yt_gift: f('Gift memberships (YouTube)', { platform: 'youtube', amountLabel: 'Gifts at least', message: '{user.name} gifted {count} memberships', detail: '' }),
});
export const ALERT_KEYS = Object.freeze(Object.keys(ALERT_KINDS));
/** Alert kinds the editor offers: the YouTube ones only when YouTube is set up (youtubeBotConfig().enabled). */
export const alertKeysFor = ({ youtube = false } = {}) => ALERT_KEYS.filter((k) => youtube || ALERT_KINDS[k].platform !== 'youtube');
/** Platforms a Chat overlay can show. */
export const CHAT_PLATFORMS = Object.freeze(['twitch', 'kick', 'youtube']);

/** The alert an event shows (null: none). Test events from the automation editor are not alerts. */
export function alertKeyFor(ev, general = {}) {
    if (!ev || ev.test) return null;
    const p = ev.platform;
    const m = ev.metadata || {};
    switch (ev.type) {
        case 'follow': return p === 'twitch' ? 'follow' : p === 'kick' ? 'kick_follow' : p === 'youtube' ? 'yt_subscriber' : null;
        case 'watch_streak': return p === 'twitch' ? 'watch_streak' : null;
        case 'charity': return p === 'twitch' ? 'charity' : null;
        case 'kicks.gifted': return p === 'kick' ? 'kicks' : null;   // core/stream-bot/control/events.js
        case 'sub':
            if (p === 'kick') return 'kick_sub';
            if (p !== 'twitch') return null;
            return m.isGift && !general.showGiftedSubs ? null : 'sub';
        case 'resub': return p === 'twitch' ? 'resub' : p === 'kick' ? 'kick_sub' : null;
        case 'gift_sub': return p === 'twitch' ? 'gift_sub' : p === 'kick' ? 'kick_gift' : p === 'youtube' ? 'yt_gift' : null;
        case 'cheer': return p === 'twitch' ? 'cheer' : null;
        case 'raid': return p === 'twitch' ? 'raid' : null;
        case 'redemption': return p === 'twitch' ? 'redemption' : null;
        case 'bits.used': return p === 'twitch' && (m.kind === 'power_up' || m.kind === 'custom_power_up') ? 'powerup' : null;
        case 'tip':
            // YouTube Super Chats and Super Stickers have their own alert (§13.10); Jewels stay a tip alert, like the other tip services.
            if (p === 'youtube') return m.kind === 'super_chat' ? 'yt_superchat' : m.kind === 'super_sticker' ? 'yt_sticker' : 'tip';
            return TIP_SOURCES.includes(p) ? 'tip' : null;
        case 'membership':
            if (p !== 'youtube') return null;
            if (m.kind === 'milestone') return 'yt_milestone';
            if (m.kind === 'gift') return general.showGiftedSubs ? 'yt_member' : null;   // a gift shows once, as Gift memberships
            return 'yt_member';
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
        case 'yt_milestone': return num(m.months) ?? num(ev.amount) ?? 1;
        case 'yt_gift': return num(m.count) ?? num(ev.amount) ?? 1;
        case 'yt_member': return 0;
        case 'hype_train': return num(m.level) ?? num(ev.amount) ?? 1;
        case 'watch_streak': return num(m.streak) ?? num(ev.amount) ?? 0;
        case 'follow': case 'kick_follow': case 'yt_subscriber': return 0;
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
    const yt = { id: 'UCmApLeFaN0000000000000a', login: 'maplefan_88', name: 'MapleFan_88', roles: ['subscriber'] };
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
        case 'watch_streak': return ev('twitch', 'watch_streak', { amount: a(5), currency: 'streams', message: 'Five in a row', metadata: { streak: a(5), points: 450 } });
        case 'charity': return ev('twitch', 'charity', { amount: a(10), currency: 'USD', metadata: { charity: 'Maple Hollow Food Bank' } });
        case 'kicks': return ev('kick', 'kicks.gifted', { user: { id: '200000001', login: 'pipsqueak', name: 'Pipsqueak', roles: [] }, amount: a(100), currency: 'kicks', message: 'w', metadata: { gift: 'Rage Quit' } });
        case 'yt_subscriber': return ev('youtube', 'follow', { user: { ...yt, roles: [] }, metadata: { subscriber: true } });
        case 'yt_superchat': return ev('youtube', 'tip', { user: yt, amount: a(5), currency: 'USD', message: 'Coffee is on me', metadata: { kind: 'super_chat', display: '$5.00' } });
        case 'yt_sticker': return ev('youtube', 'tip', { user: yt, amount: a(2), currency: 'USD', metadata: { kind: 'super_sticker', display: '$2.00' } });
        case 'yt_member': return ev('youtube', 'membership', { user: yt, metadata: { kind: 'new', tier: 'Lantern Club', months: 1, isGift: false } });
        case 'yt_milestone': return ev('youtube', 'membership', { user: yt, amount: a(6), currency: 'months', message: 'Half a year already', metadata: { kind: 'milestone', tier: 'Lantern Club', months: a(6), isGift: false } });
        case 'yt_gift': return ev('youtube', 'gift_sub', { user: yt, amount: a(5), currency: 'subs', metadata: { count: a(5), tier: 'Lantern Club' } });
        default: return null;
    }
}

// ── defaults ───────────────────────────────────────────────────────────────────────────────

function defaultAlert(key) {
    const k = ALERT_KINDS[key];
    return {
        enabled: true, layout: 'stacked', animation: 'rise', message: k.message, detail: k.detail || '', showMessage: !!k.showMessage,
        media: '', sound: '', volume: 70, durationMs: 6000, tts: false, ttsMin: 0, mediaScale: 100, textDelayMs: 0, variations: [],
    };
}

export const GOAL_METRICS = Object.freeze(['followers', 'subs', 'bits', 'tips', 'manual']);
export const GOAL_LABEL = Object.freeze({ followers: 'Followers (Twitch, Kick and YouTube subscribers)', subs: 'Subs (new, resubs and gifts)', bits: 'Bits (cheers and power-ups)', tips: 'Tips', manual: 'Set by hand or by an automation' });
export const EVENT_LIST_TYPES = Object.freeze(['follow', 'sub', 'resub', 'gift_sub', 'cheer', 'raid', 'tip', 'redemption', 'bits.used', 'membership', 'hype_train.begin',
    'watch_streak', 'charity', 'kicks.gifted']);

const COMMON = { position: 'bottom-left', margin: 48 };

// ── widgets ────────────────────────────────────────────────────────────────────────────────
/** Stream labels: the key, its title on the overlay, and its plain text address (/text/<key>). */
export const LABEL_KEYS = Object.freeze(['latest_follower', 'latest_sub', 'latest_tip', 'top_cheer']);
export const LABEL_TITLE = Object.freeze({ latest_follower: 'Latest follower', latest_sub: 'Latest sub', latest_tip: 'Latest tip', top_cheer: 'Top cheer' });
/** What fills the tip jar. Bits and Kicks count as money at bitsPerUnit / kicksPerUnit to one unit of the jar. */
export const TIPJAR_SOURCES = Object.freeze(['tips', 'superchats', 'bits', 'kicks']);
export const TIPJAR_SOURCE_LABEL = Object.freeze({ tips: 'Tips (StreamElements, Streamlabs, Ko-fi and the others)', superchats: 'YouTube Super Chats and Super Stickers', bits: 'Bits (cheers and power-ups)', kicks: 'Kicks' });
/** End credits: the sections, in the order they roll. */
export const CREDIT_SECTIONS = Object.freeze(['followers', 'subs', 'gifters', 'raiders', 'cheerers', 'tippers', 'mods']);
export const CREDIT_TITLE = Object.freeze({ followers: 'New followers', subs: 'Subscribers', gifters: 'Gifted subs', raiders: 'Raiders', cheerers: 'Cheered Bits', tippers: 'Tips', mods: 'Moderators' });
/** The Twitch features (scopes.js TWITCH_FEATURES keys) a widget's Twitch part needs; any one is enough. */
export const TWITCH_NEEDS = Object.freeze({ train: ['hype'], poll: ['poll', 'prediction'] });
export const WIDGET_LIMITS = Object.freeze({
    subTrainSec: [10, 600], subTrainMin: [1, 50], jarSize: [120, 900], jarTarget: [1, 1e7], perUnit: [1, 100000], creditsSec: [10, 600], creditsDim: [0, 90],
    emoteSize: [24, 256], emoteMax: [5, 150], emoteRise: [2, 30], emotePerMessage: [1, 20], pollHide: [0, 600], title: 60,
    heartBpm: [40, 240], heartGraphSec: [10, 120], heartHide: [0, 600], heartGraphWidth: [120, 900],
});
const DEFAULTS = {
    alerts: () => ({
        general: { font: 'system', textColor: '#ffffff', accentColor: '#b4e04f', fontSize: 44, position: 'center', plate: 'none', gapMs: 600,
            showGiftedSubs: false, ttsVoice: '', ttsVolume: 80 },
        alerts: Object.fromEntries(ALERT_KEYS.map((k) => [k, defaultAlert(k)])),
    }),
    chat: () => ({ ...COMMON, width: 460, font: 'system', fontSize: 22, textColor: '#ffffff', plate: 'soft', maxMessages: 12, fadeAfterSec: 0,
        showBadges: true, showPlatform: true, hideCommands: false, hideUsers: '', platforms: ['twitch', 'kick', 'youtube'], thirdParty: true }),
    events: () => ({ ...COMMON, position: 'top-right', width: 440, font: 'system', fontSize: 20, textColor: '#ffffff', accentColor: '#b4e04f', plate: 'soft', max: 5,
        types: ['follow', 'sub', 'resub', 'gift_sub', 'cheer', 'raid', 'tip'] }),
    goal: () => ({ ...COMMON, position: 'bottom', width: 720, font: 'system', fontSize: 22, textColor: '#ffffff', barColor: '#b4e04f', plate: 'soft',
        title: 'Follower goal', metric: 'followers', target: 100, showNumbers: true }),
    counter: () => ({ ...COMMON, position: 'top-left', font: 'system', fontSize: 40, textColor: '#ffffff', accentColor: '#b4e04f', plate: 'none', key: 'deaths', label: 'Deaths' }),
    nowplaying: () => ({ ...COMMON, showArt: true, showRequester: true, width: 440, titleSize: 16, barColor: '#2fbf71', background: 'panel', showTimes: false }),
    canvas: () => ({ font: 'system', textColor: '#ffffff', fontSize: 56, plate: 'none' }),
    train: () => ({ ...COMMON, position: 'top', width: 720, font: 'system', fontSize: 22, textColor: '#ffffff', accentColor: '#b4e04f', barColor: '#9146ff', plate: 'soft',
        showHype: true, showSubTrain: true, subTrainSec: 60, subTrainMin: 2, hypeTitle: 'Hype train', subTitle: 'Sub train' }),
    tipjar: () => ({ ...COMMON, position: 'bottom-right', size: 300, font: 'system', fontSize: 20, textColor: '#ffffff', accentColor: '#f2c94c', plate: 'none',
        title: 'Tip jar', target: 100, symbol: '$', sources: ['tips', 'superchats', 'bits', 'kicks'], bitsPerUnit: 100, kicksPerUnit: 100, resetOnLive: true, showTotal: true }),
    credits: () => ({ font: 'system', fontSize: 34, textColor: '#ffffff', accentColor: '#b4e04f', plate: 'none', title: 'Thanks for watching',
        sections: ['followers', 'subs', 'gifters', 'raiders', 'cheerers', 'tippers', 'mods'], durationSec: 45, loop: false, dim: 0 }),
    emotewall: () => ({ size: 84, max: 40, riseSec: 7, perMessage: 5, platforms: ['twitch', 'kick', 'youtube'], thirdParty: true }),
    poll: () => ({ ...COMMON, position: 'top-right', width: 520, font: 'system', fontSize: 22, textColor: '#ffffff', accentColor: '#b4e04f', barColor: '#9146ff', plate: 'soft',
        twitchPolls: true, predictions: true, chatPolls: true, hideAfterSec: 20 }),
    labels: () => ({ ...COMMON, position: 'top-left', font: 'system', fontSize: 26, textColor: '#ffffff', accentColor: '#b4e04f', plate: 'none',
        items: ['latest_follower', 'latest_sub', 'latest_tip', 'top_cheer'], layout: 'column', showTitles: true, topCheerScope: 'stream', empty: 'None yet' }),
    viewers: () => ({ ...COMMON, position: 'top-left', font: 'system', fontSize: 32, textColor: '#ffffff', accentColor: '#b4e04f', plate: 'soft',
        label: 'Viewers', platforms: ['twitch', 'kick', 'youtube'], mode: 'total', hideOffline: false }),
    // Heart rate (Studio 0.2.14): colour zones change the number's colour from warmAt and hotAt; hideAfterSec 0 never hides.
    heartrate: () => ({ ...COMMON, position: 'top-right', font: 'system', fontSize: 56, textColor: '#ffffff', accentColor: '#ff4d6a', plate: 'soft',
        label: 'BPM', showHeart: true, showGraph: true, graphSec: 60, graphWidth: 260, showStats: false,
        zones: true, warmAt: 120, hotAt: 150, warmColor: '#f2c94c', hotColor: '#ff4d6a', hideAfterSec: 15 }),
    scene: () => ({
        font: 'georgia', title: 'Starting soon', subtitle: '', subtitleMode: 'marquee', marqueeSec: 18,
        titleSize: 110, subtitleSize: 28, titleColor: '#ffffff', titleStyle: 'glow', glowColor: '#b4e04f', subtitleColor: '#f4f4f5', titleY: 70, subtitleY: 79,
        background: '', kenBurns: true, kenBurnsScale: 106, kenBurnsSec: 38, dim: 0,
        inset: { media: '', x: 70, y: 40, w: 10, h: 15 },
        window: { enabled: false, x: 60, y: 40, w: 20, h: 25, feather: 0.4 },
        glows: [],
        smoke: { enabled: false, x: 50, y: 50, intensity: 100 },
        embers: 0, emberArea: 'all', rain: 0, lightning: false, fog: 0, vignette: 40, grain: 0,
        countdown: { enabled: false, minutes: 5, label: 'Starting in', endText: 'Starting now', y: 88 },
        socials: '', socialsY: 94,
    }),
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
        mediaScale: clampInt(r.mediaScale, LIMITS.mediaScale, d.mediaScale),
        textDelayMs: clampInt(r.textDelayMs, LIMITS.textDelayMs, d.textDelayMs),
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

const num1 = (v, [lo, hi], d) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? d : Math.min(hi, Math.max(lo, Math.round(n * 10) / 10)); };
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
/** A list sent as an array, or as an object with numbered keys (the settings form's "glows.0.x" fields). */
const listOf = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v).filter((k) => /^\d{1,2}$/.test(k)).sort((a, b) => a - b).map((k) => v[k]) : []);

/** Scene screen settings: positions are % of the artwork, so they stay put whatever its size. */
function cleanScene(r, d, ids, errors) {
    const L = SCENE_LIMITS;
    const pct = (v, dv) => num1(v, L.pct, dv);
    const mediaId = (v, what) => {
        const s = String(v ?? '');
        if (!s) return '';
        if (!MEDIA_ID.test(s) || (ids.mediaIds && !ids.mediaIds.has(s))) { errors?.push(`Scene screen: the ${what} is no longer in your media.`); return ''; }
        return s;
    };
    const ins = obj(r.inset); const di = d.inset;
    const win = obj(r.window); const dw = d.window;
    const sm = obj(r.smoke); const ds = d.smoke;
    const cd = obj(r.countdown); const dc = d.countdown;
    const glows = [];
    for (const g of listOf(r.glows)) {
        if (!g || typeof g !== 'object' || g.on === false || g.on === 'false') continue;
        if (glows.length >= L.glows) { errors?.push(`Scene screen: at most ${L.glows} glows.`); break; }
        glows.push({ x: pct(g.x, 50), y: pct(g.y, 50), size: num1(g.size, L.size, 4), color: color(g.color, '#ffb256'), style: pick(g.style, GLOW_STYLES, 'pulse') });
    }
    return {
        font: pick(r.font, Object.keys(FONTS), d.font),
        title: text(r.title, L.title, d.title).trim(),
        subtitle: text(r.subtitle, L.subtitle, d.subtitle).trim(),
        subtitleMode: pick(r.subtitleMode, ['marquee', 'still'], d.subtitleMode),
        marqueeSec: clampInt(r.marqueeSec, L.marqueeSec, d.marqueeSec),
        titleSize: clampInt(r.titleSize, L.titleSize, d.titleSize),
        subtitleSize: clampInt(r.subtitleSize, L.subtitleSize, d.subtitleSize),
        titleColor: color(r.titleColor, d.titleColor),
        titleStyle: pick(r.titleStyle, TITLE_STYLES, d.titleStyle),
        glowColor: color(r.glowColor, d.glowColor),
        subtitleColor: color(r.subtitleColor, d.subtitleColor),
        titleY: pct(r.titleY, d.titleY),
        subtitleY: pct(r.subtitleY, d.subtitleY),
        background: mediaId(r.background, 'background'),
        kenBurns: bool(r.kenBurns, d.kenBurns),
        kenBurnsScale: clampInt(r.kenBurnsScale, L.kenBurnsScale, d.kenBurnsScale),
        kenBurnsSec: clampInt(r.kenBurnsSec, L.kenBurnsSec, d.kenBurnsSec),
        dim: clampInt(r.dim, [0, 90], d.dim),
        inset: { media: mediaId(ins.media, 'picture in the frame'), x: pct(ins.x, di.x), y: pct(ins.y, di.y), w: pct(ins.w, di.w), h: pct(ins.h, di.h) },
        window: { enabled: bool(win.enabled, dw.enabled), x: pct(win.x, dw.x), y: pct(win.y, dw.y), w: pct(win.w, dw.w), h: pct(win.h, dw.h), feather: num1(win.feather, [0, 10], dw.feather) },
        glows,
        smoke: { enabled: bool(sm.enabled, ds.enabled), x: pct(sm.x, ds.x), y: pct(sm.y, ds.y), intensity: clampInt(sm.intensity, [10, 300], ds.intensity) },
        embers: clampInt(r.embers, L.embers, d.embers),
        emberArea: pick(r.emberArea, ['all', 'centre'], d.emberArea),
        rain: clampInt(r.rain, L.effect, d.rain),
        lightning: bool(r.lightning, d.lightning),
        fog: clampInt(r.fog, L.effect, d.fog),
        vignette: clampInt(r.vignette, L.effect, d.vignette),
        grain: clampInt(r.grain, L.grain, d.grain),
        countdown: { enabled: bool(cd.enabled, dc.enabled), minutes: clampInt(cd.minutes, L.minutes, dc.minutes), label: text(cd.label, 40, dc.label).trim(),
            endText: text(cd.endText, 60, dc.endText).trim(), y: pct(cd.y, dc.y) },
        socials: text(r.socials, L.socials, d.socials).trim(),
        socialsY: pct(r.socialsY, d.socialsY),
    };
}

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
            const platforms = Array.isArray(r.platforms) ? CHAT_PLATFORMS.filter((p) => r.platforms.includes(p)) : d.platforms;
            if (Array.isArray(r.platforms) && !platforms.length) errors?.push('Chat: show at least one platform.');
            return {
                ...cleanBox(r, d), ...textStyle(r, d),
                width: clampInt(r.width, LIMITS.width, d.width),
                maxMessages: clampInt(r.maxMessages, LIMITS.chatMessages, d.maxMessages),
                fadeAfterSec: clampInt(r.fadeAfterSec, LIMITS.chatFade, d.fadeAfterSec),
                showBadges: bool(r.showBadges, d.showBadges), showPlatform: bool(r.showPlatform, d.showPlatform), hideCommands: bool(r.hideCommands, d.hideCommands),
                hideUsers: text(r.hideUsers, 500).split(/[\s,]+/).map((x) => x.replace(/^@/, '').toLowerCase()).filter((x) => /^[a-z0-9_.-]{1,40}$/.test(x)).slice(0, 30).join(', '),   // YouTube handles allow . and -
                platforms: platforms.length ? platforms : d.platforms,
                thirdParty: bool(r.thirdParty, d.thirdParty),
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
            return { ...cleanBox(r, d), showArt: bool(r.showArt, d.showArt), showRequester: bool(r.showRequester, d.showRequester),
                width: clampInt(r.width, [240, 1920], d.width), titleSize: clampInt(r.titleSize, [12, 48], d.titleSize), barColor: color(r.barColor, d.barColor),
                background: pick(r.background, NOWPLAYING_BACKGROUNDS, d.background), showTimes: bool(r.showTimes, d.showTimes) };
        case 'canvas':
            return { ...textStyle(r, d) };
        case 'scene':
            return cleanScene(r, d, ids, errors);
        case 'train':
            return { ...cleanBox(r, d), ...textStyle(r, d), width: clampInt(r.width, LIMITS.width, d.width), accentColor: color(r.accentColor, d.accentColor), barColor: color(r.barColor, d.barColor),
                showHype: bool(r.showHype, d.showHype), showSubTrain: bool(r.showSubTrain, d.showSubTrain),
                subTrainSec: clampInt(r.subTrainSec, WIDGET_LIMITS.subTrainSec, d.subTrainSec), subTrainMin: clampInt(r.subTrainMin, WIDGET_LIMITS.subTrainMin, d.subTrainMin),
                hypeTitle: text(r.hypeTitle, WIDGET_LIMITS.title, d.hypeTitle).trim() || d.hypeTitle, subTitle: text(r.subTitle, WIDGET_LIMITS.title, d.subTitle).trim() || d.subTitle };
        case 'tipjar': {
            const sources = Array.isArray(r.sources) ? TIPJAR_SOURCES.filter((s) => r.sources.includes(s)) : d.sources;
            if (Array.isArray(r.sources) && !sources.length) errors?.push('Tip jar: tick at least one thing that fills it.');
            const target = Number(r.target);
            if (r.target !== undefined && (!Number.isFinite(target) || target < 1)) errors?.push('Tip jar: the target must be 1 or more.');
            return { ...cleanBox(r, d), ...textStyle(r, d), accentColor: color(r.accentColor, d.accentColor), size: clampInt(r.size, WIDGET_LIMITS.jarSize, d.size),
                title: text(r.title, WIDGET_LIMITS.title, d.title).trim(), target: Number.isFinite(target) && target >= 1 ? Math.min(WIDGET_LIMITS.jarTarget[1], Math.round(target * 100) / 100) : d.target,
                symbol: text(r.symbol, 4, d.symbol).trim(), sources: sources.length ? sources : d.sources,
                bitsPerUnit: clampInt(r.bitsPerUnit, WIDGET_LIMITS.perUnit, d.bitsPerUnit), kicksPerUnit: clampInt(r.kicksPerUnit, WIDGET_LIMITS.perUnit, d.kicksPerUnit),
                resetOnLive: bool(r.resetOnLive, d.resetOnLive), showTotal: bool(r.showTotal, d.showTotal) };
        }
        case 'credits': {
            const sections = Array.isArray(r.sections) ? CREDIT_SECTIONS.filter((s) => r.sections.includes(s)) : d.sections;
            if (Array.isArray(r.sections) && !sections.length) errors?.push('End credits: tick at least one section.');
            return { ...textStyle(r, d), accentColor: color(r.accentColor, d.accentColor), title: text(r.title, 80, d.title).trim(), sections: sections.length ? sections : d.sections,
                durationSec: clampInt(r.durationSec, WIDGET_LIMITS.creditsSec, d.durationSec), loop: bool(r.loop, d.loop), dim: clampInt(r.dim, WIDGET_LIMITS.creditsDim, d.dim) };
        }
        case 'emotewall': {
            const platforms = Array.isArray(r.platforms) ? CHAT_PLATFORMS.filter((x) => r.platforms.includes(x)) : d.platforms;
            if (Array.isArray(r.platforms) && !platforms.length) errors?.push('Emote wall: show at least one platform.');
            return { size: clampInt(r.size, WIDGET_LIMITS.emoteSize, d.size), max: clampInt(r.max, WIDGET_LIMITS.emoteMax, d.max), riseSec: clampInt(r.riseSec, WIDGET_LIMITS.emoteRise, d.riseSec),
                perMessage: clampInt(r.perMessage, WIDGET_LIMITS.emotePerMessage, d.perMessage), platforms: platforms.length ? platforms : d.platforms, thirdParty: bool(r.thirdParty, d.thirdParty) };
        }
        case 'poll':
            return { ...cleanBox(r, d), ...textStyle(r, d), width: clampInt(r.width, LIMITS.width, d.width), accentColor: color(r.accentColor, d.accentColor), barColor: color(r.barColor, d.barColor),
                twitchPolls: bool(r.twitchPolls, d.twitchPolls), predictions: bool(r.predictions, d.predictions), chatPolls: bool(r.chatPolls, d.chatPolls),
                hideAfterSec: clampInt(r.hideAfterSec, WIDGET_LIMITS.pollHide, d.hideAfterSec) };
        case 'labels': {
            const items = Array.isArray(r.items) ? LABEL_KEYS.filter((k) => r.items.includes(k)) : d.items;
            if (Array.isArray(r.items) && !items.length) errors?.push('Stream labels: tick at least one label.');
            return { ...cleanBox(r, d), ...textStyle(r, d), accentColor: color(r.accentColor, d.accentColor), items: items.length ? items : d.items,
                layout: pick(r.layout, ['column', 'row'], d.layout), showTitles: bool(r.showTitles, d.showTitles), topCheerScope: pick(r.topCheerScope, ['stream', 'all'], d.topCheerScope),
                empty: text(r.empty, 40, d.empty).trim() };
        }
        case 'viewers': {
            const platforms = Array.isArray(r.platforms) ? CHAT_PLATFORMS.filter((x) => r.platforms.includes(x)) : d.platforms;
            if (Array.isArray(r.platforms) && !platforms.length) errors?.push('Viewer count: count at least one platform.');
            return { ...cleanBox(r, d), ...textStyle(r, d), accentColor: color(r.accentColor, d.accentColor), label: text(r.label, 40, d.label).trim(),
                platforms: platforms.length ? platforms : d.platforms, mode: pick(r.mode, ['total', 'each'], d.mode), hideOffline: bool(r.hideOffline, d.hideOffline) };
        }
        case 'heartrate': {
            const W = WIDGET_LIMITS;
            const warmAt = clampInt(r.warmAt, W.heartBpm, d.warmAt);
            const hotAt = clampInt(r.hotAt, W.heartBpm, d.hotAt);
            if (bool(r.zones, d.zones) && hotAt <= warmAt) errors?.push('Heart rate: the red line must be above the amber line.');
            return { ...cleanBox(r, d), ...textStyle(r, d), accentColor: color(r.accentColor, d.accentColor), label: text(r.label, 20, d.label).trim(),
                showHeart: bool(r.showHeart, d.showHeart), showGraph: bool(r.showGraph, d.showGraph), graphSec: clampInt(r.graphSec, W.heartGraphSec, d.graphSec),
                graphWidth: clampInt(r.graphWidth, W.heartGraphWidth, d.graphWidth), showStats: bool(r.showStats, d.showStats),
                zones: bool(r.zones, d.zones), warmAt, hotAt: Math.max(hotAt, Math.min(W.heartBpm[1], warmAt + 1)), warmColor: color(r.warmColor, d.warmColor), hotColor: color(r.hotColor, d.hotColor),
                hideAfterSec: clampInt(r.hideAfterSec, W.heartHide, d.hideAfterSec) };
        }
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
        case 'followers': return ev.type === 'follow' && ['twitch', 'kick', 'youtube'].includes(ev.platform) ? 1 : 0;
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
    OVERLAY_TYPES, ALERT_KINDS, ALERT_KEYS, alertKeysFor, CHAT_PLATFORMS, POSITIONS, FONTS, LAYOUTS, ANIMATIONS, PLATES, GOAL_METRICS, EVENT_LIST_TYPES, LIMITS,
    TITLE_STYLES, GLOW_STYLES, SCENE_LIMITS, NOWPLAYING_BACKGROUNDS, LABEL_KEYS, LABEL_TITLE, TIPJAR_SOURCES, CREDIT_SECTIONS, CREDIT_TITLE, TWITCH_NEEDS, WIDGET_LIMITS,
    overlayType, isOverlayType, typesFor, alertKeyFor, alertAmount, pickVariation, sampleFor, defaultConfig, withDefaults, validateConfig, goalIncrement, tierNumber,
};
