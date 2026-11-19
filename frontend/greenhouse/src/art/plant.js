// Plant pictures, drawn as SVG from a few parameters, so the 12 base plants and all 66 hybrids need no image
// files. A base plant has hand-picked parameters (form, leaf colour, accent, pattern, flower, size); a hybrid
// mixes its two parents' parameters, chosen by a hash of the pair, so the same cross always looks the same.
//
// Coordinates: viewBox 0 0 100 100; the planter sits at the bottom and the plant grows up from (50, 80).
// Growth stage 0..1 scales the plant; flowers open only when it is ready.
import { s } from '../lib/dom.js';

// form: moss | frond | broad | round | rosette | trail | bell | cup | orchid
// colours are [hue, saturation %, lightness %]
const BASE = Object.freeze({
    sunmoss: { form: 'moss', leaf: [78, 52, 44], accent: [52, 85, 64], pattern: 'dots', size: 0.6 },
    velvet_fern: { form: 'frond', leaf: [140, 40, 32], accent: [140, 30, 46], pattern: 'none', size: 0.85 },
    ember_coleus: { form: 'broad', leaf: [10, 66, 44], accent: [92, 52, 46], pattern: 'edge', size: 0.75 },
    frostbell: { form: 'bell', leaf: [150, 24, 42], flower: [205, 62, 78], size: 0.82 },
    copper_calathea: { form: 'broad', leaf: [26, 52, 40], accent: [140, 34, 56], pattern: 'stripe', size: 0.9 },
    moonpetal: { form: 'cup', leaf: [110, 24, 38], flower: [48, 30, 90], size: 0.85 },
    glasswing_orchid: { form: 'orchid', leaf: [120, 32, 34], flower: [318, 55, 80], size: 0.9 },
    tiger_begonia: { form: 'broad', leaf: [100, 30, 30], accent: [42, 60, 62], pattern: 'spots', size: 0.8 },
    starlace_fern: { form: 'frond', leaf: [160, 22, 60], accent: [160, 16, 76], pattern: 'none', size: 0.92, fine: true },
    ruby_peperomia: { form: 'round', leaf: [350, 48, 36], accent: [350, 40, 60], pattern: 'vein', size: 0.65 },
    cloudleaf_ivy: { form: 'trail', leaf: [125, 20, 64], accent: [0, 0, 94], pattern: 'edge', size: 0.8 },
    aurora_bromeliad: { form: 'rosette', leaf: [140, 38, 34], accent: [330, 62, 56], pattern: 'stripe', size: 0.95 }
});

const FORMS = ['moss', 'frond', 'broad', 'round', 'rosette', 'trail', 'bell', 'cup', 'orchid'];

function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

const hsl = ([h, sat, l], dl = 0) => `hsl(${Math.round(h)} ${Math.round(sat)}% ${Math.max(5, Math.min(95, Math.round(l + dl)))}%)`;

