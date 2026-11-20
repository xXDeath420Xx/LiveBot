/*
 * Stream bot: trigger matching and conditions (design §2.3). Pure apart from the cooldown / rate-limit
 * state object, which the engine owns (one per process; tests make their own).
 *
 *   triggerMatches(automation, event)            trigger type, platform filter, chat `match`
 *   checkConditions(conditions, event, ctx)      → { ok, results: [{ type, ok, detail }], failed }
 *   createLimiter({ now })                       cooldown + rate-limit memory: check(), record()
 *   validateConditions(list) / validateTrigger() → { ok, errors[], value }  (dashboard saves)
 *   registerConditionType(def)                   feature conditions (core/stream-bot/viewers): def.check / def.validate, and
 *                                                def.load { key, fn } for data read before the check (loadConditionData)
 *
 * Tested in tests/stream-bot-engine.test.js.
 */
import { ROLES, isEventType, eventType } from './events.js';

export const CONDITION_TYPES = [   // not frozen: registerConditionType() adds feature conditions (core/stream-bot/viewers)
    { type: 'role', label: 'Viewer role', help: 'Only when the person has (or does not have) one of these roles.' },
    { type: 'amount', label: 'Amount range', help: 'Bits, viewers, months, gift count or tip amount between a minimum and a maximum.' },
    { type: 'text', label: 'Text match', help: 'The message, name or reward matches some text.' },
    { type: 'metadata', label: 'Event detail', help: 'A detail of the event, such as the reward title or the sub tier.' },
    { type: 'cooldown', label: 'Cooldown', help: 'Wait this long before running again, for everyone or per person.' },
    { type: 'rate_limit', label: 'Rate limit', help: 'Run at most this many times in a window, for everyone or per person.' },
];

const REGISTERED = new Map();
/**
 * Registration hook for feature modules (core/stream-bot/viewers/register.js): { type, label, help, fields, check(c, ev, ctx),
 * validate(c, err) → value, load?: { key, fn({ ev, profileId }) } }. check reads ctx.loaded[load.key]. Pure apart from load.
 */
export function registerConditionType(def) {
    if (!def?.type || REGISTERED.has(def.type) || CONDITION_TYPES.some((c) => c.type === def.type) || typeof def.check !== 'function' || typeof def.validate !== 'function') return false;
    REGISTERED.set(def.type, def);
    CONDITION_TYPES.push({ type: def.type, label: def.label, help: def.help || '', fields: def.fields || [] });
    return true;
}
/** Data registered conditions read (the viewer's points and so on), loaded once per run before the checks. Never throws. */
export async function loadConditionData(conditions, ev, { profileId } = {}) {
    const loaded = {};
    for (const c of conditions || []) {
        const def = REGISTERED.get(c?.type);
        if (!def?.load || loaded[def.load.key] !== undefined) continue;
        try { loaded[def.load.key] = await def.load.fn({ ev, profileId }); } catch { loaded[def.load.key] = null; }
    }
    return loaded;
}

export const MATCH_MODES = Object.freeze(['command', 'contains', 'exact', 'starts', 'word', 'regex']);
/** Power-up or Bits trigger: which uses (channel.bits.use `type`, or the power-up's own type). */
export const BITS_KINDS = Object.freeze(['any', 'cheer', 'power_up', 'combo', 'message_effect', 'celebration', 'gigantify_an_emote']);
export const METADATA_OPS = Object.freeze(['eq', 'neq', 'contains', 'in', 'gt', 'lt']);
export const LIMITS = Object.freeze({ conditions: 10, text: 500, regex: 200, regexInput: 1000, cooldownMax: 86400, windowMax: 86400, countMax: 1000 });
const PATH = /^[a-z0-9_]+(?:\.[a-z0-9_]+){0,4}$/i;

// ── trigger ─────────────────────────────────────────────────────────────────────────────────

function safeRegex(src, flags) {
    if (typeof src !== 'string' || !src || src.length > LIMITS.regex) return null;
    // Reject nested quantifiers like (a+)+ that backtrack catastrophically.
    if (/\([^)]*[+*][^)]*\)[+*{]/.test(src)) return null;
    try { return new RegExp(src, flags); } catch { return null; }
}

/** Text match used by the chat trigger and the text condition. */
export function textMatches(haystack, { mode = 'contains', text = '', caseSensitive = false } = {}) {
    const raw = String(haystack ?? '');
    if (mode === 'regex') {
        const re = safeRegex(String(text), caseSensitive ? '' : 'i');
        return !!re && re.test(raw.slice(0, LIMITS.regexInput));
    }
    const h = caseSensitive ? raw.trim() : raw.trim().toLowerCase();
    const n = caseSensitive ? String(text).trim() : String(text).trim().toLowerCase();
    if (!n) return false;
    switch (mode) {
        case 'exact': return h === n;
        case 'starts': return h.startsWith(n);
        case 'command': {
            const first = h.split(/\s+/)[0];
            return first === n || first === (n.startsWith('!') ? n : `!${n}`);
        }
        case 'word': return new RegExp(`(^|[^\\p{L}\\p{N}_])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}_])`, 'u').test(h);
        case 'contains':
        default: return h.includes(n);
    }
}

