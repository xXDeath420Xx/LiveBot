/*
 * Stream bot heart rate: the pure rules (Studio 0.2.14; no I/O).
 *
 *   HEART_RATE           the "Heart rate" trigger (events.js registerEventType): platform 'studio' (the watch through
 *                        CertiFried Studio) or 'bot' (the Pulsoid fallback), with its settings (TRIGGER_CONFIG):
 *                          mode         above | below | crossing
 *                          bpm          the line, 30 to 240
 *                          holdSec      how long it must stay there first, 0 to 600 s
 *                          cooldownSec  the least time between two runs, 0 to 3600 s
 *   ruleKey(cfg)         'above:140:10:60': automations with the same settings share one rule state and run together
 *   createRuleState()    → state for stepRule
 *   stepRule(st, cfg, bpm, t, { gapMs })  → null | { direction: 'up' | 'down' }   one reading against one rule:
 *     above / below  runs once each time the heart rate goes past the line and stays there holdSec; it can run again only
 *                    after it came back over the line (and the cooldown is over). A cooldown that blocks the first moment
 *                    lets it run as soon as the cooldown ends, if it is still past the line.
 *     crossing       runs each time it settles on the other side of the line for holdSec, either way (direction up or
 *                    down). The first side seen is only recorded. A crossing inside the cooldown moves the side but does
 *                    not run.
 *     Exactly on the line counts as neither side. A gap of gapMs (15 s) without readings starts the hold again.
 *   cleanReading(params, now)  Studio's 'heart.rate' request → { bpm, at, contact, rr, battery } | null
 *   parsePulsoid(text)   a Pulsoid WebSocket message (v2 { type: 'heart_rate', heartRate: { bpm } }, v1 { data: { heart_rate } },
 *                        or a bare number) → { bpm, at } | null
 *
 * Tested in tests/stream-bot-heart.test.js.
 */
export const HEART_MODES = Object.freeze(['above', 'below', 'crossing']);
export const BPM_LIMITS = Object.freeze([25, 250]);
export const GAP_MS = 15_000;

export const TRIGGER_CONFIG = Object.freeze([
    { name: 'mode', kind: 'select', label: 'When', options: [...HEART_MODES], default: 'above',
        optionLabels: { above: 'It goes above', below: 'It drops below', crossing: 'It crosses, either way' } },
    { name: 'bpm', kind: 'number', label: 'Beats per minute', min: 30, max: 240, default: 120 },
    { name: 'holdSec', kind: 'number', label: 'For at least (seconds)', min: 0, max: 600, default: 5,
        help: 'It must stay past the line this long before the automation runs. 0 runs at once.' },
    { name: 'cooldownSec', kind: 'number', label: 'Wait before it can run again (seconds)', min: 0, max: 3600, default: 60 },
]);

const num = (v, d, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
/** Settings with defaults filled in and kept in range (validateTrigger has already refused bad saves). */
export function ruleOf(cfg = {}) {
    return {
        mode: HEART_MODES.includes(cfg?.mode) ? cfg.mode : 'above',
        bpm: num(cfg?.bpm, 120, 30, 240),
        holdSec: num(cfg?.holdSec, 5, 0, 600),
        cooldownSec: num(cfg?.cooldownSec, 60, 0, 3600),
    };
}
export function ruleKey(cfg) { const r = ruleOf(cfg); return `${r.mode}:${r.bpm}:${r.holdSec}:${r.cooldownSec}`; }

export const createRuleState = () => ({ since: null, armed: true, lastFire: null, side: null, pending: null, lastAt: null });

export function stepRule(st, cfg, bpm, t, { gapMs = GAP_MS } = {}) {
    const r = ruleOf(cfg);
    if (st.lastAt != null && t - st.lastAt > gapMs) { st.since = null; st.pending = null; }
    st.lastAt = t;
    const holdMs = r.holdSec * 1000;
    const cooled = st.lastFire == null || t - st.lastFire >= r.cooldownSec * 1000;
    if (r.mode === 'above' || r.mode === 'below') {
        const past = r.mode === 'above' ? bpm > r.bpm : bpm < r.bpm;
        if (!past) { st.since = null; st.armed = true; return null; }
        if (st.since == null) st.since = t;
        if (!st.armed || t - st.since < holdMs || !cooled) return null;
        st.armed = false;
        st.lastFire = t;
        return { direction: r.mode === 'above' ? 'up' : 'down' };
    }
    const side = bpm > r.bpm ? 'high' : bpm < r.bpm ? 'low' : null;
    if (side == null || side === st.side) { if (side === st.side) st.pending = null; return null; }
    if (!st.pending || st.pending.side !== side) st.pending = { side, since: t };
    if (t - st.pending.since < holdMs) return null;
    const first = st.side == null;
    st.side = side;
    st.pending = null;
    if (first || !cooled) return null;
    st.lastFire = t;
    return { direction: side === 'high' ? 'up' : 'down' };
}

const bpmOf = (v) => { const n = Number(v); return Number.isInteger(n) && n >= BPM_LIMITS[0] && n <= BPM_LIMITS[1] ? n : null; };

export function cleanReading(p, nowMs = Date.now()) {
    if (!p || typeof p !== 'object') return null;
    const bpm = bpmOf(p.bpm);
    if (bpm == null) return null;
    const at = Number(p.at);
    const rr = (Array.isArray(p.rr) ? p.rr : []).map(Number).filter((x) => Number.isInteger(x) && x >= 200 && x <= 3000).slice(0, 8);
    const battery = Number(p.battery);
    return {
        bpm,
        // Studio's clock may be off a little; a time far from ours is replaced by ours
        at: Number.isFinite(at) && Math.abs(at - nowMs) < 60_000 ? Math.round(at) : nowMs,
        contact: p.contact === true ? true : p.contact === false ? false : null,
        rr,
        battery: Number.isInteger(battery) && battery >= 0 && battery <= 100 ? battery : null,
    };
}

export function parsePulsoid(text, nowMs = Date.now()) {
    const s = String(text ?? '').trim();
    if (/^\d{2,3}$/.test(s)) { const bpm = bpmOf(s); return bpm == null ? null : { bpm, at: nowMs }; }
    let m;
    try { m = JSON.parse(s); } catch { return null; }
    if (!m || typeof m !== 'object') return null;
    let bpm = null;
    let at = null;
    if (m.type === 'heart_rate' && m.heartRate) { bpm = bpmOf(m.heartRate.bpm); at = Date.parse(m.timestamp); }
    else if (m.data && m.data.heart_rate != null) { bpm = bpmOf(m.data.heart_rate); at = Number(m.measured_at); }
    if (bpm == null) return null;
    return { bpm, at: Number.isFinite(at) && Math.abs(at - nowMs) < 60_000 ? at : nowMs };
}

export const HEART_RATE = Object.freeze({
    type: 'heart.rate', label: 'Heart rate', group: 'CertiFried Studio', platforms: ['studio', 'bot'], fields: ['amount'], config: TRIGGER_CONFIG,
    sample: Object.freeze({ amount: 142, currency: 'bpm', metadata: Object.freeze({ bpm: 142, line: 140, mode: 'above', direction: 'up', source: 'studio', rule: 'above:140:5:60' }) }),
    // The heart-rate service raises one event per rule that ran (heart/service.js); every automation with those settings matches.
    match: (cfg, ev) => !!ev.test || ev.metadata?.rule === ruleKey(cfg),
});

export default { HEART_MODES, TRIGGER_CONFIG, HEART_RATE, ruleOf, ruleKey, createRuleState, stepRule, cleanReading, parsePulsoid, GAP_MS, BPM_LIMITS };
