/*
 * Stream bot heart rate: the live side (Studio 0.2.14). Heart rate is health data, so it is kept in memory only: no reading
 * is written to the database or the event log (design §2.6). What reaches the database is what the streamer makes of it: a
 * run of a "Heart rate" automation keeps the reading that started it in its run log, like any run, and text the automation
 * posts (a chat reply with {heart.bpm}) is the streamer's choice.
 *
 *   createHeartService({ store, ingest, now, logger, limits, onView })
 *     reading(profileId, source, r) → 'ok' | 'standby' | 'bad'
 *         source 'studio': the watch through CertiFried Studio over Bluetooth (heart.rate requests, at most one a second)
 *         source 'pulsoid': the optional fallback (pulsoid.js). It is used only while Studio has sent nothing for freshMs
 *         (10 s); otherwise its readings are kept aside ('standby') so the switch is immediate.
 *       An applied reading updates the stream's figures, the overlay (onView, at most once a second per profile) and
 *       every enabled "Heart rate" automation's rule (rules.js stepRule); a rule that runs raises one 'heart.rate' event
 *       through ingest.internal (not stored: ingest.allowInternal('heart.rate', { store: false })).
 *     view(profileId) → { bpm, at, live, source, min, max, avg, count, battery, history: [bpm …] }  (history: one point a
 *         second, the last historySec)
 *     templateValues(profileId) → { 'heart.bpm', 'heart.max', 'heart.min', 'heart.avg' }  (empty strings with no reading)
 *     resetStream(profileId)        the stream went live (stream.online / OBS stream started): min / max / avg start again
 *     invalidate(profileId)         automations changed: their rules are read again
 *     currentSource(profileId) → 'studio' | 'pulsoid' | null
 *     onRequest(conn, method, params)   Studio's 'heart.rate' request (Studio only, freshly cleaned, 90 a minute)
 *   The figures also start again on their own after statsResetMs (6 h) without a reading.
 *
 * Tested in tests/stream-bot-heart.test.js.
 */
import { cleanReading, createRuleState, stepRule, ruleKey, ruleOf } from './rules.js';

export const HEART_LIMITS = Object.freeze({ freshMs: 10_000, liveMs: 15_000, statsResetMs: 6 * 3600_000, historySec: 120, studioPerMinute: 90, rulesCacheMs: 30_000, viewMs: 900, profiles: 5000 });

export class HeartRequestError extends Error { constructor(code, message) { super(message || code); this.code = code; } }

