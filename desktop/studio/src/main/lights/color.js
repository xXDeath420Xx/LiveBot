'use strict';
/*
 * Colour helpers for the light drivers.
 *
 *   parseColor(text)          '#rgb' | '#rrggbb' | 'rgb(r,g,b)' | a CSS colour name (the 148 CSS names) | '<n>K' (1000-12000)
 *                             → { rgb: { r, g, b }, hex } or { kelvin } or null when it cannot be read
 *   parseHex(text)            '#rgb' / '#rrggbb' only → { r, g, b } | null
 *   rgbToHex({ r, g, b })     '#rrggbb'
 *   rgbToHsv / hsvToRgb       h 0-360, s 0-100, v 0-100
 *   kelvinToRgb(k)            the colour of a white at k (Tanner Helland's approximation)
 *   rgbToKelvin(rgb)          the nearest white (1000-12000, steps of 100) for white-only lights
 *   rgbToXy(rgb, gamut?)      CIE 1931 xy for Philips Hue (sRGB → XYZ, then clamped into the light's gamut triangle,
 *                             Gamut C when the light does not say)
 *   xyToRgb(x, y)             back to sRGB at full brightness (for reading a Hue light's state)
 *   kelvinToMirek / mirekToKelvin
 *   CSS_COLORS                the name → hex table
 */
const { clamp } = require('./util');

const CSS_COLORS = Object.freeze({
    aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff', beige: 'f5f5dc',
    bisque: 'ffe4c4', black: '000000', blanchedalmond: 'ffebcd', blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a',
    burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00', chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed',
    cornsilk: 'fff8dc', crimson: 'dc143c', cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b',
    darkgray: 'a9a9a9', darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b', darkmagenta: '8b008b', darkolivegreen: '556b2f',
    darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f', darkslateblue: '483d8b',
    darkslategray: '2f4f4f', darkslategrey: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3', deeppink: 'ff1493', deepskyblue: '00bfff',
    dimgray: '696969', dimgrey: '696969', dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22',
    fuchsia: 'ff00ff', gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', gray: '808080',
    green: '008000', greenyellow: 'adff2f', grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c',
    indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5', lawngreen: '7cfc00',
    lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3',
    lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a', lightseagreen: '20b2aa', lightskyblue: '87cefa',
    lightslategray: '778899', lightslategrey: '778899', lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32',
    linen: 'faf0e6', magenta: 'ff00ff', maroon: '800000', mediumaquamarine: '66cdaa', mediumblue: '0000cd', mediumorchid: 'ba55d3',
    mediumpurple: '9370db', mediumseagreen: '3cb371', mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc', mediumvioletred: 'c71585',
    midnightblue: '191970', mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5', navajowhite: 'ffdead', navy: '000080',
    oldlace: 'fdf5e6', olive: '808000', olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500', orchid: 'da70d6',
    palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee', palevioletred: 'db7093', papayawhip: 'ffefd5', peachpuff: 'ffdab9',
    peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd', powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399',
    red: 'ff0000', rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460',
    seagreen: '2e8b57', seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd',
    slategray: '708090', slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f', steelblue: '4682b4', tan: 'd2b48c',
    teal: '008080', thistle: 'd8bfd8', tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3',
    white: 'ffffff', whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32',
});

const KELVIN_MIN = 1000;
const KELVIN_MAX = 12000;
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RGB_FN = /^rgb\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*\)$/i;
const KELVIN_RE = /^(\d{3,5})\s*k$/i;

function byte(n) { return Math.round(clamp(n, 0, 255)); }

function rgbToHex({ r, g, b }) {
    return `#${[r, g, b].map((v) => byte(v).toString(16).padStart(2, '0')).join('')}`;
}

function parseHex(text) {
    if (typeof text !== 'string') return null;
    const s = text.trim();
    let m = s.match(HEX6);
    if (m) return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
    m = s.match(HEX3);
    if (m) return { r: parseInt(m[1] + m[1], 16), g: parseInt(m[2] + m[2], 16), b: parseInt(m[3] + m[3], 16) };
    return null;
}

