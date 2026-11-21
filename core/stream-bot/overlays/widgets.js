/*
 * Stream bot overlays: the widgets' rules, pure (no I/O). service.js does the wiring; tests/stream-bot-overlay-widgets.test.js
 * covers each rule.
 *
 *   jarAmount(config, ev)            how much an event adds to a tip jar (0: nothing); Bits and Kicks at their rate per unit
 *   trainIncrement(ev)               how many subs an event adds to a sub train (0: none)
 *   hypeView(ev)                     a Twitch hype train event → what the bar shows
 *   twitchPollView(ev) / predictionView(ev)   a Twitch poll or prediction event → what the poll widget shows
 *   chatPollView(ev, endsAt)         a chat poll's poll.* event (core/stream-bot/control/chat-polls.js) → what the poll widget shows
 *   creditsFrom(rows, mods, sections) the end credits for these events and moderators
 *   labelLine(key, e)                a stream label's text for an event row ({ name, detail })
 *   money(amount, currency, symbol)  "$5.00", "5.00 EUR"
 *   blockedText(type, config, features)  "Reconnect Twitch to enable" when a ticked Twitch part has no scope, else null
 *   sampleFrames(type, config, now)  what a widget's Test button sends (invented viewers)
 */
import { TWITCH_NEEDS, CREDIT_SECTIONS, CREDIT_TITLE, LABEL_TITLE } from './config.js';

export const RECONNECT_TEXT = 'Reconnect Twitch to enable';
const n = (v) => { const x = typeof v === 'number' ? v : Number.parseFloat(v); return Number.isFinite(x) ? x : 0; };
const round2 = (x) => Math.round(x * 100) / 100;

export function money(amount, currency, symbol = '') {
    const a = n(amount);
    const s = a.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(a) ? 0 : 2, maximumFractionDigits: 2 });
    const cur = String(currency || '').toUpperCase();
    if (/^[A-Z]{3}$/.test(cur)) return cur === 'USD' && symbol === '$' ? `$${a.toFixed(2)}` : `${a.toFixed(2)} ${cur}`;
    return symbol ? `${symbol}${s}` : s;
}

export function jarAmount(cfg, ev) {
    if (!ev || ev.test || !cfg) return 0;
    const src = new Set(cfg.sources || []);
    const amt = Math.max(0, n(ev.amount));
    switch (ev.type) {
        case 'tip': {
            if (ev.platform === 'youtube') {
                const k = ev.metadata?.kind;
                return (k === 'super_chat' || k === 'super_sticker') && src.has('superchats') ? round2(amt) : 0;   // Jewels are not money
            }
            return src.has('tips') ? round2(amt) : 0;
        }
        case 'cheer': return src.has('bits') ? round2(amt / (cfg.bitsPerUnit || 100)) : 0;
        case 'bits.used': return src.has('bits') && ev.metadata?.kind !== 'cheer' ? round2(amt / (cfg.bitsPerUnit || 100)) : 0;   // cheers arrive as 'cheer' too
        case 'kicks.gifted': return src.has('kicks') ? round2(amt / (cfg.kicksPerUnit || 100)) : 0;
        default: return 0;
    }
}

export function trainIncrement(ev) {
    if (!ev || ev.test) return 0;
    const m = ev.metadata || {};
    switch (ev.type) {
        case 'sub': return m.isGift ? 0 : 1;   // gifted ones are counted from the gift event
        case 'resub': return 1;
        case 'gift_sub': return Math.max(1, Math.round(n(m.count) || n(ev.amount) || 1));
        case 'membership': return ev.platform === 'youtube' && m.kind !== 'gift' ? 1 : 0;
        default: return 0;
    }
}

export function hypeView(ev) {
    const m = ev?.metadata || {};
    const ended = ev?.type === 'hype_train.end';
    return { level: n(m.level) || n(ev?.amount) || 1, progress: n(m.progress), goal: n(m.goal), total: n(m.total), expiresAt: ended ? null : (m.expiresAt || null), active: !ended };
}

export function twitchPollView(ev) {
    const m = ev?.metadata || {};
    const ended = ev?.type === 'poll.end';
    const choices = (m.choices || []).slice(0, 10).map((c) => ({ title: String(c.title || '').slice(0, 60), votes: n(c.votes) }));
    return { kind: 'twitch', id: m.id || null, title: String(m.title || '').slice(0, 120), options: choices, endsAt: ended ? null : (m.endsAt || null), status: ended ? 'ended' : 'active', winner: ended ? m.winner || null : null };
}

