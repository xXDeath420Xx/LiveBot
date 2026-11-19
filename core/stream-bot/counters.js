/*
 * Stream bot: "Counter changed" events. Every write to a stream bot value ({sdb:…}/{db:…} in a template, or the
 * Set a variable / Add to a counter actions) goes through the observed variable store, which emits a
 * `variable.changed` event with the new and the old value.
 *
 *   runContext                               AsyncLocalStorage the engine runs each automation's steps in:
 *                                            { profileId, eventDepth } (eventDepth = the triggering event's depth)
 *   observeVariables(inner, { onChange, maxDepth?, logger? })  → a variable store with the same interface
 *   variableChangedEvent({ key, owner, value, oldValue, depth }) → the normalised event
 *
 * Loop guard: an event caused by a run that was itself started by a counter change carries depth + 1; at more
 * than COUNTER_MAX_DEPTH (3) no event is emitted (the value is still written). An automation that changes the
 * counter it listens to therefore runs at most three times in a row, and the engine's per-minute limits still apply.
 *
 * Tested in tests/stream-bot-gaps.test.js.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const runContext = new AsyncLocalStorage();
export const COUNTER_MAX_DEPTH = 3;

const NUMERIC = /^[+-]?\d{1,15}(\.\d+)?$/;

export function variableChangedEvent({ key, owner, value, oldValue, depth = 1 }) {
    const v = value == null ? '' : String(value).slice(0, 1000);
    const o = oldValue == null ? '' : String(oldValue).slice(0, 1000);
    const viewer = owner && owner !== 'server' ? String(owner).slice(0, 80) : null;
    const num = NUMERIC.test(v) ? Number(v) : null;
    const change = num != null && NUMERIC.test(o || '0') ? num - Number(o || 0) : null;
    const [platform, id] = viewer ? viewer.split(':') : [null, null];
    return {
        platform: 'bot', type: 'variable.changed', channelId: null,
        user: viewer && id ? { id: String(id).slice(0, 64), login: null, name: null, roles: [] } : null,
        amount: num, currency: null, message: null,
        metadata: { key: String(key).slice(0, 64), scope: viewer ? 'viewer' : 'channel', value: v, oldValue: o, change, depth, ...(viewer ? { viewer, viewerPlatform: platform } : {}) },
        raw: null, occurredAt: new Date(), dedupeKey: null,
    };
}

export function observeVariables(inner, { onChange, maxDepth = COUNTER_MAX_DEPTH, logger = null } = {}) {
    const emit = (profileId, owner, key, value, oldValue) => {
        const depth = (Number(runContext.getStore()?.eventDepth) || 0) + 1;
        if (depth > maxDepth) {
            try { logger?.debug?.(`[StreamBot] counter ${key} changed at depth ${depth}; no event (loop guard)`); } catch { /* ignore */ }
            return;
        }
        Promise.resolve()
            .then(() => onChange?.({ profileId: Number(profileId), owner, key, value, oldValue, depth }))
            .catch(() => { /* never breaks the write */ });
    };
    return {
        async get(profileId, owner, key) { return inner.get(profileId, owner, key); },
        async set(profileId, owner, key, value, maxKeys) {
            const old = await inner.get(profileId, owner, key);
            const r = await inner.set(profileId, owner, key, value, maxKeys);
            if (!r?.full && String(old ?? '') !== String(value ?? '')) emit(profileId, owner, key, String(value ?? ''), old);
            return r;
        },
        async incr(profileId, owner, key, by = 1, maxKeys) {
            const r = await inner.incr(profileId, owner, key, by, maxKeys);
            if (r && !r.full && r.value != null && Number(by) !== 0) emit(profileId, owner, key, String(r.value), String(r.value - Number(by)));
            return r;
        },
        async del(profileId, owner, key) {
            const old = await inner.get(profileId, owner, key);
            const r = await inner.del(profileId, owner, key);
            if (r?.deleted) emit(profileId, owner, key, '', old);
            return r;
        },
    };
}

export default { runContext, observeVariables, variableChangedEvent, COUNTER_MAX_DEPTH };
