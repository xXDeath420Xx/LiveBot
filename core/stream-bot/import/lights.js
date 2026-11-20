/*
 * Stream bot import: light steps (Phase 5, core/stream-bot/devices). Pure.
 *
 *   firebotHue(e)          Firebot "hue:control-light" (Philips Hue integration): on/off/toggle, brightness, colour, alert
 *   firebotHueScene(e)     Firebot "hue:scenes": Hue's own scene id only, so it is reported, not mapped
 *   firebotElgato(e, kind) Firebot "elgato:key-lights" / "elgato:light-strips": per light: on/off/toggle, brightness,
 *                          temperature (Key Light), colour (Light Strip)
 *   sbLumia(name, s)       Streamer.bot Lumia Stream sub-actions (6001-6004)
 *   → { actions[], gaps: [{ gap, what }], notes[] }
 *
 * Firebot and Streamer.bot name lights their own way (Hue's light number, Elgato's light name, Lumia's light list), and those
 * do not match the ids CertiFried Studio gives lights, so every imported step targets "All lights" and a note names the light
 * the source used, to pick it in the step. Imported automations are switched off, so nothing changes before that.
 * Voicemeeter: neither Firebot nor Streamer.bot has a built-in Voicemeeter effect or sub-action (Streamer.bot's sub-action enum,
 * streamerbot-types.js, has none), so there is nothing to map; their C# or script steps that call Voicemeeter stay code (never imported).
 * Tested in tests/stream-bot-import.test.js.
 */
import { parseColor } from '../devices/catalog.js';

const str = (v, max = 200) => (v == null ? '' : String(v)).slice(0, max);
const num = (v, d = null) => { const n = Number(String(v ?? '').replace('%', '').trim()); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : d; };
const pct = (v) => { const n = num(v); return n == null ? null : Math.min(100, Math.max(0, Math.round(n))); };
const Q = 120;

function colorOf(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'object' && v) {
        const r = num(v.r), g = num(v.g), b = num(v.b);
        if ([r, g, b].every((x) => x != null && x >= 0 && x <= 255)) return `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
        return null;
    }
    const s = str(v, 60).trim();
    const argb = s.match(/^#([0-9a-f]{2})([0-9a-f]{6})$/i);   // Streamer.bot / .NET colours are often #AARRGGBB
    if (argb) return `#${argb[2].toLowerCase()}`;
    const p = parseColor(s);
    return p?.hex || null;
}

export function firebotHue(e = {}) {
    const out = { actions: [], gaps: [], notes: [] };
    const which = str(e.lightId ?? e.lightName, 60);
    const power = ['on', 'off', 'toggle'].includes(e.activationAction) && e.updateActivated !== false ? e.activationAction : null;
    const brightness = e.updateBrightness ? pct(e.brightnessPercentage) : null;
    const color = e.updateColor ? colorOf(e.color) : null;
    if (e.updateColor && !color) out.notes.push(`The Hue colour "${str(e.color, 40)}" is not a plain colour, so it was left out`);
    if (power === 'off') out.actions.push({ type: 'light.power', device: '', state: 'off', queueSeconds: Q });
    else {
        if (power === 'toggle') out.actions.push({ type: 'light.power', device: '', state: 'toggle', queueSeconds: Q });
        if (color) out.actions.push({ type: 'light.set', device: '', color, brightness: brightness ?? 100, durationMs: 0, queueSeconds: Q });
        else if (brightness != null) out.actions.push({ type: 'light.brightness', device: '', brightness, durationMs: 0, queueSeconds: Q });
        else if (power === 'on') out.actions.push({ type: 'light.power', device: '', state: 'on', queueSeconds: Q });
    }
    if (e.triggerAlert && ['short', 'long'].includes(e.alertType)) {
        // Hue's "select" alert is one breath; "lselect" breathes for about 15 seconds.
        out.actions.push({ type: 'light.flash', device: '', color: color || '#ffffff', brightness: brightness ?? 100, times: e.alertType === 'long' ? 15 : 1, periodMs: 1000, mode: 'pulse', queueSeconds: Q });
    }
    if (e.triggerEffectAnimation && e.effectAnimationType === 'colorloop') out.gaps.push({ gap: 'light.effect', what: 'Hue colour loop' });
    if (e.transitionType && e.transitionType !== 'default') out.notes.push('The Hue transition speed was not kept');
    if (out.actions.length) out.notes.push(`Pick the light in each light step (Firebot used Hue light ${which || '(not named)'}; imported as All lights)`);
    return out;
}

