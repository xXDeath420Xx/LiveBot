/*
 * Stream bot: where events come in (design §2.2). The existing receivers call these after their own work;
 * there is no second ingestion system.
 *
 *   ingest.twitch(subType, event, specKey)   core/twitch-eventsub-manager.js handleNotification()
 *   ingest.kick(eventType, event)            services/certifried-bot/kick-events.js makeHandleKickEvent()
 *   ingest.tip(source, payload, ref)         Ko-fi / Throne / Fourthwall webhooks, Buy Me a Coffee poller
 *   ingest.tipForSource(row, payload)        StreamElements / Streamlabs sockets (core/stream-bot/tip-feeds.js)
 *   ingest.studio(profileId, ev)             an OBS event CertiFried Studio reported (core/stream-bot/studio.js), already normalised
 *   ingest.recordTest(profile, ev)           the Test button's sample event (stored and shown, not run)
 *   ingest.noteSent(platform, channelId, text)  chat the bot sent, so it is not taken as a trigger (echo guard)
 *   ingest.internal(profileId, ev)           an event the stream bot raises itself: studio.connected, variable.changed
 *   onChatLine(platform, channelId)          option: called for every chat line from a viewer (timers count them)
 *
 * Per event: channel → profile lookup (cached 60 s, misses too), the bot's own chat and echoes dropped,
 * de-duplicated on dedupeKey, stored (chat only when the profile keeps chat), pushed to the live feed and
 * to subscribed devices, then handed to the engine without waiting for the runs. Never throws.
 */
import { normaliseTwitch, normaliseKick, normaliseTip, publicEvent } from './events.js';

const CACHE_MS = 60_000;
const ECHO_MS = 30_000;
const CHAT_DEDUPE_MS = 10 * 60_000;

// Not stored in the event log (like chat when the profile keeps none): they can be very frequent.
const UNSTORED = new Set(['variable.changed']);

