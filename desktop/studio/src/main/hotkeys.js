'use strict';
/*
 * Global hotkeys (listening) and key presses (sending).
 *
 * Listening uses Electron's globalShortcut: a binding fires when its whole combination is pressed, which is all a
 * "press this to run that" hotkey needs. No key-up events or raw hooks are used.
 *
 *   normaliseAccelerator(input)  'ctrl + shift + f1' → 'Ctrl+Shift+F1', or null when it is not a usable combination.
 *                                A plain key needs a modifier, except F13-F24, numpad keys and media keys (keys
 *                                that do nothing else system-wide).
 *   validateBinding(b)           → { ok, value, error }  b = { id, accelerator, label, action }
 *                                action = { kind: 'automation', automationId, automationName }
 *                                       | { kind: 'action', type, params }  (sound.play, sound.stop, obs.*)
 *   createHotkeys({ globalShortcut, onTrigger, logger })
 *     apply(bindings) → { registered: [id], failed: [{ id, reason }] }   reason: invalid | duplicate | in_use
 *     clear()
 *
 * Sending (the studio.hotkey action, "Press a hotkey") uses uiohook-napi's keyTap, because Electron cannot
 * synthesise key presses that other programs receive.
 *
 *   parseKeys('Ctrl+Shift+F1', UiohookKey) → { key, modifiers[] }   throws bad_params
 *   createKeySender({ load })   send(keys) → { keys }   throws hotkey_unavailable when the native module is missing
 */
const MODS = new Map([
    ['ctrl', 'Ctrl'], ['control', 'Ctrl'], ['cmdorctrl', 'Ctrl'], ['commandorcontrol', 'Ctrl'],
    ['alt', 'Alt'], ['option', 'Alt'], ['shift', 'Shift'], ['super', 'Super'], ['win', 'Super'], ['meta', 'Super'], ['cmd', 'Super'],
]);
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'];
const NAMED = new Map([
    ['space', 'Space'], ['tab', 'Tab'], ['enter', 'Enter'], ['return', 'Enter'], ['backspace', 'Backspace'], ['delete', 'Delete'], ['del', 'Delete'],
    ['insert', 'Insert'], ['ins', 'Insert'], ['home', 'Home'], ['end', 'End'], ['pageup', 'PageUp'], ['pagedown', 'PageDown'],
    ['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right'], ['escape', 'Escape'], ['esc', 'Escape'],
    ['plus', 'Plus'], ['minus', '-'], ['-', '-'], ['=', '='], [',', ','], ['.', '.'], ['/', '/'], [';', ';'], ["'", "'"], ['[', '['], [']', ']'], ['\\', '\\'], ['`', '`'],
    ['volumeup', 'VolumeUp'], ['volumedown', 'VolumeDown'], ['volumemute', 'VolumeMute'],
    ['medianexttrack', 'MediaNextTrack'], ['mediaprevioustrack', 'MediaPreviousTrack'], ['mediastop', 'MediaStop'], ['mediaplaypause', 'MediaPlayPause'],
    ['numadd', 'numadd'], ['numsub', 'numsub'], ['nummult', 'nummult'], ['numdiv', 'numdiv'], ['numdec', 'numdec'],
]);
const FREE_KEYS = /^(F1[3-9]|F2[0-4]|num\w+|Volume\w+|Media\w+)$/;

function keyName(tok) {
    const t = tok.trim();
    const lower = t.toLowerCase();
    if (/^[a-z0-9]$/i.test(t)) return t.toUpperCase();
    if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(t)) return t.toUpperCase();
    if (/^num(pad)?[0-9]$/i.test(t)) return `num${t.slice(-1)}`;
    return NAMED.get(lower) || null;
}