/** Voice phrases compare lower case, trimmed, with runs of spaces as one. */
export function normalisePhrase(s) {
    return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function triggerMatches(automation, ev) {
    if (!automation || !ev || automation.trigger_type !== ev.type) return false;
    const cfg = automation.trigger_config || {};
    if (Array.isArray(cfg.platforms) && cfg.platforms.length && !cfg.platforms.includes(ev.platform) && ev.platform !== 'test') return false;
    if (ev.type === 'bits.used' && cfg.bitsKind && cfg.bitsKind !== 'any') {
        const m = ev.metadata || {};
        if (['cheer', 'power_up', 'combo'].includes(cfg.bitsKind) ? m.kind !== cfg.bitsKind : m.powerUp !== cfg.bitsKind) return false;
    }
    if (ev.type === 'variable.changed') {
        if (cfg.key && String(ev.metadata?.key || '') !== cfg.key) return false;
        if (cfg.scope && cfg.scope !== 'any' && ev.metadata?.scope !== cfg.scope) return false;
    }
    if (ev.type === 'chat' && cfg.match && cfg.match.text) return textMatches(ev.message, cfg.match);
    if (ev.type === 'voice.phrase' && Array.isArray(cfg.phrases) && cfg.phrases.length) {
        const said = normalisePhrase(ev.message ?? ev.metadata?.phrase);
        return cfg.phrases.some((p) => normalisePhrase(p) === said);
    }
    return true;
}

// ── cooldowns and rate limits ───────────────────────────────────────────────────────────────

/** In-memory cooldown and rate-limit state, keyed by automation (and person for per-user scope). */
export function createLimiter({ now = () => Date.now(), maxKeys = 50_000 } = {}) {
    const last = new Map();      // key -> ms of the last counted run
    const windows = new Map();   // key -> ms[] of counted runs
    const keyOf = (automationId, c, ev) => `${automationId}|${c.type}|${c.scope === 'user' ? `u:${ev.platform}:${ev.user?.id || ev.user?.login || ev.user?.name || '?'}` : 'g'}`;
    function trim() {
        if (last.size > maxKeys) last.clear();
        if (windows.size > maxKeys) windows.clear();
    }
    return {
        /** { ok, detail } for one cooldown or rate_limit condition, without recording. */
        check(automationId, c, ev) {
            const k = keyOf(automationId, c, ev);
            const t = now();
            if (c.type === 'cooldown') {
                const prev = last.get(k);
                const ms = Number(c.seconds) * 1000;
                if (prev != null && t - prev < ms) return { ok: false, detail: `cooling down, ${Math.ceil((ms - (t - prev)) / 1000)} s left` };
                return { ok: true, detail: `${c.scope === 'user' ? 'per person' : 'global'} cooldown ${c.seconds} s` };
            }
            const win = Number(c.windowSeconds) * 1000;
            const list = (windows.get(k) || []).filter((x) => t - x < win);
            windows.set(k, list);
            if (list.length >= Number(c.count)) return { ok: false, detail: `rate limit reached (${c.count} in ${c.windowSeconds} s)` };
            return { ok: true, detail: `${list.length} of ${c.count} in ${c.windowSeconds} s` };
        },
        /** The run went ahead: start cooldowns and count it in rate-limit windows. */
        record(automationId, conditions, ev) {
            const t = now();
            for (const c of conditions || []) {
                if (c.type !== 'cooldown' && c.type !== 'rate_limit') continue;
                const k = keyOf(automationId, c, ev);
                if (c.type === 'cooldown') last.set(k, t);
                else windows.set(k, [...(windows.get(k) || []), t]);
            }
            trim();
        },
        reset() { last.clear(); windows.clear(); },
    };
}

// ── conditions ──────────────────────────────────────────────────────────────────────────────

function pick(obj, path) {
    let v = obj;
    for (const part of String(path).split('.')) {
        if (v == null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, part)) return undefined;
        v = v[part];
    }
    return v;
}