export function createIngest({ store, engine, feed, hub = null, logger = null, now = () => Date.now(), ignoreLogins = [], onChatLine = null } = {}) {
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBot] ${msg}`, meta); } catch { /* ignore */ } };
    const channelCache = new Map();   // 'platform:id' -> { at, list }
    const profileCache = new Map();   // profileId -> { at, profile }
    const echoes = new Map();         // 'platform:channelId' -> [{ text, at }]
    const chatSeen = new Map();       // dedupeKey -> at (chat is often not stored, so de-dupe in memory)
    const ignore = new Set(ignoreLogins.filter(Boolean).map((s) => String(s).toLowerCase()));

    async function cached(map, key, load) {
        const hit = map.get(key);
        if (hit && now() - hit.at < CACHE_MS) return hit.value;
        const value = await load();
        if (map.size > 20_000) map.clear();
        map.set(key, { at: now(), value });
        return value;
    }
    const profilesForChannel = (platform, id) => cached(channelCache, `${platform}:${id}`, () => store.profilesForChannel(platform, id));
    const profileById = (id) => cached(profileCache, id, () => store.getProfile(id));

    function noteSent(platform, channelId, text) {
        const k = `${platform}:${channelId}`;
        const list = (echoes.get(k) || []).filter((e) => now() - e.at < ECHO_MS);
        list.push({ text: String(text).trim().toLowerCase(), at: now() });
        echoes.set(k, list.slice(-50));
    }
    function isEcho(ev) {
        if (ev.type !== 'chat') return false;
        if (ev.user?.login && ignore.has(String(ev.user.login).toLowerCase())) return true;
        const list = (echoes.get(`${ev.platform}:${ev.channelId}`) || []).filter((e) => now() - e.at < ECHO_MS);
        const t = String(ev.message || '').trim().toLowerCase();
        return list.some((e) => e.text === t);
    }
    function chatDuplicate(key) {
        if (!key) return false;
        const t = now();
        if (chatSeen.size > 50_000) for (const [k, at] of chatSeen) if (t - at > CHAT_DEDUPE_MS) chatSeen.delete(k);
        if (chatSeen.has(key) && t - chatSeen.get(key) < CHAT_DEDUPE_MS) return true;
        chatSeen.set(key, t);
        return false;
    }

    /** Store, publish and run one event for one profile. Returns the event id (null when not stored) or 'duplicate'. */
    async function accept(target, ev, { run = true } = {}) {
        const profile = await profileById(target.profileId);
        if (!profile || !profile.enabled) return null;
        let eventId = null;
        const keep = ev.test || (UNSTORED.has(ev.type) ? false : ev.type !== 'chat' || profile.storeChat);
        if (keep) {
            eventId = await store.insertEvent(profile.id, ev);
            if (eventId === null && ev.dedupeKey) return 'duplicate';
        } else if (ev.dedupeKey && chatDuplicate(`${profile.id}:${ev.dedupeKey}`)) {   // no key: nothing to compare (was '<id>:null', so keyless events after the first were dropped)
            return 'duplicate';
        }
        const pub = publicEvent(ev, eventId);
        feed?.publish(profile.id, pub);
        try { hub?.publishEvent(profile.id, pub); } catch { /* sockets are best effort */ }
        if (run && !isEcho(ev)) {
            engine.handleEvent(profile, ev, eventId).catch((err) => log('error', 'engine failed', { profileId: profile.id, error: err?.message }));
        }
        return eventId;
    }

    async function fanOut(platform, ev) {
        if (!ev || ev.channelId == null) return 0;
        if (ev.type === 'chat' && onChatLine && !isEcho(ev)) { try { onChatLine(platform, ev.channelId); } catch { /* counting is best effort */ } }
        const targets = await profilesForChannel(platform, ev.channelId);
        let n = 0;
        for (const t of targets) if ((await accept(t, ev)) !== 'duplicate') n++;
        return n;
    }

    const safe = (name, fn) => async (...args) => {
        try { return await fn(...args); } catch (err) {
            log('warn', `${name} ingest failed`, { error: err?.message });
            return 0;
        }
    };

    return {
        twitch: safe('twitch', async (subType, event, specKey) => fanOut('twitch', normaliseTwitch(subType, event, specKey))),
        kick: safe('kick', async (eventType, event) => fanOut('kick', normaliseKick(eventType, event))),
        tip: safe('tip', async (source, payload, ref) => {
            const ev = normaliseTip(source, payload);
            if (!ev) return 0;
            const targets = await store.profilesForTip(source, String(ref ?? '').toLowerCase());
            for (const t of targets) {
                await accept(t, ev);
                store.touchTipSource(t.sourceId).catch(() => {});
            }
            return targets.length;
        }),
        tipForSource: safe('tip feed', async (row, payload) => {
            const ev = normaliseTip(row.source, payload);
            if (!ev) return 0;
            await accept({ profileId: row.profileId }, ev);
            store.touchTipSource(row.id).catch(() => {});
            return 1;
        }),
        studio: safe('studio', async (profileId, ev) => {
            if (!ev || ev.platform !== 'studio') return 0;
            await accept({ profileId: Number(profileId) }, ev);
            return 1;
        }),
        internal: safe('internal', async (profileId, ev) => {
            if (!ev || !['studio', 'bot'].includes(ev.platform)) return 0;
            await accept({ profileId: Number(profileId) }, ev);
            return 1;
        }),
        async recordTest(profile, ev) {
            const id = await store.insertEvent(profile.id, { ...ev, test: true });
            const pub = publicEvent({ ...ev, test: true }, id);
            feed?.publish(profile.id, pub);
            try { hub?.publishEvent(profile.id, pub); } catch { /* ignore */ }
            return id;
        },
        noteSent,
        isEcho,
        invalidate(profileId = null) {
            channelCache.clear();
            if (profileId == null) profileCache.clear(); else profileCache.delete(Number(profileId));
        },
    };
}

export default { createIngest };