export function createHeartService({ store, ingest = null, now = () => Date.now(), logger = null, limits = {}, onView = null } = {}) {
    const L = { ...HEART_LIMITS, ...limits };
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBotHeart] ${msg}`, meta); } catch { /* ignore */ } };
    const P = new Map();   // profileId -> state

    function stateOf(profileId) {
        const id = Number(profileId);
        let s = P.get(id);
        if (!s) {
            if (P.size >= L.profiles) P.clear();
            s = { bpm: null, at: null, source: null, battery: null, studioAt: null, pulsoidAt: null, pulsoid: null,
                min: null, max: null, sum: 0, count: 0, history: [], rules: new Map(), automations: null, automationsAt: 0, viewAt: 0, loading: null };
            P.set(id, s);
        }
        return s;
    }

    function resetFigures(s) { s.min = null; s.max = null; s.sum = 0; s.count = 0; }

    async function rulesFor(profileId, s) {
        if (s.automations && now() - s.automationsAt < L.rulesCacheMs) return s.automations;
        if (!s.loading) {
            s.loading = (async () => {
                try { s.automations = await store.enabledAutomationsFor(Number(profileId), 'heart.rate'); } catch (e) { log('warn', 'automations not read', { error: e?.message }); s.automations = s.automations || []; }
                s.automationsAt = now();
                s.loading = null;
                return s.automations;
            })();
        }
        return s.loading;
    }

    async function runRules(profileId, s, t, bpm, source) {
        if (!ingest?.internal) return 0;
        const list = await rulesFor(profileId, s);
        const keys = new Map();
        for (const a of list) { const k = ruleKey(a.trigger_config || {}); if (!keys.has(k)) keys.set(k, a.trigger_config || {}); }
        for (const k of [...s.rules.keys()]) if (!keys.has(k)) s.rules.delete(k);
        let fired = 0;
        for (const [k, cfg] of keys) {
            let st = s.rules.get(k);
            if (!st) { st = createRuleState(); s.rules.set(k, st); }
            const hit = stepRule(st, cfg, bpm, t);
            if (!hit) continue;
            const r = ruleOf(cfg);
            fired++;
            await ingest.internal(Number(profileId), {
                platform: source === 'pulsoid' ? 'bot' : 'studio', type: 'heart.rate', channelId: null, user: null,
                amount: bpm, currency: 'bpm', message: null,
                metadata: { bpm, line: r.bpm, mode: r.mode, direction: hit.direction, holdSec: r.holdSec, source, rule: k },
                raw: null, occurredAt: new Date(t), dedupeKey: null,
            });
        }
        return fired;
    }

    function apply(profileId, s, source, r) {
        const t = r.at;
        if (s.at != null && t - s.at > L.statsResetMs) resetFigures(s);
        s.bpm = r.bpm;
        s.at = t;
        s.source = source;
        if (r.battery != null) s.battery = r.battery;
        s.min = s.min == null ? r.bpm : Math.min(s.min, r.bpm);
        s.max = s.max == null ? r.bpm : Math.max(s.max, r.bpm);
        s.sum += r.bpm;
        s.count += 1;
        const sec = Math.floor(t / 1000);
        const last = s.history[s.history.length - 1];
        if (last && last.sec === sec) last.bpm = r.bpm; else s.history.push({ sec, bpm: r.bpm });
        while (s.history.length && s.history[0].sec <= sec - L.historySec) s.history.shift();
        if (onView && now() - s.viewAt >= L.viewMs) {
            s.viewAt = now();
            try { onView(Number(profileId), view(profileId)); } catch { /* the overlay is best effort */ }
        }
        runRules(profileId, s, t, r.bpm, source).catch((e) => log('warn', 'heart-rate rules failed', { error: e?.message }));
    }

    function reading(profileId, source, raw) {
        const t = now();
        const r = cleanReading(raw, t);
        if (!r || !['studio', 'pulsoid'].includes(source)) return 'bad';
        const s = stateOf(profileId);
        if (source === 'studio') {
            s.studioAt = t;
            apply(profileId, s, 'studio', r);
            return 'ok';
        }
        s.pulsoidAt = t;
        s.pulsoid = r;
        if (s.studioAt != null && t - s.studioAt < L.freshMs) return 'standby';
        if (s.source === 'studio') log('info', 'heart rate: no reading from Studio for 10 s, using Pulsoid', { profileId: Number(profileId) });
        apply(profileId, s, 'pulsoid', r);
        return 'ok';
    }

    function currentSource(profileId) {
        const s = P.get(Number(profileId));
        if (!s) return null;
        const t = now();
        if (s.studioAt != null && t - s.studioAt < L.freshMs) return 'studio';
        if (s.pulsoidAt != null && t - s.pulsoidAt < L.freshMs) return 'pulsoid';
        return null;
    }

    function view(profileId) {
        const s = P.get(Number(profileId));
        if (!s || s.bpm == null) return { bpm: null, at: null, live: false, source: null, min: null, max: null, avg: null, count: 0, battery: null, history: [] };
        const t = now();
        const nowSec = Math.floor(t / 1000);
        return {
            bpm: s.bpm, at: new Date(s.at).toISOString(), live: t - s.at < L.liveMs, source: s.source,
            min: s.min, max: s.max, avg: s.count ? Math.round(s.sum / s.count) : null, count: s.count, battery: s.battery,
            history: s.history.filter((h) => h.sec > nowSec - L.historySec).map((h) => h.bpm),
        };
    }

    function templateValues(profileId) {
        const v = view(profileId);
        const str = (n) => (n == null ? '' : String(n));
        return { 'heart.bpm': v.live ? str(v.bpm) : '', 'heart.max': str(v.max), 'heart.min': str(v.min), 'heart.avg': str(v.avg) };
    }

    function within(conn, key, max, windowMs) {
        const t = now();
        conn[key] = (conn[key] || []).filter((x) => t - x < windowMs);
        if (conn[key].length >= max) return false;
        conn[key].push(t);
        return true;
    }

    return {
        reading, view, templateValues, currentSource,
        resetStream(profileId) {
            const s = P.get(Number(profileId));
            if (!s) return;
            resetFigures(s);
            if (s.bpm != null && now() - s.at < L.liveMs) { s.min = s.bpm; s.max = s.bpm; s.sum = s.bpm; s.count = 1; }
        },
        invalidate(profileId) { const s = P.get(Number(profileId)); if (s) s.automationsAt = 0; },
        async onRequest(conn, method, params = {}) {
            if (method !== 'heart.rate') throw new HeartRequestError('unknown_method', 'Unknown method');
            if (conn?.kind !== 'studio') throw new HeartRequestError('bad_params', 'Only CertiFried Studio sends heart rate');
            if (!within(conn, '_heart', L.studioPerMinute, 60_000)) throw new HeartRequestError('rate', 'Too many heart-rate readings; at most one a second');
            const r = reading(conn.profileId, 'studio', params);
            if (r === 'bad') throw new HeartRequestError('bad_params', 'A heart rate is a whole number from 25 to 250');
            return { ok: true };
        },
        _state: P,
    };
}

export default { createHeartService, HEART_LIMITS, HeartRequestError };
