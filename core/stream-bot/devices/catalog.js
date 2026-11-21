/*
 * Stream bot devices (Phase 5): the light and Voicemeeter actions, colours and device ids. Pure.
 *
 *   LIGHT_ACTIONS, VOICEMEETER_ACTIONS   action definitions registered with actions.js registerActionType() (target studio;
 *                                        a cloud light is carried out on the server instead, see service.js)
 *   parseColor(text)       '#rgb' | '#rrggbb' | 'rgb(r, g, b)' | a CSS colour name | '<n>K' → { hex } | { kelvin } | null
 *   isCloudDevice(id)      'govee-cloud:…' | 'lifx-cloud:…'
 *   cloudProviderOf(id)    'govee' | 'lifx' | null
 *   validatePreset(raw)    a light preset from the dashboard → { ok, errors[], value }
 *   DRIVER_LABEL           plain names for each kind of light
 *
 * light.set stays in actions.js (Phase 1 contract); its device field became the light picker.
 * Tested in tests/stream-bot-devices.test.js.
 */

const f = (name, kind, label, extra = {}) => ({ name, kind, label, ...extra });
const num = (v) => (v === '' || v == null ? NaN : Number(v));
const clampInt = (v, lo, hi, d) => { const n = num(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
const txt = (v, max) => String(v ?? '').slice(0, max);
const pick = (v, list, d) => (list.includes(v) ? v : d);
const COLOR = /^#[0-9a-f]{6}$/i;

export const DRIVER_LABEL = Object.freeze({
    govee: 'Govee (on your network)', 'govee-cloud': 'Govee (cloud)', hue: 'Philips Hue', lifx: 'LIFX (on your network)', 'lifx-cloud': 'LIFX (cloud)',
    nanoleaf: 'Nanoleaf', elgato: 'Elgato', litra: 'Logitech Litra', goveeble: 'Govee (Bluetooth)',
});
export const CLOUD_PROVIDERS = Object.freeze(['govee', 'lifx']);
export const PROVIDER_LABEL = Object.freeze({ govee: 'Govee', lifx: 'LIFX' });

/** Device ids: '<driver>:<local id>'. Cloud ones never go to Studio. '' or 'all' means every light. */
export const DEVICE_ID = /^(?:all|(?:govee|hue|lifx|nanoleaf|elgato|litra|goveeble|govee-cloud|lifx-cloud):[A-Za-z0-9._:/-]{1,120})$/;
export const isCloudDevice = (id) => /^(govee|lifx)-cloud:/.test(String(id || ''));
export const cloudProviderOf = (id) => (String(id || '').match(/^(govee|lifx)-cloud:/)?.[1] || null);
export const isAllDevices = (id) => !id || id === 'all';

// The 148 CSS colour names (CSS Color Module Level 4), so "red", "rebeccapurple" or a viewer's {arg1} work.
const CSS = 'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff '
    + 'blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c '
    + 'cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b '
    + 'darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f '
    + 'darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 '
    + 'floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f '
    + 'grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 '
    + 'lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 '
    + 'lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 '
    + 'lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db '
    + 'mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa '
    + 'mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 '
    + 'palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd '
    + 'powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 '
    + 'seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f '
    + 'steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 '
    + 'yellowgreen:9acd32';
export const CSS_COLORS = Object.freeze(Object.fromEntries(CSS.split(' ').map((p) => p.split(':')).map(([n, h]) => [n, `#${h}`])));

/** A colour written by a person or a variable → { hex: '#rrggbb' } | { kelvin } | null. */
export function parseColor(text) {
    const s = String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
    if (!s) return null;
    let m = s.match(/^#?([0-9a-f]{6})$/);
    if (m) return { hex: `#${m[1]}` };
    m = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
    if (m) return { hex: `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` };
    m = s.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/);
    if (m) {
        const parts = m.slice(1, 4).map(Number);
        if (parts.some((v) => v > 255)) return null;
        return { hex: `#${parts.map((v) => v.toString(16).padStart(2, '0')).join('')}` };
    }
    m = s.match(/^(\d{4,5}) ?k$/);
    if (m) {
        const k = Number(m[1]);
        return k >= 1000 && k <= 12000 ? { kelvin: k } : null;
    }
    const name = s.replace(/[ _-]/g, '');
    return CSS_COLORS[name] ? { hex: CSS_COLORS[name] } : null;
}

export const hexToRgb = (hex) => {
    const m = String(hex || '').match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
};

const deviceField = (label = 'Light') => f('device', 'light', label, { optional: true });
const durationField = () => f('durationMs', 'number', 'For (ms, 0 = stay)', { min: 0, max: 600000, default: 0 });

function checkDevice(s, out, err) {
    out.device = txt(s.device, 160).trim();
    if (out.device === 'all') out.device = '';
    if (out.device && !DEVICE_ID.test(out.device)) err('pick a light from the list.');
}
const brightness = (s, out, d = 100) => { out.brightness = clampInt(s.brightness, 0, 100, d); };
const duration = (s, out) => { out.durationMs = clampInt(s.durationMs, 0, 600000, 0); };
const noop = async () => ({ status: 'failed', detail: 'carried out by CertiFried Studio or the light service' });

const L = (type, label, fields, validate, extra = {}) => ({ type, label, target: 'studio', capability: 'light', group: 'Lights', phase: 5, fields, validate, execute: noop, ...extra });

export const LIGHT_ACTIONS = Object.freeze([
    L('light.color', 'Set a light to a colour from text', [deviceField(),
        f('color', 'template', 'Colour: #ff0000, a name such as red, 3200K, or a variable such as {args.color}'),
        f('brightness', 'number', 'Brightness (0-100)', { min: 0, max: 100, default: 100 }), durationField()],
    (s, out, err) => {
        checkDevice(s, out, err);
        out.color = txt(s.color, 300).trim();
        if (!out.color) err('enter the colour or a variable.');
        else if (!out.color.includes('{') && !parseColor(out.color)) err('write the colour as #ff0000, a colour name such as red, or a white such as 3200K.');
        brightness(s, out);
        duration(s, out);
    }, { templates: ['color'] }),
    L('light.white', 'Set a light to white', [deviceField(),
        f('kelvin', 'number', 'White (kelvin, 1000-12000; warm 2700, daylight 5600)', { min: 1000, max: 12000, default: 4000 }),
        f('brightness', 'number', 'Brightness (0-100)', { min: 0, max: 100, default: 100 }), durationField()],
    (s, out, err) => {
        checkDevice(s, out, err);
        const k = num(s.kelvin ?? 4000);
        if (!Number.isFinite(k) || k < 1000 || k > 12000) err('the white is 1000 to 12000 K.');
        out.kelvin = clampInt(k, 1000, 12000, 4000);
        brightness(s, out);
        duration(s, out);
    }),
    L('light.brightness', 'Change a light\'s brightness', [deviceField(), f('brightness', 'number', 'Brightness (0-100)', { min: 0, max: 100, default: 50 }), durationField()],
        (s, out, err) => { checkDevice(s, out, err); brightness(s, out, 50); duration(s, out); }),
    L('light.power', 'Turn a light on or off', [deviceField(), f('state', 'select', 'Make it', { options: ['on', 'off', 'toggle'], default: 'toggle', optionLabels: { on: 'On', off: 'Off', toggle: 'Switch over' } })],
        (s, out, err) => { checkDevice(s, out, err); out.state = pick(s.state, ['on', 'off', 'toggle'], 'toggle'); }),
    L('light.scene', 'Start a light scene or effect', [deviceField('Light or bridge'),
        f('scene', 'text', 'Scene or effect name', { suggest: 'lightScenes' }), durationField()],
    (s, out, err) => {
        checkDevice(s, out, err);
        out.scene = txt(s.scene, 120).trim();
        if (!out.scene) err('enter the scene or effect name.');
        if (!out.device) err('pick the light, panel or bridge the scene belongs to.');
        duration(s, out);
    }, { templates: ['scene'] }),
    L('light.flash', 'Flash a light, then put it back', [deviceField(),
        f('color', 'color', 'Colour', { default: '#b4e04f' }),
        f('brightness', 'number', 'Brightness (0-100)', { min: 0, max: 100, default: 100 }),
        f('times', 'number', 'Times (1-20)', { min: 1, max: 20, default: 3 }),
        f('periodMs', 'number', 'Each flash (ms, 200-5000)', { min: 200, max: 5000, default: 600 }),
        f('mode', 'select', 'Style', { options: ['flash', 'pulse'], default: 'flash', optionLabels: { flash: 'On and off', pulse: 'Bright and dim' } })],
    (s, out, err) => {
        checkDevice(s, out, err);
        out.color = COLOR.test(String(s.color || '')) ? String(s.color).toLowerCase() : '#b4e04f';
        brightness(s, out);
        out.times = clampInt(s.times, 1, 20, 3);
        out.periodMs = clampInt(s.periodMs, 200, 5000, 600);
        out.mode = pick(s.mode, ['flash', 'pulse'], 'flash');
    }),
    L('light.preset', 'Apply a light preset', [f('preset', 'lightPreset', 'Preset')],
        (s, out, err) => {
            out.preset = txt(s.preset, 40).trim();
            if (!/^p_[a-z0-9]{6,16}$/.test(out.preset)) err('pick a preset (make them on the Devices page, Lights).');
        }),
]);

const V = (type, label, fields, validate) => ({ type, label, target: 'studio', capability: 'voicemeeter', group: 'Voicemeeter', phase: 5, fields, validate, execute: noop });
export const VM_TARGET = /^(strip|bus):([0-7])$/;

export const VOICEMEETER_ACTIONS = Object.freeze([
    V('voicemeeter.mute', 'Voicemeeter: mute or unmute', [f('target', 'vmTarget', 'Strip or bus'),
        f('state', 'select', 'Action', { options: ['mute', 'unmute', 'toggle'], default: 'toggle', optionLabels: { mute: 'Mute', unmute: 'Unmute', toggle: 'Switch over' } })],
    (s, out, err) => {
        out.target = txt(s.target, 10).trim();
        if (!VM_TARGET.test(out.target)) err('pick a strip or bus.');
        out.state = pick(s.state, ['mute', 'unmute', 'toggle'], 'toggle');
    }),
    V('voicemeeter.gain', 'Voicemeeter: change the gain', [f('target', 'vmTarget', 'Strip or bus'),
        f('mode', 'select', 'How', { options: ['set', 'adjust'], default: 'set', optionLabels: { set: 'Set to', adjust: 'Raise or lower by' } }),
        f('gain', 'number', 'Gain (dB; set -60 to 12, change by -72 to 72)', { min: -72, max: 72, default: 0 }),
        f('fadeMs', 'number', 'Fade (ms, 0-5000)', { min: 0, max: 5000, default: 0 })],
    (s, out, err) => {
        out.target = txt(s.target, 10).trim();
        if (!VM_TARGET.test(out.target)) err('pick a strip or bus.');
        out.mode = pick(s.mode, ['set', 'adjust'], 'set');
        const g = num(s.gain ?? 0);
        const [lo, hi] = out.mode === 'set' ? [-60, 12] : [-72, 72];
        if (!Number.isFinite(g) || g < lo || g > hi) err(out.mode === 'set' ? 'set the gain from -60 to 12 dB.' : 'change the gain by -72 to 72 dB.');
        out.gain = Number.isFinite(g) ? Math.min(hi, Math.max(lo, Math.round(g * 10) / 10)) : 0;
        out.fadeMs = clampInt(s.fadeMs, 0, 5000, 0);
    }),
    V('voicemeeter.profile', 'Voicemeeter: load settings', [f('profile', 'vmProfile', 'Settings file (in Documents\\Voicemeeter)')],
        (s, out, err) => {
            out.profile = txt(s.profile, 120).trim();
            if (!/^[^\\/:*?"<>|]{1,116}\.xml$/i.test(out.profile) || out.profile.includes('..')) err('pick a settings file (.xml) from the Voicemeeter folder in Documents.');
        }),
    V('voicemeeter.macro', 'Voicemeeter: press a macro button', [f('button', 'number', 'Button number (0-79, as in Macro Buttons)', { min: 0, max: 79, default: 0 }),
        f('state', 'select', 'Action', { options: ['press', 'on', 'off', 'toggle'], default: 'press', optionLabels: { press: 'Press', on: 'Turn on', off: 'Turn off', toggle: 'Switch over' } })],
    (s, out, err) => {
        const b = num(s.button ?? 0);
        if (!Number.isInteger(b) || b < 0 || b > 79) err('the button number is 0 to 79.');
        out.button = clampInt(b, 0, 79, 0);
        out.state = pick(s.state, ['press', 'on', 'off', 'toggle'], 'press');
    }),
]);

export const PRESET_LIMITS = Object.freeze({ presets: 50, lights: 20, name: 60 });

/** A light preset: { id?, name, lights: [{ device, power: on|off, color?, kelvin?, brightness?, scene? }] }. */
export function validatePreset(raw = {}) {
    const errors = [];
    const value = { id: /^p_[a-z0-9]{6,16}$/.test(String(raw.id || '')) ? String(raw.id) : null, name: txt(raw.name, PRESET_LIMITS.name).trim(), lights: [] };
    if (!value.name) errors.push('Give the preset a name.');
    const list = Array.isArray(raw.lights) ? raw.lights : [];
    if (!list.length) errors.push('Add at least one light.');
    if (list.length > PRESET_LIMITS.lights) errors.push(`At most ${PRESET_LIMITS.lights} lights in a preset.`);
    for (const l of list.slice(0, PRESET_LIMITS.lights)) {
        const device = txt(l?.device, 160).trim();
        if (!device || device === 'all' || !DEVICE_ID.test(device)) { errors.push('Pick a light for every row.'); continue; }
        const e = { device, power: l?.power === 'off' ? 'off' : 'on' };
        if (e.power === 'on') {
            if (l?.scene) e.scene = txt(l.scene, 120).trim();
            else if (l?.kelvin != null && l.kelvin !== '') e.kelvin = clampInt(l.kelvin, 1000, 12000, 4000);
            else if (COLOR.test(String(l?.color || ''))) e.color = String(l.color).toLowerCase();
            e.brightness = clampInt(l?.brightness, 0, 100, 100);
        }
        value.lights.push(e);
    }
    return { ok: !errors.length, errors: [...new Set(errors)], value };
}

export default { LIGHT_ACTIONS, VOICEMEETER_ACTIONS, parseColor, hexToRgb, isCloudDevice, cloudProviderOf, isAllDevices, validatePreset, DRIVER_LABEL, PROVIDER_LABEL, CSS_COLORS, DEVICE_ID, VM_TARGET, PRESET_LIMITS };
