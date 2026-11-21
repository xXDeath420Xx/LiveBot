/*
 * Stream bot heart rate (Studio 0.2.14): the watch's heart rate, read by CertiFried Studio over Bluetooth LE and sent here at
 * most once a second, with Pulsoid as an optional fallback. Module map:
 *
 *   rules.js    the "Heart rate" trigger, its settings and rules (above / below / crossing, held for N s, cooldown),
 *               reading clean-up and Pulsoid's message format (pure)
 *   service.js  the live figures per profile (memory only), the source switch, rules → events, {heart.*} values
 *   pulsoid.js  the Pulsoid WebSocket with the streamer's token
 *
 *   attachHeart(box, { onRequest }) → { service, pulsoid, onRequest, start(), stop() }
 *     Called once from core/stream-bot/index.js build(), before the overlays (whose request wrapper then hands 'heart.*'
 *     on to this one). It registers, through the existing hooks:
 *       events.js     the 'heart.rate' trigger and its feed line           conditions.js  'heart_rate' (heart rate right now)
 *       render.js     {heart.bpm} {heart.max} {heart.min} {heart.avg}       ingest.js      'heart.rate' kept out of the event log
 *     and wraps feed.publish (a stream going live starts the figures again) and Studio's requests ('heart.rate').
 *     The overlays reach it through box.heart (initial state) and the service's onView (live frames).
 *     start() opens the Pulsoid sockets of profiles that saved a token (startStreamBot).
 */
import { createHeartService, HeartRequestError } from './service.js';
import { createPulsoidFeeds } from './pulsoid.js';
import { HEART_RATE } from './rules.js';

export const HEART_VARS = Object.freeze([
    { token: '{heart.bpm}', description: 'Your heart rate now, from your watch (empty when no reading for 15 seconds)' },
    { token: '{heart.max}', description: 'Your highest heart rate this stream' },
    { token: '{heart.min}', description: 'Your lowest heart rate this stream' },
    { token: '{heart.avg}', description: 'Your average heart rate this stream' },
]);
const VAR_NAMES = ['heart.bpm', 'heart.max', 'heart.min', 'heart.avg'];

export function heartCondition(serviceRef) {
    return {
        type: 'heart_rate', label: 'Heart rate now', help: 'Only when your heart rate, from your watch, is above or below a number right now.',
        fields: [
            { name: 'op', kind: 'select', label: 'Is', options: ['above', 'below'], default: 'above', optionLabels: { above: 'Above', below: 'Below' } },
            { name: 'bpm', kind: 'number', label: 'Beats per minute', min: 30, max: 240, step: 1, default: 120 },
        ],
        load: { key: 'heart', fn: ({ profileId }) => serviceRef.current?.view(profileId) || null },
        check(c, _ev, ctx) {
            const v = ctx?.loaded?.heart;
            if (!v || !v.live || v.bpm == null) return { ok: false, detail: 'no heart rate in the last 15 seconds' };
            const ok = c.op === 'below' ? v.bpm < c.bpm : v.bpm > c.bpm;
            return { ok, detail: `heart rate ${v.bpm}; needs ${c.op === 'below' ? 'below' : 'above'} ${c.bpm}` };
        },
        validate(c, err) {
            const n = Number(c.bpm);
            if (!Number.isFinite(n) || n < 30 || n > 240) err('Heart rate now: beats per minute from 30 to 240.');
            return { type: 'heart_rate', op: c.op === 'below' ? 'below' : 'above', bpm: Number.isFinite(n) ? Math.min(240, Math.max(30, Math.round(n))) : 120 };
        },
    };
}

/** The feed line for a heart-rate event. */
export function describeHeart(ev) {
    if (ev?.type !== 'heart.rate') return null;
    const m = ev.metadata || {};
    const what = m.mode === 'crossing' ? `crossed ${m.line} going ${m.direction === 'down' ? 'down' : 'up'}` : m.mode === 'below' ? `dropped below ${m.line}` : `went above ${m.line}`;
    return `Heart rate ${what} (${ev.amount ?? m.bpm} BPM)`;
}

export async function attachHeart(box, { onRequest = null } = {}) {
    const { store, ingest, feed, hub, logger } = box;
    const [eventsMod, renderMod, conditionsMod] = await Promise.all([import('../events.js'), import('../render.js'), import('../conditions.js')]);
    const ref = { current: null };
    const service = createHeartService({
        store, ingest, logger,
        onView: (profileId, view) => box.overlays?.service?.onHeart?.(profileId, view),
    });
    ref.current = service;

    eventsMod.registerEventType(HEART_RATE);
    eventsMod.registerDescriber?.(describeHeart);
    renderMod.registerTemplateVars({ names: VAR_NAMES, vars: HEART_VARS, values: ({ profileId }) => (profileId ? service.templateValues(profileId) : {}) });
    conditionsMod.registerConditionType(heartCondition(ref));
    // Health data: a heart-rate event runs automations and shows in the live feed, but is never written to the event log.
    ingest.allowInternal?.('heart.rate', { store: false });

    const publish = feed.publish.bind(feed);
    feed.publish = (profileId, ev) => {
        publish(profileId, ev);
        if (ev && !ev.test && (ev.type === 'stream.online' || ev.type === 'obs.stream_started')) service.resetStream(profileId);
    };

    const pulsoid = createPulsoidFeeds({
        listSources: () => store.heartPulsoidSources(),
        onReading: (profileId, r) => service.reading(profileId, 'pulsoid', r),
        setStatus: (profileId, status, error) => store.setHeartPulsoidStatus(profileId, status, error).catch(() => {}),
        logger,
    });

    const handle = (conn, method, params) => {
        if (String(method).startsWith('heart.')) {
            return service.onRequest(conn, method, params).catch((e) => {
                if (e instanceof HeartRequestError) throw Object.assign(new Error(e.message), { code: e.code });
                throw e;
            });
        }
        return onRequest ? onRequest(conn, method, params) : Promise.reject(Object.assign(new Error('Unknown method'), { code: 'unknown_method' }));
    };
    hub.use({ onRequest: handle });
    return {
        service, pulsoid, onRequest: handle,
        async start() { await pulsoid.start(); },
        stop() { pulsoid.stop(); },
    };
}

export default { attachHeart, heartCondition, describeHeart, HEART_VARS };