function normaliseAccelerator(input) {
    const raw = String(input ?? '').trim();
    if (!raw || raw.length > 60) return null;
    // '+' as a key is written "Plus"; split on + with optional spaces
    const parts = raw.split(/\s*\+\s*/).filter(Boolean);
    if (!parts.length || parts.length > 5) return null;
    const mods = new Set();
    let key = null;
    for (const p of parts) {
        const m = MODS.get(p.toLowerCase());
        if (m) { mods.add(m); continue; }
        if (key) return null;            // two non-modifier keys
        key = keyName(p);
        if (!key) return null;
    }
    if (!key) return null;
    if (!mods.size && !FREE_KEYS.test(key)) return null;
    return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

const ACTION_KINDS = new Set(['sound.play', 'sound.stop', 'obs.scene', 'obs.source', 'obs.mute', 'obs.record', 'obs.stream', 'obs.replay', 'obs.virtualcam', 'obs.screenshot', 'obs.transition', 'obs.filter', 'obs.hotkey']);

function validateBinding(b) {
    if (!b || typeof b !== 'object') return { ok: false, error: 'invalid' };
    const accelerator = normaliseAccelerator(b.accelerator);
    if (!accelerator) return { ok: false, error: 'Use a combination like Ctrl+Shift+F1 (a key on its own only for F13-F24 and numpad keys).' };
    const id = /^[a-z0-9_-]{1,40}$/i.test(String(b.id || '')) ? String(b.id) : `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const label = String(b.label || '').trim().slice(0, 80);
    const a = b.action || {};
    let action;
    if (a.kind === 'automation') {
        const automationId = Number(a.automationId);
        if (!Number.isInteger(automationId) || automationId <= 0) return { ok: false, error: 'Pick an automation.' };
        action = { kind: 'automation', automationId, automationName: String(a.automationName || '').slice(0, 100) };
    } else if (a.kind === 'action') {
        if (!ACTION_KINDS.has(a.type)) return { ok: false, error: 'Pick what the hotkey does.' };
        const params = {};
        for (const [k, v] of Object.entries(a.params && typeof a.params === 'object' ? a.params : {})) {
            if (/^[a-zA-Z]{1,20}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)) params[k] = typeof v === 'string' ? v.slice(0, 300) : v;
        }
        action = { kind: 'action', type: a.type, params };
    } else {
        return { ok: false, error: 'Pick what the hotkey does.' };
    }
    return { ok: true, value: { id, accelerator, label, action, enabled: b.enabled !== false } };
}

function createHotkeys({ globalShortcut, onTrigger, logger = null }) {
    let active = [];
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[hotkeys] ${m}`, meta); } catch { /* ignore */ } };

    function clear() {
        for (const acc of active) { try { globalShortcut.unregister(acc); } catch { /* ignore */ } }
        active = [];
    }

    function apply(bindings) {
        clear();
        const registered = [];
        const failed = [];
        const seen = new Set();
        for (const raw of bindings || []) {
            const v = validateBinding(raw);
            if (!v.ok) { failed.push({ id: raw?.id, reason: 'invalid' }); continue; }
            const b = v.value;
            if (!b.enabled) continue;
            if (seen.has(b.accelerator)) { failed.push({ id: b.id, reason: 'duplicate' }); continue; }
            seen.add(b.accelerator);
            let ok = false;
            try {
                ok = globalShortcut.register(b.accelerator, () => {
                    Promise.resolve().then(() => onTrigger(b)).catch((e) => log('warn', 'hotkey action failed', { accelerator: b.accelerator, error: e?.message }));
                });
            } catch { ok = false; }
            if (ok) { active.push(b.accelerator); registered.push(b.id); }
            else failed.push({ id: b.id, reason: 'in_use' });   // another program already owns this combination
        }
        if (failed.length) log('warn', 'some hotkeys could not be registered', { failed });
        return { registered, failed };
    }

    return { apply, clear, get active() { return [...active]; } };
}

// ── sending key presses ─────────────────────────────────────────────────────────────────────

const SEND_NAMES = new Map([
    ['space', 'Space'], ['tab', 'Tab'], ['enter', 'Enter'], ['return', 'Enter'], ['backspace', 'Backspace'], ['delete', 'Delete'], ['del', 'Delete'],
    ['insert', 'Insert'], ['home', 'Home'], ['end', 'End'], ['pageup', 'PageUp'], ['pagedown', 'PageDown'], ['escape', 'Escape'], ['esc', 'Escape'],
    ['up', 'ArrowUp'], ['down', 'ArrowDown'], ['left', 'ArrowLeft'], ['right', 'ArrowRight'], ['capslock', 'CapsLock'],
    ['-', 'Minus'], ['minus', 'Minus'], ['=', 'Equal'], [',', 'Comma'], ['.', 'Period'], ['/', 'Slash'], [';', 'Semicolon'], ["'", 'Quote'],
    ['[', 'BracketLeft'], [']', 'BracketRight'], ['\\', 'Backslash'], ['`', 'Backquote'],
]);
const SEND_MODS = new Map([['ctrl', 'Ctrl'], ['control', 'Ctrl'], ['alt', 'Alt'], ['shift', 'Shift'], ['win', 'Meta'], ['super', 'Meta'], ['meta', 'Meta']]);

function parseKeys(keys, UiohookKey) {
    const parts = String(keys ?? '').split(/\s*\+\s*/).map((p) => p.trim()).filter(Boolean);
    if (!parts.length || parts.length > 5) throw Object.assign(new Error('write the keys like Ctrl+Shift+F1'), { code: 'bad_params' });
    const modifiers = [];
    let key = null;
    for (const p of parts) {
        const lower = p.toLowerCase();
        const mod = SEND_MODS.get(lower);
        if (mod) { modifiers.push(UiohookKey[mod]); continue; }
        if (key != null) throw Object.assign(new Error('only one key besides Ctrl, Alt, Shift and Win'), { code: 'bad_params' });
        let name = null;
        if (/^[a-z0-9]$/i.test(p)) name = p.toUpperCase();
        else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(p)) name = p.toUpperCase();
        else if (/^num(pad)?[0-9]$/i.test(p)) name = `Numpad${p.slice(-1)}`;
        else name = SEND_NAMES.get(lower) || null;
        if (!name || UiohookKey[name] == null) throw Object.assign(new Error(`unknown key ${p.slice(0, 20)}`), { code: 'bad_params' });
        key = UiohookKey[name];
    }
    if (key == null) throw Object.assign(new Error('add a key besides Ctrl, Alt, Shift and Win'), { code: 'bad_params' });
    return { key, modifiers };
}

function createKeySender({ load = () => require('uiohook-napi'), logger = null } = {}) {
    let mod;
    function native() {
        if (mod === undefined) {
            try { mod = load(); } catch (e) { mod = null; logger?.warn?.('[keys] key sending is not available', { error: e.message }); }
        }
        return mod;
    }
    return {
        send(keys) {
            const m = native();
            if (!m?.uIOhook?.keyTap) throw Object.assign(new Error('key presses are not available on this PC'), { code: 'hotkey_unavailable' });
            const { key, modifiers } = parseKeys(keys, m.UiohookKey);
            m.uIOhook.keyTap(key, modifiers);
            return { keys: String(keys) };
        },
        get available() { return !!native()?.uIOhook?.keyTap; },
    };
}

module.exports = { normaliseAccelerator, validateBinding, createHotkeys, parseKeys, createKeySender, ACTION_KINDS };