function parseColor(text) {
    if (typeof text !== 'string') return null;
    const s = text.trim();
    if (!s || s.length > 40) return null;
    const hex = parseHex(s);
    if (hex) return { rgb: hex, hex: rgbToHex(hex) };
    let m = s.match(RGB_FN);
    if (m) {
        const v = [m[1], m[2], m[3]].map(Number);
        if (v.some((n) => n > 255)) return null;
        const rgb = { r: v[0], g: v[1], b: v[2] };
        return { rgb, hex: rgbToHex(rgb) };
    }
    m = s.match(KELVIN_RE);
    if (m) {
        const k = Number(m[1]);
        return k >= KELVIN_MIN && k <= KELVIN_MAX ? { kelvin: k } : null;
    }
    const name = s.toLowerCase().replace(/[\s_-]+/g, '');
    if (Object.prototype.hasOwnProperty.call(CSS_COLORS, name)) {
        const rgb = parseHex(`#${CSS_COLORS[name]}`);
        return { rgb, hex: rgbToHex(rgb) };
    }
    return null;
}

function rgbToHsv({ r, g, b }) {
    const R = byte(r) / 255; const G = byte(g) / 255; const B = byte(b) / 255;
    const max = Math.max(R, G, B); const min = Math.min(R, G, B); const d = max - min;
    let h = 0;
    if (d) {
        if (max === R) h = ((G - B) / d) % 6;
        else if (max === G) h = (B - R) / d + 2;
        else h = (R - G) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h: Math.round(h) % 360, s: Math.round(max ? (d / max) * 100 : 0), v: Math.round(max * 100) };
}

function hsvToRgb(h, s, v) {
    const H = ((Number(h) % 360) + 360) % 360; const S = clamp(s, 0, 100) / 100; const V = clamp(v, 0, 100) / 100;
    const c = V * S; const x = c * (1 - Math.abs(((H / 60) % 2) - 1)); const m = V - c;
    let rgb;
    if (H < 60) rgb = [c, x, 0]; else if (H < 120) rgb = [x, c, 0]; else if (H < 180) rgb = [0, c, x];
    else if (H < 240) rgb = [0, x, c]; else if (H < 300) rgb = [x, 0, c]; else rgb = [c, 0, x];
    return { r: byte((rgb[0] + m) * 255), g: byte((rgb[1] + m) * 255), b: byte((rgb[2] + m) * 255) };
}

function kelvinToRgb(kelvin) {
    const t = clamp(kelvin, KELVIN_MIN, 40000) / 100;
    let r; let g; let b;
    if (t <= 66) {
        r = 255;
        g = 99.4708025861 * Math.log(t) - 161.1195681661;
    } else {
        r = 329.698727446 * (t - 60) ** -0.1332047592;
        g = 288.1221695283 * (t - 60) ** -0.0755148492;
    }
    if (t >= 66) b = 255;
    else if (t <= 19) b = 0;
    else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    return { r: byte(r), g: byte(g), b: byte(b) };
}

const WHITES = [];
for (let k = KELVIN_MIN; k <= KELVIN_MAX; k += 100) {
    const c = kelvinToRgb(k);
    const sum = c.r + c.g + c.b || 1;
    WHITES.push({ k, r: c.r / sum, g: c.g / sum, b: c.b / sum });
}

/** The white whose tint is closest to this colour (by chromaticity, brightness ignored). */
function rgbToKelvin({ r, g, b }) {
    const sum = byte(r) + byte(g) + byte(b);
    if (!sum) return 4000;
    const R = byte(r) / sum; const G = byte(g) / sum; const B = byte(b) / sum;
    let best = WHITES[0]; let bestD = Infinity;
    for (const w of WHITES) {
        const d = (w.r - R) ** 2 + (w.g - G) ** 2 + (w.b - B) ** 2;
        if (d < bestD) { bestD = d; best = w; }
    }
    return best.k;
}