function mixHue(a, b, t) {
    let d = b - a;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return (a + d * t + 360) % 360;
}
const mix = (a, b, t) => [mixHue(a[0], b[0], t), a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Parameters for a plant nobody hand-tuned (a base plant added later): derived from its id. */
function fallback(id) {
    const h = hash(`variety:${id}`);
    return {
        form: FORMS[h % FORMS.length],
        leaf: [90 + (h % 90), 30 + (h % 25), 32 + (h % 14)],
        accent: [(h >> 8) % 360, 50, 60],
        pattern: ['none', 'edge', 'stripe', 'spots', 'vein'][(h >> 4) % 5],
        flower: (h >> 12) % 2 ? [(h >> 16) % 360, 55, 75] : null,
        size: 0.7 + ((h >> 20) % 25) / 100
    };
}

/**
 * Art parameters for a variety. `lookup(id)` returns a variety ({ id, code, hybrid, parents }), so a hybrid
 * can find its parents' codes.
 */
export function artFor(variety, lookup) {
    if (!variety) return fallback(0);
    if (!variety.hybrid) return BASE[variety.code] || fallback(variety.id);
    const [idA, idB] = variety.parents || [0, 0];
    const a = artFor(lookup(idA), lookup);
    const b = artFor(lookup(idB), lookup);
    const h = hash(`hybrid:${Math.min(idA, idB)}:${Math.max(idA, idB)}`);
    const t = 0.35 + ((h >> 3) % 31) / 100;
    const first = h & 1 ? a : b;
    const second = first === a ? b : a;
    const accent = second.accent || second.flower || first.accent || [50, 60, 60];
    let flower = first.flower || second.flower || null;
    if (a.flower && b.flower) flower = mix(a.flower, b.flower, t);
    let pattern = (h >> 1) & 1 ? first.pattern : second.pattern;
    if (!pattern || pattern === 'none') pattern = first.pattern !== 'none' ? first.pattern : second.pattern;
    return {
        form: first.form,
        leaf: mix(a.leaf, b.leaf, t),
        accent,
        pattern: pattern || 'none',
        flower,
        size: (a.size + b.size) / 2,
        fine: !!(a.fine || b.fine)
    };
}

// ------------------------------------------------------------------ drawing

const leafPath = (len, wid) =>
    `M0 0 C${wid} ${-len * 0.25} ${wid * 0.9} ${-len * 0.75} 0 ${-len} C${-wid * 0.9} ${-len * 0.75} ${-wid} ${-len * 0.25} 0 0Z`;

function leaf({ len, wid, angle, x = 0, y = 0, p, shade = 0 }) {
    const g = s('g', { transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angle.toFixed(1)})` });
    g.appendChild(s('path', { d: leafPath(len, wid), fill: hsl(p.leaf, shade) }));
    const accent = p.accent ? hsl(p.accent) : hsl(p.leaf, 18);
    if (p.pattern === 'edge') {
        g.appendChild(s('path', { d: leafPath(len, wid), fill: 'none', stroke: accent, 'stroke-width': Math.max(1, wid * 0.16).toFixed(1) }));
    } else if (p.pattern === 'stripe') {
        g.appendChild(s('path', { d: `M0 ${-len * 0.08} L0 ${-len * 0.9}`, stroke: accent, 'stroke-width': Math.max(1, wid * 0.22).toFixed(1), 'stroke-linecap': 'round' }));
        g.appendChild(s('path', { d: `M0 ${-len * 0.3} L${wid * 0.45} ${-len * 0.45} M0 ${-len * 0.55} L${-wid * 0.45} ${-len * 0.7}`, stroke: accent, 'stroke-width': '0.9', fill: 'none' }));
    } else if (p.pattern === 'vein') {
        g.appendChild(s('path', { d: `M0 ${-len * 0.05} L0 ${-len * 0.88}`, stroke: accent, 'stroke-width': '1', fill: 'none' }));
    } else if (p.pattern === 'spots') {
        for (const [fx, fy] of [[0.3, 0.3], [-0.35, 0.45], [0.25, 0.62], [-0.2, 0.78]]) {
            g.appendChild(s('circle', { cx: (wid * fx).toFixed(1), cy: (-len * fy).toFixed(1), r: Math.max(0.9, wid * 0.13).toFixed(1), fill: accent }));
        }
    }
    return g;
}

function flowerHead({ x, y, r, color, petals = 5, rot = 0 }) {
    const g = s('g', { transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot})` });
    for (let i = 0; i < petals; i++) {
        g.appendChild(s('ellipse', { cx: 0, cy: (-r * 0.55).toFixed(1), rx: (r * 0.42).toFixed(1), ry: (r * 0.6).toFixed(1), fill: hsl(color), transform: `rotate(${(360 / petals) * i})` }));
    }
    g.appendChild(s('circle', { cx: 0, cy: 0, r: (r * 0.28).toFixed(1), fill: hsl(color, -28) }));
    return g;
}