export function predictionView(ev) {
    const m = ev?.metadata || {};
    const status = ev?.type === 'prediction.end' ? (m.status === 'CANCELED' || m.status === 'canceled' ? 'canceled' : 'ended') : ev?.type === 'prediction.lock' ? 'locked' : 'active';
    const outcomes = (m.outcomes || []).slice(0, 10).map((o) => ({ title: String(o.title || '').slice(0, 60), users: n(o.users), points: n(o.points) }));
    return { kind: 'prediction', id: m.id || null, title: String(m.title || '').slice(0, 120), outcomes, endsAt: status === 'active' ? (m.endsAt || null) : null, status, winner: m.winner || null };
}

/** A chat poll's event (same shape as a Twitch poll, metadata.chat true) → the widget's view; endsAt when the dashboard started it. */
export function chatPollView(ev, endsAt = null) {
    const v = twitchPollView(ev);
    return { ...v, kind: 'chat', endsAt: v.status === 'active' && endsAt ? new Date(endsAt).toISOString() : null };
}

/** rows: eventsSince() rows; mods: names. → [{ key, title, names: [{ name, note }] }] for the ticked sections that have names. */
export function creditsFrom(rows, mods = [], sections = CREDIT_SECTIONS) {
    const lists = Object.fromEntries(CREDIT_SECTIONS.map((k) => [k, new Map()]));
    const add = (k, name, amt = 0, unit = '') => {
        if (!name) return;
        const key = String(name).toLowerCase();
        const cur = lists[k].get(key) || { name: String(name).slice(0, 40), amt: 0, unit };
        cur.amt += amt;
        lists[k].set(key, cur);
    };
    for (const r of rows || []) {
        const m = r.metadata || {};
        switch (r.type) {
            case 'follow': add('followers', r.name); break;
            case 'sub': if (!m.isGift) add('subs', r.name); break;
            case 'resub': add('subs', r.name); break;
            case 'membership': if (r.platform === 'youtube' && m.kind !== 'gift') add('subs', r.name); break;
            case 'gift_sub': add('gifters', r.name || 'Anonymous', n(m.count) || n(r.amount) || 1, 'gift'); break;
            case 'raid': add('raiders', r.name, n(m.viewers) || n(r.amount), 'viewer'); break;
            case 'cheer': add('cheerers', r.name || 'Anonymous', n(r.amount), 'Bits'); break;
            case 'bits.used': if (m.kind !== 'cheer') add('cheerers', r.name || 'Anonymous', n(r.amount), 'Bits'); break;
            case 'kicks.gifted': add('tippers', r.name, n(r.amount), 'Kicks'); break;
            case 'tip': if (m.kind !== 'jewels') add('tippers', r.name || 'Anonymous', n(r.amount), String(r.currency || '').toUpperCase()); break;
            case 'charity': add('tippers', r.name || 'Anonymous', n(r.amount), String(r.currency || '').toUpperCase()); break;
            default: break;
        }
    }
    for (const name of mods || []) add('mods', name);
    const note = (e) => {
        if (!e.amt) return '';
        if (e.unit === 'gift') return `${e.amt} gift${e.amt === 1 ? '' : 's'}`;
        if (e.unit === 'viewer') return `${e.amt} viewer${e.amt === 1 ? '' : 's'}`;
        if (/^[A-Z]{3}$/.test(e.unit)) return money(e.amt, e.unit);
        return `${e.amt.toLocaleString('en-US')} ${e.unit}`.trim();
    };
    return sections.filter((k) => lists[k]?.size).map((k) => ({
        key: k, title: CREDIT_TITLE[k],
        names: [...lists[k].values()].sort((a, b) => b.amt - a.amt || a.name.localeCompare(b.name)).slice(0, 300).map((e) => ({ name: e.name, note: note(e) })),
    }));
}

export function labelLine(key, e) {
    if (!e) return null;
    const name = String(e.name || 'Anonymous').slice(0, 40);
    switch (key) {
        case 'latest_follower': return { name, detail: e.platform === 'youtube' ? 'YouTube' : '' };
        case 'latest_sub': return { name, detail: e.type === 'gift_sub' ? `${n(e.metadata?.count) || n(e.amount) || 1} gifted` : '' };
        case 'latest_tip': return { name, detail: money(e.amount, e.currency) };
        case 'top_cheer': return { name, detail: `${n(e.amount).toLocaleString('en-US')} Bits` };
        default: return null;
    }
}
/** A label as one line of plain text ("MapleFan_88 (5.00 USD)"), for OBS text sources. */
export const labelText = (v, empty = '') => (v ? `${v.name}${v.detail ? ` (${v.detail})` : ''}` : empty);

