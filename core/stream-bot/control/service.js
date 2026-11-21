/*
 * Stream bot control: the live side of the wave 2 triggers and the data the conditions and variables read.
 *
 *   createControlService({ db, store, io, ingest, streamInfo, twitch, prefix, logger, now?, ignoreLogins? })
 *     onPublish(profileId, pub)   every published event: first words and viewer arrived (W2.11), chat poll votes
 *     tick()                      every 30 s: viewer count steps and upcoming ads for profiles that have such automations
 *     start() / stop()
 *     followedAt(profileId, ev)   { known, at, reason }  (cached 10 minutes per viewer)
 *     userValues({ ev, profileId, template })   {user.created} {user.accountage} {user.followage} {user.followed}
 *     streamInfoFor(profileId, ev)
 *     variable(profileId, ev, scope, key)
 *
 * First words: the viewer has no viewer record yet, or one created in the last 2 minutes (the viewer service may have
 * written it from the same chat line), and this process has not raised it for them before. Viewer arrived: the first
 * line from a viewer since the channel went live (or, without a live event, in the last 12 hours). Both skip the bot
 * accounts and the broadcaster.
 *
 * Tested in tests/stream-bot-control.test.js.
 */
import { viewerOwner } from '../render.js';

const FOLLOW_CACHE_MS = 10 * 60_000;
const ARRIVED_TTL_MS = 12 * 60 * 60_000;
const NEW_VIEWER_MS = 2 * 60_000;
export const POLL_MS = 30_000;

export function formatAge(fromMs, toMs) {
    const days = Math.max(0, Math.floor((toMs - fromMs) / 86400000));
    if (days < 1) return 'less than a day';
    const y = Math.floor(days / 365);
    const mo = Math.floor((days % 365) / 30);
    const d = days % 365 % 30;
    const part = (n, w) => (n ? `${n} ${w}${n === 1 ? '' : 's'}` : null);
    return [part(y, 'year'), part(mo, 'month'), y ? null : part(d, 'day')].filter(Boolean).join(', ') || 'less than a day';
}