const DRAW = {
    moss(g, p) {
        const rows = [[-20, -6, 5], [-15, -13, 4], [-7, -20, 2]];
        let i = 0;
        for (const [x0, y, n] of rows) {
            for (let k = 0; k < n; k++) {
                g.appendChild(s('circle', { cx: x0 + k * 10 + (n === 2 ? 4 : 0), cy: y, r: 7, fill: hsl(p.leaf, (i++ % 3) * 5 - 4) }));
            }
        }
        if (p.pattern === 'dots' || p.flower) {
            const c = hsl(p.flower || p.accent);
            for (const [x, y] of [[-14, -14], [-2, -24], [9, -18], [17, -9], [-6, -9]]) g.appendChild(s('circle', { cx: x, cy: y, r: 1.6, fill: c }));
        }
    },
    frond(g, p) {
        const n = p.fine ? 6 : 5;
        for (let i = 0; i < n; i++) {
            const angle = -62 + (124 / (n - 1)) * i;
            const len = 58 * (i === 0 || i === n - 1 ? 0.8 : 1);
            const f = s('g', { transform: `rotate(${angle.toFixed(1)})` });
            f.appendChild(s('path', { d: `M0 0 L0 ${-len}`, stroke: hsl(p.leaf, -6), 'stroke-width': '1.6', 'stroke-linecap': 'round' }));
            const pairs = p.fine ? 8 : 6;
            for (let j = 1; j <= pairs; j++) {
                const t = j / (pairs + 1);
                const l = (p.fine ? 9 : 12) * (1 - t * 0.6);
                const w = l * (p.fine ? 0.22 : 0.32);
                f.appendChild(leaf({ len: l, wid: w, angle: 62, y: -len * t, p: { ...p, pattern: 'none' } }));
                f.appendChild(leaf({ len: l, wid: w, angle: -62, y: -len * t, p: { ...p, pattern: 'none' } }));
            }
            g.appendChild(f);
        }
    },
    broad(g, p) {
        const angles = [-58, -32, -12, 10, 30, 56];
        angles.forEach((angle, i) => {
            const len = 44 * (i === 2 || i === 3 ? 1 : 0.8);
            g.appendChild(leaf({ len, wid: len * 0.42, angle, p, shade: i % 2 ? 4 : -2 }));
        });
        if (p.flower) g.appendChild(flowerHead({ x: 0, y: -48, r: 7, color: p.flower }));
    },
    round(g, p) {
        const spots = [[-22, -8, -70], [-16, -18, -45], [-6, -24, -15], [6, -24, 15], [16, -18, 45], [22, -8, 70], [-10, -12, -30], [10, -12, 30], [0, -16, 0]];
        for (const [x, y, a] of spots) {
            g.appendChild(s('path', { d: `M0 0 L${(x * 0.6).toFixed(1)} ${(y * 0.6).toFixed(1)}`, stroke: hsl(p.leaf, -10), 'stroke-width': '1.2' }));
            g.appendChild(leaf({ len: 14, wid: 10, angle: a, x: x * 0.6, y: y * 0.6, p }));
        }
        if (p.flower) g.appendChild(flowerHead({ x: 0, y: -36, r: 5, color: p.flower }));
    },
    rosette(g, p) {
        for (let i = 0; i < 9; i++) {
            const angle = -76 + 19 * i;
            const len = 52 * (1 - Math.abs(angle) / 260);
            g.appendChild(leaf({ len, wid: len * 0.13, angle, p, shade: i % 2 ? 5 : -3 }));
        }
    },
    trail(g, p) {
        const accentP = { ...p, pattern: p.pattern === 'none' ? 'edge' : p.pattern };
        for (const side of [-1, 1]) {
            g.appendChild(s('path', { d: `M0 -6 C${side * 18} -22 ${side * 34} -8 ${side * 30} 16`, stroke: hsl(p.leaf, -14), 'stroke-width': '1.4', fill: 'none' }));
            for (const [x, y, a] of [[10, -15, 30], [21, -14, 70], [29, -5, 110], [31, 8, 150]]) {
                g.appendChild(leaf({ len: 10, wid: 7, angle: side * a, x: side * x, y, p: accentP }));
            }
        }
        for (const a of [-25, 0, 25]) g.appendChild(leaf({ len: 18, wid: 11, angle: a, y: -4, p: accentP }));
        if (p.flower) g.appendChild(flowerHead({ x: 0, y: -26, r: 5, color: p.flower }));
    },
    bell(g, p) {
        for (const [x, h, lean] of [[-10, 46, -8], [0, 56, 0], [11, 42, 9]]) {
            g.appendChild(s('path', { d: `M${x * 0.3} 0 Q${x} ${-h * 0.6} ${x + lean} ${-h}`, stroke: hsl(p.leaf, -8), 'stroke-width': '1.6', fill: 'none' }));
            for (const t of [0.3, 0.55]) g.appendChild(leaf({ len: 13, wid: 5, angle: x < 0 ? -55 : 55, x: x * t, y: -h * t, p }));
        }
        g.appendChild(leaf({ len: 20, wid: 7, angle: -40, p }));
        g.appendChild(leaf({ len: 20, wid: 7, angle: 40, p }));
        if (p.flower) {
            for (const [x, y] of [[-12, -42], [0, -52], [12, -38]]) {
                g.appendChild(s('path', { d: `M${x - 4} ${y} Q${x - 5} ${y + 9} ${x - 6} ${y + 10} L${x + 6} ${y + 10} Q${x + 5} ${y + 9} ${x + 4} ${y} Q${x} ${y - 3} ${x - 4} ${y}Z`, fill: hsl(p.flower) }));
            }
        }
    },
    cup(g, p) {
        for (const a of [-70, -38, 38, 70]) g.appendChild(leaf({ len: 24, wid: 10, angle: a, p }));
        g.appendChild(s('path', { d: 'M0 0 Q3 -26 0 -50', stroke: hsl(p.leaf, -8), 'stroke-width': '1.8', fill: 'none' }));
        if (p.flower) g.appendChild(flowerHead({ x: 0, y: -52, r: 11, color: p.flower, petals: 6 }));
        else g.appendChild(s('ellipse', { cx: 0, cy: -52, rx: 3, ry: 5, fill: hsl(p.leaf, 10) }));
    },
    orchid(g, p) {
        for (const a of [-78, -60, 64, 80]) g.appendChild(leaf({ len: 26, wid: 9, angle: a, p }));
        g.appendChild(s('path', { d: 'M-2 -2 C-6 -40 18 -60 30 -46', stroke: hsl(p.leaf, -12), 'stroke-width': '1.5', fill: 'none' }));
        if (p.flower) {
            for (const [x, y, r] of [[2, -40, 8], [14, -52, 8], [27, -44, 7]]) g.appendChild(flowerHead({ x, y, r, color: p.flower }));
        } else {
            for (const [x, y] of [[8, -48], [20, -52]]) g.appendChild(s('circle', { cx: x, cy: y, r: 2.4, fill: hsl(p.leaf, 14) }));
        }
    }
};