export function firebotHueScene(e = {}) {
    return { actions: [], gaps: [{ gap: 'light.hue_scene', what: `Hue scene ${str(e.sceneName || e.sceneId, 60)}`.trim() }], notes: [] };
}

export function firebotElgato(e = {}, kind = 'key') {
    const out = { actions: [], gaps: [], notes: [] };
    const lights = Object.values(e.selectedLights && typeof e.selectedLights === 'object' ? e.selectedLights : {}).slice(0, 10);
    for (const l of lights) {
        const o = l?.options && typeof l.options === 'object' ? l.options : {};
        const name = str(l?.light?.name || l?.name || '', 60) || 'an Elgato light';
        const before = out.actions.length;
        const toggle = o.toggleType;
        if (toggle === 'disable') { out.actions.push({ type: 'light.power', device: '', state: 'off', queueSeconds: Q }); }
        else {
            if (toggle === 'toggle') out.actions.push({ type: 'light.power', device: '', state: 'toggle', queueSeconds: Q });
            const brightness = pct(o.brightness);
            const kelvin = num(o.temperature);
            const color = kind === 'strip' ? colorOf(o.color) : null;
            if (kind === 'key' && kelvin != null && kelvin >= 1000 && kelvin <= 12000) out.actions.push({ type: 'light.white', device: '', kelvin: Math.round(kelvin), brightness: brightness ?? 100, durationMs: 0, queueSeconds: Q });
            else if (color) out.actions.push({ type: 'light.set', device: '', color, brightness: brightness ?? 100, durationMs: 0, queueSeconds: Q });
            else if (brightness != null) out.actions.push({ type: 'light.brightness', device: '', brightness, durationMs: 0, queueSeconds: Q });
            else if (toggle === 'enable') out.actions.push({ type: 'light.power', device: '', state: 'on', queueSeconds: Q });
            if (o.temperature && (kelvin == null || kelvin < 1000)) out.notes.push(`The temperature "${str(o.temperature, 40)}" of ${name} is not a number of kelvin, so it was left out`);
            if (kind === 'strip' && o.color && !color) out.notes.push(`The colour "${str(o.color, 40)}" of ${name} is not a plain colour, so it was left out`);
        }
        if (out.actions.length > before) out.notes.push(`Pick ${name} in its light steps (imported as All lights)`);
    }
    return out;
}

/** Streamer.bot Lumia Stream sub-actions. Field names are read loosely (Streamer.bot does not document its JSON). */
export function sbLumia(name, s = {}) {
    const out = { actions: [], gaps: [], notes: [] };
    const color = colorOf(s.color ?? s.colour ?? s.hexColor ?? s.colorHex ?? s.value);
    const brightness = pct(s.brightness ?? s.value);
    const dur = num(s.duration ?? s.durationMs);
    const durationMs = dur == null ? 0 : Math.min(600000, Math.max(0, Math.round(dur < 1000 && dur > 0 && !('durationMs' in s) ? dur * 1000 : dur)));
    const lights = Array.isArray(s.lights) ? s.lights.length : 0;
    switch (name) {
        case 'LumiaStreamSetColor':
            if (!color) { out.gaps.push({ gap: 'lumia.command', what: 'Lumia colour that is not a plain colour' }); break; }
            out.actions.push({ type: 'light.set', device: '', color, brightness: brightness ?? 100, durationMs, queueSeconds: Q });
            break;
        case 'LumiaStreamSetBrightness':
            if (brightness == null) { out.gaps.push({ gap: 'lumia.command', what: 'Lumia brightness with no value' }); break; }
            out.actions.push({ type: 'light.brightness', device: '', brightness, durationMs, queueSeconds: Q });
            break;
        case 'LumiaStreamSetToDefault':
            out.gaps.push({ gap: 'lumia.default', what: 'Lumia "set to default"' });
            break;
        default:
            out.gaps.push({ gap: 'lumia.command', what: `Lumia command ${str(s.command || s.name || s.value, 60)}`.trim() });
    }
    if (out.actions.length) out.notes.push(`Pick the light in the light step (Lumia used ${lights ? `${lights} of its lights` : 'its own light list'}; imported as All lights)`);
    return out;
}

export default { firebotHue, firebotHueScene, firebotElgato, sbLumia };