export function createControlService({ db = null, store = null, io = null, ingest = null, streamInfo = null, twitch = null, prefix = 'stream_bot_', logger = null,
    now = () => Date.now(), ignoreLogins = [], raise = null } = {}) {
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBotControl] ${msg}`, meta); } catch { /* ignore */ } };
    const bots = new Set(ignoreLogins.filter(Boolean).map((s) => String(s).toLowerCase()));
    const seenEver = new Set();          // 'pid:platform:userId' first words already raised
    const arrived = new Map();           // 'pid:platform:channel' -> { since, users: Set }
    const follows = new Map();           // 'pid:userId' -> { at, value }
    const users = new Map();             // 'pid:userId' -> { at, value }
    const viewerState = new Map();       // 'pid:platform:channel' -> last count
    const adState = new Map();           // 'pid' -> Set of 'adAt:minutes' raised
    let timer = null;
    let busy = false;
    const T = (n) => `\`${prefix}${n}\``;
    const fire = (pid, ev) => { try { (raise || ((p, e) => ingest?.internal(p, e)))(pid, ev); } catch { /* best effort */ } };

    function derived(type, pub, extra = {}) {
        return { platform: pub.platform, type, channelId: pub.channelId ?? null, user: pub.user ? { ...pub.user, roles: [...(pub.user.roles || [])] } : null,
            amount: null, currency: null, message: pub.message ?? null, metadata: { ...(extra || {}) }, raw: null, occurredAt: new Date(now()), dedupeKey: null, internal: true };
    }

    async function isNewViewer(pid, pub) {
        if (!db) return false;
        try {
            const [rows] = await db.query(`SELECT first_seen_at FROM ${T('viewers')} WHERE profile_id = ? AND platform = ? AND platform_user_id = ? LIMIT 1`,
                [pid, pub.platform, String(pub.user.id)]);
            if (!rows.length) return true;
            const at = new Date(rows[0].first_seen_at).getTime();
            return Number.isFinite(at) && now() - at < NEW_VIEWER_MS;
        } catch { return false; }
    }

    async function onPublish(profileId, pub) {
        const pid = Number(profileId);
        if (!pub || pub.test) return;
        if (pub.type === 'stream.online' && pub.channelId != null) { arrived.set(`${pid}:${pub.platform}:${pub.channelId}`, { since: now(), users: new Set() }); return; }
        if (pub.type !== 'chat' || !pub.user?.id || !['twitch', 'kick', 'youtube'].includes(pub.platform)) return;
        const login = String(pub.user.login || '').toLowerCase();
        if ((login && bots.has(login)) || (pub.user.roles || []).includes('broadcaster')) return;
        const uk = `${pid}:${pub.platform}:${pub.user.id}`;
        const ck = `${pid}:${pub.platform}:${pub.channelId}`;
        let a = arrived.get(ck);
        if (!a || now() - a.since > ARRIVED_TTL_MS) { a = { since: now(), users: new Set() }; arrived.set(ck, a); }
        if (!a.users.has(String(pub.user.id))) {
            a.users.add(String(pub.user.id));
            fire(pid, derived('chat.arrived', pub));
        }
        if (!seenEver.has(uk)) {
            seenEver.add(uk);
            if (seenEver.size > 200_000) seenEver.clear();
            if (await isNewViewer(pid, pub)) fire(pid, derived('chat.first_words', pub));
        }
    }

    async function streamInfoFor(profileId, ev) {
        try { return io?.streamInfo ? await io.streamInfo(profileId, ev) : null; } catch { return null; }
    }

    async function followedAt(profileId, ev) {
        if (ev?.platform !== 'twitch' || !ev.user?.id) return { known: false, reason: 'only Twitch viewers can be checked' };
        if (!twitch) return { known: false, reason: 'not available' };
        const k = `${profileId}:${ev.user.id}`;
        const hit = follows.get(k);
        if (hit && now() - hit.at < FOLLOW_CACHE_MS) return hit.value;
        let value;
        try { value = { known: true, at: await twitch.followedAt(profileId, ev.user.id) }; } catch (err) {
            value = { known: false, reason: err?.code === 'missing_scope' ? 'Reconnect Twitch to enable this' : 'could not ask Twitch' };
        }
        if (follows.size > 20_000) follows.clear();
        follows.set(k, { at: now(), value });
        return value;
    }

    async function userInfo(profileId, ev) {
        if (ev?.platform !== 'twitch' || !ev.user?.id || !twitch) return null;
        const k = `${profileId}:${ev.user.id}`;
        const hit = users.get(k);
        if (hit && now() - hit.at < FOLLOW_CACHE_MS) return hit.value;
        let value = null;
        try { value = await twitch.userInfo(profileId, ev.user.id); } catch { value = null; }
        if (users.size > 20_000) users.clear();
        users.set(k, { at: now(), value });
        return value;
    }

    const USER_VARS = ['user.created', 'user.accountage', 'user.followage', 'user.followed'];
    async function userValues({ ev, profileId, template = '' }) {
        const out = Object.fromEntries(USER_VARS.map((n) => [n, '']));
        if (!/\{user\.(created|accountage|followage|followed)\}/i.test(template)) return out;
        if (/\{user\.(created|accountage)\}/i.test(template)) {
            const u = await userInfo(profileId, ev);
            if (u?.createdAt) {
                out['user.created'] = new Date(u.createdAt).toISOString().slice(0, 10);
                out['user.accountage'] = formatAge(Date.parse(u.createdAt), now());
            }
        }
        if (/\{user\.(followage|followed)\}/i.test(template)) {
            const f = await followedAt(profileId, ev);
            if (f.known) {
                out['user.followed'] = f.at ? new Date(f.at).toISOString().slice(0, 10) : 'not following';
                out['user.followage'] = f.at ? formatAge(Date.parse(f.at), now()) : 'not following';
            }
        }
        return out;
    }

    async function variable(profileId, ev, scope, key) {
        if (!store?.variableStore) return null;
        const owner = scope === 'user' ? viewerOwner(ev) : 'server';
        if (!owner) return null;
        const v = await store.variableStore.get(profileId, owner, key);
        return v == null ? '' : String(v?.value ?? v);
    }

    // ── polling: viewer count steps and upcoming ads ──
    async function profilesWith() {
        if (!db) return [];
        try {
            const [rows] = await db.query(`SELECT a.profile_id, a.trigger_type, a.trigger_config FROM ${T('automations')} a JOIN ${T('profiles')} p ON p.id = a.profile_id
                WHERE a.enabled = 1 AND p.enabled = 1 AND a.trigger_type IN ('stream.viewers', 'ad.upcoming')`);
            const by = new Map();
            for (const r of rows) {
                const pid = Number(r.profile_id);
                const e = by.get(pid) || { viewers: false, adMinutes: new Set() };
                let cfg = r.trigger_config;
                try { cfg = typeof cfg === 'string' ? JSON.parse(cfg) : (cfg || {}); } catch { cfg = {}; }
                if (r.trigger_type === 'stream.viewers') e.viewers = true;
                else e.adMinutes.add(Number(cfg.minutes) || 5);
                by.set(pid, e);
            }
            return [...by.entries()];
        } catch (err) { log('debug', 'poll list failed', { error: err?.message }); return []; }
    }

    async function pollProfile(pid, want) {
        let channels = [];
        try { channels = await io.channelsFor(pid); } catch { return; }
        let twitchLive = false;
        for (const c of channels.filter((x) => ['twitch', 'kick', 'youtube'].includes(x.platform))) {
            let info = null;
            try { info = await streamInfo?.get({ profileId: pid, platform: c.platform, channelId: String(c.platform_user_id), login: c.login }); } catch { info = null; }
            const k = `${pid}:${c.platform}:${c.platform_user_id}`;
            if (!info?.live) { viewerState.delete(k); continue; }
            if (c.platform === 'twitch') twitchLive = true;
            if (!want.viewers) continue;
            const cur = Number(info.viewers) || 0;
            const prev = viewerState.get(k);
            viewerState.set(k, cur);
            if (prev != null && prev !== cur) {
                fire(pid, { platform: c.platform, type: 'stream.viewers', channelId: String(c.platform_user_id), user: null, amount: cur, currency: 'viewers', message: null,
                    metadata: { viewers: cur, previous: prev }, raw: null, occurredAt: new Date(now()), dedupeKey: null, internal: true });
            }
        }
        if (!want.adMinutes.size || !twitchLive || !twitch) return;
        let s;
        try { s = await twitch.adSchedule(pid); } catch (err) { log('debug', 'ad schedule failed', { pid, error: err?.message }); return; }
        if (!s.nextAdAt) return;
        const left = Math.round((s.nextAdAt - now()) / 1000);
        if (left <= 0) return;
        const raised = adState.get(pid) || new Set();
        for (const m of want.adMinutes) {
            const k = `${s.nextAdAt}:${m}`;
            if (left <= m * 60 && left > m * 60 - POLL_MS / 1000 * 2 && !raised.has(k)) {
                raised.add(k);
                const tw = channels.find((x) => x.platform === 'twitch');
                fire(pid, { platform: 'twitch', type: 'ad.upcoming', channelId: tw ? String(tw.platform_user_id) : null, user: null, amount: left, currency: 'seconds', message: null,
                    metadata: { minutes: m, length: s.length, snoozes: s.snoozes, nextAdAt: new Date(s.nextAdAt).toISOString() }, raw: null, occurredAt: new Date(now()), dedupeKey: null, internal: true });
            }
        }
        if (raised.size > 200) raised.clear();
        adState.set(pid, raised);
    }

    async function tick() {
        if (busy) return;
        busy = true;
        try { for (const [pid, want] of await profilesWith()) await pollProfile(pid, want); } finally { busy = false; }
    }

    return {
        onPublish, tick, followedAt, userValues, variable, streamInfoFor, pollProfile, USER_VARS,
        start() { if (timer) return; timer = setInterval(() => { tick().catch((err) => log('warn', 'tick failed', { error: err?.message })); }, POLL_MS); timer.unref?.(); },
        stop() { if (timer) clearInterval(timer); timer = null; },
    };
}

export default { createControlService, formatAge, POLL_MS };