function planter(svg) {
    svg.appendChild(s('path', { class: 'planter', d: 'M24 80 L76 80 L71 98 L29 98 Z' }));
    svg.appendChild(s('rect', { class: 'planter-rim', x: 21, y: 76, width: 58, height: 6, rx: 1.5 }));
    svg.appendChild(s('ellipse', { class: 'soil', cx: 50, cy: 77, rx: 26, ry: 2.2 }));
}

/**
 * The picture of a plant.
 *   params   from artFor(), or null for an empty planter
 *   stage    0..1 growth (1 = ready; flowers open)
 *   label    accessible name, or null to hide the picture from assistive technology (the name is in text)
 */
export function plantSvg(params, { stage = 1, label = null, className = 'plant-art' } = {}) {
    const svg = s('svg', { viewBox: '0 0 100 100', class: className, focusable: 'false' });
    if (label) {
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', label);
    } else {
        svg.setAttribute('aria-hidden', 'true');
    }
    planter(svg);
    if (!params) return svg;
    const st = Math.max(0, Math.min(1, stage));
    const g = s('g');
    if (st < 0.12) {
        g.setAttribute('transform', 'translate(50 77)');
        g.appendChild(s('path', { d: 'M0 0 L0 -8', stroke: hsl(params.leaf, -6), 'stroke-width': '1.6' }));
        g.appendChild(leaf({ len: 9, wid: 4.5, angle: -48, y: -7, p: { ...params, pattern: 'none' } }));
        g.appendChild(leaf({ len: 9, wid: 4.5, angle: 48, y: -7, p: { ...params, pattern: 'none' } }));
    } else {
        const k = (0.32 + 0.68 * st) * (params.size || 0.8) * 1.25;
        g.setAttribute('transform', `translate(50 78) scale(${k.toFixed(3)})`);
        const ready = st >= 1;
        const draw = DRAW[params.form] || DRAW.broad;
        draw(g, ready ? params : { ...params, flower: null });
    }
    svg.appendChild(g);
    return svg;
}