export function blockedText(type, cfg, features) {
    if (!TWITCH_NEEDS[type] || features == null) return null;   // no Twitch channel linked: the Twitch part does not apply
    const has = (k) => features.has(k);
    if (type === 'train') return cfg.showHype && !has('hype') ? RECONNECT_TEXT : null;
    if (type === 'poll') return (cfg.twitchPolls && !has('poll')) || (cfg.predictions && !has('prediction')) ? RECONNECT_TEXT : null;
    return null;
}

export function sampleFrames(type, cfg = {}, now = Date.now()) {
    const iso = (ms) => new Date(now + ms).toISOString();
    switch (type) {
        case 'train': return [['train', { hype: { level: 2, progress: 1300, goal: 2000, total: 3400, expiresAt: iso(240_000), active: true }, sub: { count: 4, endsAt: iso((cfg.subTrainSec || 60) * 1000), last: 'MapleFan_88' }, test: true }]];
        case 'tipjar': return [['tipjar', { add: { amount: 5, label: money(5, 'USD', cfg.symbol || '$'), name: 'Juniper' }, test: true }]];
        case 'credits': return [['credits', { sections: creditsFrom([
            { type: 'follow', name: 'Wren' }, { type: 'follow', name: 'Hazel' }, { type: 'sub', name: 'MapleFan_88', metadata: {} }, { type: 'gift_sub', name: 'Juniper', metadata: { count: 5 } },
            { type: 'raid', name: 'BrambleByte_Live', metadata: { viewers: 42 } }, { type: 'cheer', name: 'MapleFan_88', amount: 500 }, { type: 'tip', name: 'Hazel', amount: 5, currency: 'USD', metadata: {} },
        ], ['Pipsqueak'], cfg.sections || CREDIT_SECTIONS), title: cfg.title, test: true }]];
        case 'emotewall': return [['emotes', { list: ['img/tw-emote/25', 'img/7tv-emote/01FCY771D800007PQ2DF3GDTN6', 'img/bttv-emote/56e9f494fff3cc5c35e5287e', 'img/ffz-emote/9', 'img/tw-emote/25'], test: true }]];
        case 'poll': return [['poll', { chat: { kind: 'chat', id: 'test', title: 'Which boss next?', options: [{ title: 'The Lantern Witch', votes: 12 }, { title: 'Old Maple', votes: 7 }, { title: 'Both at once', votes: 3 }], endsAt: iso(60_000), status: 'active', winner: null, voters: 22 }, test: true }]];
        case 'labels': return [['labels', { values: { latest_follower: { name: 'Wren', detail: '' }, latest_sub: { name: 'MapleFan_88', detail: '' }, latest_tip: { name: 'Hazel', detail: '$5.00' }, top_cheer: { name: 'MapleFan_88', detail: '1,000 Bits' } }, test: true }]];
        case 'viewers': return [['viewers', { counts: { live: true, total: 128, platforms: { twitch: { live: true, viewers: 96 }, kick: { live: true, viewers: 21 }, youtube: { live: true, viewers: 11 } } }, test: true }]];
        case 'heartrate': {
            // a climb from 96 to 132 over the last minute, so the graph, the zones and the beat all show
            const history = Array.from({ length: 60 }, (_, i) => Math.round(96 + i * 0.6 + 4 * Math.sin(i / 4)));
            return [['heart', { heart: { bpm: 132, at: iso(0), live: true, source: 'studio', min: 88, max: 141, avg: 108, count: 600, battery: 74, history }, test: true }]];
        }
        case 'events': return [['event', { id: null, type: 'follow', platform: 'twitch', name: 'Wren', text: 'Wren followed', at: iso(0) }]];
        case 'chat': return [['chat', { id: `tw:test-${now}`, platform: 'twitch', userId: '1', login: 'maplefan_88', name: 'MapleFan_88', color: '#ff7f50', badges: [], parts: [{ t: 'text', v: 'Test line from the dashboard ' }, { t: 'emote', src: 'img/tw-emote/25', alt: 'Kappa' }], action: null, at: now }]];
        default: return [];
    }
}

export { LABEL_TITLE };
export default { jarAmount, trainIncrement, hypeView, twitchPollView, predictionView, chatPollView, creditsFrom, labelLine, labelText, money, blockedText, sampleFrames, RECONNECT_TEXT };