const GAMUT_C = Object.freeze({ red: { x: 0.6915, y: 0.3083 }, green: { x: 0.17, y: 0.7 }, blue: { x: 0.1532, y: 0.0475 } });
const D65 = { x: 0.3127, y: 0.329 };

function gammaExpand(v) { return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; }
function gammaCompress(v) { return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; }

function cross(a, b) { return a.x * b.y - a.y * b.x; }
function inTriangle(p, g) {
    const v1 = { x: g.green.x - g.red.x, y: g.green.y - g.red.y };
    const v2 = { x: g.blue.x - g.red.x, y: g.blue.y - g.red.y };
    const q = { x: p.x - g.red.x, y: p.y - g.red.y };
    const d = cross(v1, v2);
    if (!d) return true;
    const s = cross(q, v2) / d; const t = cross(v1, q) / d;
    return s >= 0 && t >= 0 && s + t <= 1;
}
function closestOnLine(a, b, p) {
    const ap = { x: p.x - a.x, y: p.y - a.y }; const ab = { x: b.x - a.x, y: b.y - a.y };
    const len = ab.x * ab.x + ab.y * ab.y;
    const t = len ? clamp((ap.x * ab.x + ap.y * ab.y) / len, 0, 1) : 0;
    return { x: a.x + ab.x * t, y: a.y + ab.y * t };
}
function validGamut(g) {
    return g && ['red', 'green', 'blue'].every((k) => g[k] && Number.isFinite(g[k].x) && Number.isFinite(g[k].y)) ? g : GAMUT_C;
}

function rgbToXy({ r, g, b }, gamut) {
    const R = gammaExpand(byte(r) / 255); const G = gammaExpand(byte(g) / 255); const B = gammaExpand(byte(b) / 255);
    const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
    const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
    const sum = X + Y + Z;
    let p = sum ? { x: X / sum, y: Y / sum } : { ...D65 };
    const gm = validGamut(gamut);
    if (!inTriangle(p, gm)) {
        const cands = [closestOnLine(gm.red, gm.green, p), closestOnLine(gm.green, gm.blue, p), closestOnLine(gm.blue, gm.red, p)];
        p = cands.reduce((best, c) => ((c.x - p.x) ** 2 + (c.y - p.y) ** 2 < (best.x - p.x) ** 2 + (best.y - p.y) ** 2 ? c : best));
    }
    return { x: Math.round(p.x * 10000) / 10000, y: Math.round(p.y * 10000) / 10000 };
}

function xyToRgb(x, y) {
    const X0 = Number(x); const Y0 = Number(y);
    if (!Number.isFinite(X0) || !Number.isFinite(Y0) || Y0 <= 0) return { r: 255, g: 255, b: 255 };
    const Y = 1; const X = (Y / Y0) * X0; const Z = (Y / Y0) * (1 - X0 - Y0);
    let r = X * 3.2406 - Y * 1.5372 - Z * 0.4986;
    let g = -X * 0.9689 + Y * 1.8758 + Z * 0.0415;
    let b = X * 0.0557 - Y * 0.204 + Z * 1.057;
    r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
    const max = Math.max(r, g, b) || 1;
    return { r: byte(gammaCompress(r / max) * 255), g: byte(gammaCompress(g / max) * 255), b: byte(gammaCompress(b / max) * 255) };
}

function kelvinToMirek(k) { return Math.round(1e6 / clamp(k, KELVIN_MIN, KELVIN_MAX)); }
function mirekToKelvin(m) { const v = Number(m); return v > 0 ? Math.round(1e6 / v) : null; }

module.exports = {
    CSS_COLORS, KELVIN_MIN, KELVIN_MAX, GAMUT_C,
    parseColor, parseHex, rgbToHex, rgbToHsv, hsvToRgb, kelvinToRgb, rgbToKelvin, rgbToXy, xyToRgb, kelvinToMirek, mirekToKelvin,
};