function checkOne(c, ev, ctx) {
    switch (c.type) {
        case 'role': {
            const want = (c.roles || []).filter((r) => r === 'everyone' || ROLES.includes(r));
            if (!want.length || want.includes('everyone')) return { ok: c.mode !== 'none', detail: 'everyone' };
            const have = ev.user?.roles || [];
            const hit = want.some((r) => have.includes(r));
            const ok = c.mode === 'none' ? !hit : hit;
            return { ok, detail: `${c.mode === 'none' ? 'not ' : ''}${want.join(' or ')}; has ${have.length ? have.join(', ') : 'no role'}` };
        }
        case 'amount': {
            if (ev.amount == null) return { ok: false, detail: 'event has no amount' };
            if (c.currency && String(ev.currency || '').toLowerCase() !== String(c.currency).toLowerCase()) return { ok: false, detail: `currency ${ev.currency || 'none'} is not ${c.currency}` };
            const n = Number(ev.amount);
            if (c.min != null && c.min !== '' && n < Number(c.min)) return { ok: false, detail: `${n} is below ${c.min}` };
            if (c.max != null && c.max !== '' && n > Number(c.max)) return { ok: false, detail: `${n} is above ${c.max}` };
            return { ok: true, detail: `${n} in range` };
        }
        case 'text': {
            const field = c.field === 'user' ? (ev.user?.name || ev.user?.login || '') : c.field === 'reward' ? (ev.metadata?.reward || '') : (ev.message || '');
            const ok = textMatches(field, c);
            return { ok, detail: `${c.field || 'message'} ${ok ? 'matches' : 'does not match'} ${c.mode || 'contains'} "${String(c.text).slice(0, 40)}"` };
        }
        case 'metadata': {
            const v = pick(ev.metadata || {}, c.path);
            const s = v == null ? '' : String(v);
            const want = String(c.value ?? '');
            let ok;
            switch (c.op) {
                case 'neq': ok = s.toLowerCase() !== want.toLowerCase(); break;
                case 'contains': ok = s.toLowerCase().includes(want.toLowerCase()); break;
                case 'in': ok = want.split('|').map((x) => x.trim().toLowerCase()).filter(Boolean).includes(s.trim().toLowerCase()); break;
                case 'gt': ok = Number(v) > Number(want); break;
                case 'lt': ok = Number(v) < Number(want); break;
                case 'eq': default: ok = s.toLowerCase() === want.toLowerCase(); break;
            }
            return { ok, detail: `${c.path} is "${s.slice(0, 40)}"` };
        }
        case 'cooldown':
        case 'rate_limit': {
            const r = ctx.limiter ? ctx.limiter.check(ctx.automationId, c, ev) : { ok: true, detail: 'not tracked' };
            if (!r.ok && ctx.test) return { ok: true, detail: `${r.detail} (ignored for a test)` };
            return r;
        }
        default: {
            const def = REGISTERED.get(c.type);
            if (def) { try { return def.check(c, ev, ctx); } catch { return { ok: false, detail: 'could not check' }; } }
            return { ok: false, detail: `unknown condition ${c.type}` };
        }
    }
}

/**
 * @param {object[]} conditions
 * @param {object} ev       normalised event
 * @param {object} ctx      { limiter, automationId, test }
 */
export function checkConditions(conditions, ev, ctx = {}) {
    const results = [];
    let failed = null;
    for (const c of conditions || []) {
        const r = checkOne(c, ev, ctx);
        results.push({ type: c.type, ok: r.ok, detail: r.detail });
        if (!r.ok && !failed) failed = { type: c.type, detail: r.detail };
    }
    return { ok: !failed, results, failed };
}

// ── validation (dashboard saves) ────────────────────────────────────────────────────────────

const clampInt = (v, lo, hi) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
};
const text = (v, max = LIMITS.text) => String(v ?? '').slice(0, max);

export function validateTrigger(type, cfg = {}) {
    const errors = [];
    if (!isEventType(type)) return { ok: false, errors: ['Pick a trigger.'], value: null };
    const def = eventType(type);
    const value = {};
    if (Array.isArray(cfg.platforms)) {
        const p = cfg.platforms.filter((x) => def.platforms.includes(x));
        if (p.length) value.platforms = [...new Set(p)];
    }
    if (type === 'chat') {
        const m = cfg.match || {};
        const mode = MATCH_MODES.includes(m.mode) ? m.mode : 'command';
        const t = text(m.text, 200).trim();
        if (!t) errors.push('A chat trigger needs the command or text to listen for.');
        if (mode === 'regex' && !safeRegex(t, 'i')) errors.push('That pattern is not allowed (too long, invalid or too slow to check).');
        value.match = { mode, text: t, caseSensitive: !!m.caseSensitive };
    }
    if (type === 'voice.phrase') {
        const raw = Array.isArray(cfg.phrases) ? cfg.phrases : typeof cfg.phrases === 'string' ? cfg.phrases.split(/\r?\n/) : [];
        const byKey = new Map();
        for (const p of raw) {
            const t = text(p, 300).replace(/\s+/g, ' ').trim();
            if (t && !byKey.has(normalisePhrase(t))) byKey.set(normalisePhrase(t), t);
        }
        const list = [...byKey.values()];
        if (!list.length) errors.push('A voice command needs at least one phrase.');
        if (list.length > 20) errors.push('At most 20 phrases for one voice command.');
        if (list.some((p) => p.length > 100)) errors.push('Each phrase can be at most 100 characters.');
        value.phrases = list.slice(0, 20).map((p) => p.slice(0, 100));
    }
    if (type === 'bits.used') value.bitsKind = BITS_KINDS.includes(cfg.bitsKind) ? cfg.bitsKind : 'any';
    if (type === 'variable.changed') {
        const k = String(cfg.key ?? '').trim().toLowerCase();
        if (k && !/^[a-z0-9_.-]{1,64}$/.test(k)) errors.push('Counter changed: the name may use 1 to 64 letters, numbers, _ . or -.');
        if (k) value.key = k;
        value.scope = ['channel', 'viewer'].includes(cfg.scope) ? cfg.scope : 'any';
    }
    return { ok: !errors.length, errors, value };
}

