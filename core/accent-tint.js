/*
 * Server accent tint: the "Use each server's colour" appearance option (Settings > Appearance,
 * user_preferences.ui_options.serverAccent). When it is on, a server's manage pages take their
 * accent from that server's embed colour (core/guild-theme.js, primary slot: the Embed theme page)
 * instead of the colour theme's own accent.
 *
 * Only the accent tokens change (--cf-accent, -hover, -fg, -soft, -line, --cf-on-accent and the
 * legacy --accent-purple / --bs-link-color-rgb that older rules read). Surfaces, text and status
 * colours stay the theme's. An embed colour can be anything (pure yellow, near black), so the
 * colour is fitted per mode before use:
 *
 *   accent       button fills, focus rings: at least 3:1 against the page (WCAG non-text contrast)
 *   accent-fg    accent used as text or an icon: at least 4.5:1 against the raised surfaces
 *   on-accent    text on an accent fill: near-black or white, whichever reads better
 *
 * Fitting keeps the hue and saturation and walks lightness away from the background, so a dark
 * navy brand colour becomes a lighter navy on dark themes and stays itself on light ones.
 *
 * Pure (no DB, no Discord); tested in tests/nav-polish.test.js. The manage templates render
 * serverAccentCss() into a <style> only for users who turned the option on. A Custom colour theme
 * keeps its own accent (the user picked it on purpose).
 */

const HEX = /^#?([0-9a-f]{6})$/i;

/** [r, g, b] 0-255 from '#rrggbb' (or 'rrggbb'), or null. */
export function parseHex(hex) {
    const m = String(hex ?? '').trim().match(HEX);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]) {
    return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

/** WCAG relative luminance. */
export function luminance([r, g, b]) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio between two [r, g, b] colours (1 to 21). */
export function contrast(a, b) {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
}

function hslToRgb([h, s, l]) {
    if (s === 0) return [l * 255, l * 255, l * 255];
    const hue = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/**
 * The colour with its lightness moved (towards white on a dark background, towards black on a
 * light one) just far enough to reach `min` contrast against every colour in `against`.
 * Returns [r, g, b], rounded.
 */
export function fitLightness(rgb, against, min) {
    const ok = (c) => against.every((bg) => contrast(c, bg) >= min);
    const round = (c) => c.map((v) => Math.round(Math.max(0, Math.min(255, v))));
    if (ok(round(rgb))) return round(rgb);
    const darkBg = luminance(against[0]) < 0.2;
    const [h, s, l] = rgbToHsl(rgb);
    for (let step = 1; step <= 100; step++) {
        const nl = darkBg ? Math.min(1, l + step * 0.01) : Math.max(0, l - step * 0.01);
        const c = round(hslToRgb([h, s, nl]));
        if (ok(c)) return c;
    }
    return darkBg ? [255, 255, 255] : [0, 0, 0];
}

/*
 * Reference surfaces per mode: the page background and the most raised surfaces the accent sits on
 * across the built-in themes of that mode (cf-ui.css). Fitting against all of them keeps the
 * accent readable on cards, inputs and the page alike.
 */
export const MODE_SURFACES = Object.freeze({
    dark: Object.freeze(['#0e0f11', '#23262b', '#1d2e28', '#2c1f3c']),
    light: Object.freeze(['#ffffff', '#e9ebee', '#e9e1d3']),
});

const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a})`;

/**
 * Accent tokens for one mode, or null for an unusable colour.
 * @param {string} hex   the server's embed colour
 * @param {'dark'|'light'} mode
 */
export function accentTokens(hex, mode) {
    const base = parseHex(hex);
    if (!base) return null;
    const surfaces = (MODE_SURFACES[mode] || MODE_SURFACES.dark).map(parseHex);
    const accent = fitLightness(base, surfaces, 3);
    const fg = fitLightness(base, surfaces, 4.5);
    const onAccent = contrast(accent, [15, 17, 20]) >= contrast(accent, [255, 255, 255]) ? [15, 17, 20] : [255, 255, 255];
    // Hover: a step further from the page (lighter on dark, darker on light).
    const [h, s, l] = rgbToHsl(accent);
    const hover = hslToRgb([h, s, mode === 'light' ? Math.max(0, l - 0.07) : Math.min(1, l + 0.07)]).map(Math.round);
    return {
        '--cf-accent': toHex(accent),
        '--cf-accent-hover': toHex(hover),
        '--cf-accent-fg': toHex(fg),
        '--cf-on-accent': toHex(onAccent),
        '--cf-accent-soft': rgba(accent, mode === 'light' ? 0.1 : 0.14),
        '--cf-accent-line': rgba(accent, 0.45),
        '--accent-purple': toHex(fg),
        '--bs-link-color-rgb': fg.join(', '),
    };
}

/**
 * The <style> body for the manage templates: dark-mode tokens for every dark theme, light-mode
 * tokens for Light and Sand (and Auto, which becomes one of them at runtime). Custom keeps its
 * own accent. '' for an unusable colour. !important because the named themes and the Classic
 * style set the accent at higher specificity, and this is an explicit per-user choice to override.
 */
export function serverAccentCss(hex) {
    const dark = accentTokens(hex, 'dark');
    const light = accentTokens(hex, 'light');
    if (!dark || !light) return '';
    const body = (t) => Object.entries(t).map(([k, v]) => `${k}: ${v} !important;`).join(' ');
    return [
        `:root:not([data-theme="light"]):not([data-theme="sand"]):not([data-theme="custom"]) { ${body(dark)} }`,
        `:root[data-theme="light"], :root[data-theme="sand"] { ${body(light)} }`,
    ].join('\n');
}

export default { parseHex, toHex, luminance, contrast, fitLightness, accentTokens, serverAccentCss, MODE_SURFACES };