export function validateConditions(list) {
    const errors = [];
    const value = [];
    if (!Array.isArray(list)) return { ok: true, errors, value };
    if (list.length > LIMITS.conditions) errors.push(`At most ${LIMITS.conditions} conditions.`);
    for (const raw of list.slice(0, LIMITS.conditions)) {
        const c = raw || {};
        switch (c.type) {
            case 'role': {
                const roles = (Array.isArray(c.roles) ? c.roles : []).filter((r) => r === 'everyone' || ROLES.includes(r));
                if (!roles.length) errors.push('Viewer role: pick at least one role.');
                value.push({ type: 'role', roles: [...new Set(roles)], mode: c.mode === 'none' ? 'none' : 'any' });
                break;
            }
            case 'amount': {
                const min = c.min === '' || c.min == null ? null : Number(c.min);
                const max = c.max === '' || c.max == null ? null : Number(c.max);
                if ((min != null && !Number.isFinite(min)) || (max != null && !Number.isFinite(max))) errors.push('Amount range: use numbers.');
                else if (min == null && max == null) errors.push('Amount range: set a minimum, a maximum or both.');
                else if (min != null && max != null && min > max) errors.push('Amount range: the minimum is above the maximum.');
                value.push({ type: 'amount', min, max, currency: c.currency ? text(c.currency, 12) : null });
                break;
            }
            case 'text': {
                const mode = MATCH_MODES.includes(c.mode) ? c.mode : 'contains';
                const t = text(c.text, 200).trim();
                if (!t) errors.push('Text match: enter the text to look for.');
                if (mode === 'regex' && t && !safeRegex(t, 'i')) errors.push('Text match: that pattern is not allowed.');
                value.push({ type: 'text', mode, text: t, field: ['message', 'user', 'reward'].includes(c.field) ? c.field : 'message', caseSensitive: !!c.caseSensitive });
                break;
            }
            case 'metadata': {
                const path = String(c.path || '').trim();
                if (!PATH.test(path)) errors.push('Event detail: the field name may use letters, numbers, _ and dots.');
                value.push({ type: 'metadata', path, op: METADATA_OPS.includes(c.op) ? c.op : 'eq', value: text(c.value, 500) });
                break;
            }
            case 'cooldown': {
                const seconds = clampInt(c.seconds, 1, LIMITS.cooldownMax);
                if (seconds == null) errors.push('Cooldown: enter the number of seconds.');
                value.push({ type: 'cooldown', scope: c.scope === 'user' ? 'user' : 'global', seconds: seconds ?? 30 });
                break;
            }
            case 'rate_limit': {
                const count = clampInt(c.count, 1, LIMITS.countMax);
                const windowSeconds = clampInt(c.windowSeconds, 1, LIMITS.windowMax);
                if (count == null || windowSeconds == null) errors.push('Rate limit: enter a count and a window in seconds.');
                value.push({ type: 'rate_limit', scope: c.scope === 'user' ? 'user' : 'global', count: count ?? 1, windowSeconds: windowSeconds ?? 60 });
                break;
            }
            default:
                if (REGISTERED.has(c.type)) { value.push(REGISTERED.get(c.type).validate(c, (m) => errors.push(m))); break; }
                errors.push(`Unknown condition "${String(c.type).slice(0, 30)}".`);
        }
    }
    return { ok: !errors.length, errors, value };
}

export default { CONDITION_TYPES, MATCH_MODES, BITS_KINDS, METADATA_OPS, LIMITS, textMatches, triggerMatches, createLimiter, checkConditions, validateTrigger, validateConditions, registerConditionType, loadConditionData };
