// Greenhouse decorations (phase 4), drawn as SVG from a few shapes each, like art/plant.js: no image files.
// viewBox 0 0 64 64, ground line at y = 56. Decorative: the name is always shown next to the picture, so
// the SVG is hidden from assistive technology.
import { s } from '../lib/dom.js';

const STONE = 'hsl(30 6% 62%)';
const STONE_D = 'hsl(30 6% 46%)';
const LEAF = 'hsl(130 38% 40%)';
const LEAF_L = 'hsl(110 42% 52%)';
const WATER = 'hsl(198 62% 58%)';
const WOOD = 'hsl(28 40% 38%)';
const GLASS = 'hsl(190 40% 80%)';
const GOLD = 'hsl(45 80% 56%)';
const GOLD_D = 'hsl(40 70% 40%)';
const ROSE = 'hsl(345 62% 62%)';
const ORANGE = 'hsl(30 90% 58%)';
const KOI = 'hsl(18 90% 58%)';

const r = (x, y, w, h, fill, rx = 0) => s('rect', { x, y, width: w, height: h, rx, fill });
const c = (cx, cy, rad, fill) => s('circle', { cx, cy, r: rad, fill });
const e = (cx, cy, rx, ry, fill) => s('ellipse', { cx, cy, rx, ry, fill });
const p = (d, fill, stroke = null, width = 2) => s('path', { d, fill, stroke, 'stroke-width': stroke ? width : null, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });

// Each entry draws the decoration's shapes.
const DRAW = Object.freeze({
    potted_fern: () => [
        p('M32 6v10', 'none', WOOD, 1.5),
        p('M20 16h24l-4 12H24z', 'hsl(20 40% 46%)'),
        p('M32 26c-8 4-14 12-16 24M32 26c8 4 14 12 16 24M32 26c-3 8-4 16-3 26M32 26c3 8 4 16 3 26', 'none', LEAF, 2.5)
    ],
    stone_path: () => [
        e(14, 52, 9, 4, STONE), e(32, 46, 9, 4, STONE_D), e(48, 52, 9, 4, STONE), e(24, 38, 7, 3, STONE), e(42, 34, 6, 3, STONE_D)
    ],
    bird_bath: () => [
        r(28, 30, 8, 22, STONE_D, 2), r(20, 52, 24, 4, STONE, 2), e(32, 28, 18, 5, STONE), e(32, 26, 14, 3, WATER),
        p('M40 18c2-3 6-3 7 0-2 1-4 2-7 0z', 'hsl(210 20% 40%)')
    ],
    wind_chime: () => [
        p('M32 4v8', 'none', WOOD, 2), r(18, 12, 28, 4, WOOD, 2),
        r(21, 16, 3, 26, GLASS), r(27, 16, 3, 32, GLASS), r(34, 16, 3, 22, GLASS), r(40, 16, 3, 28, GLASS),
        c(32, 50, 3, GOLD)
    ],
    trellis_arch: () => [
        p('M12 56V28a20 20 0 0 1 40 0v28', 'none', WOOD, 3),
        p('M18 56V30a14 14 0 0 1 28 0v26', 'none', WOOD, 1.5),
        c(16, 30, 3, ROSE), c(24, 16, 3, ROSE), c(40, 14, 3, ROSE), c(48, 26, 3, ROSE), c(13, 44, 2.5, ROSE), c(51, 40, 2.5, ROSE),
        p('M14 40c4-2 6-6 6-10M50 34c-4-2-6-6-6-10', 'none', LEAF, 2)
    ],
    koi_pond: () => [
        e(32, 46, 28, 11, STONE_D), e(32, 45, 24, 8, WATER),
        p('M22 44c3-3 7-3 9 0-2 2-6 3-9 0z', KOI), p('M38 47c3-3 7-3 9 0-2 2-6 3-9 0z', 'hsl(0 0% 96%)'),
        e(44, 41, 4, 2, LEAF_L)
    ],
    glass_cupola: () => [
        r(14, 40, 36, 16, 'hsl(0 0% 92%)', 2), p('M14 40a18 18 0 0 1 36 0z', GLASS), p('M32 22v18M23 26l4 14M41 26l-4 14', 'none', 'hsl(0 0% 96%)', 1.5),
        c(32, 20, 2.5, GOLD)
    ],
    sundial: () => [
        r(26, 34, 12, 18, STONE_D, 2), r(20, 52, 24, 4, STONE, 2), e(32, 32, 16, 5, STONE), p('M32 32 44 22v8z', GOLD_D)
    ],
    fountain: () => [
        e(32, 52, 26, 5, STONE_D), e(32, 50, 22, 3, WATER), r(29, 30, 6, 20, STONE), e(32, 30, 12, 3.5, STONE),
        r(31, 18, 2, 12, STONE_D), e(32, 18, 6, 2, STONE), p('M32 12c-6 2-10 8-10 16M32 12c6 2 10 8 10 16', 'none', WATER, 1.5)
    ],
    orangery_wing: () => [
        r(8, 28, 48, 28, GLASS, 2), p('M8 28 32 12l24 16z', 'hsl(190 30% 70%)'), p('M20 28v28M32 28v28M44 28v28', 'none', 'hsl(0 0% 96%)', 1.5),
        c(20, 48, 4, LEAF), c(44, 48, 4, LEAF), c(19, 46, 1.5, ORANGE), c(45, 47, 1.5, ORANGE)
    ],
    golden_can: () => [
        p('M16 30h24v20a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4z', GOLD), p('M40 36 56 22', 'none', GOLD_D, 4), e(56, 21, 4, 2.5, GOLD_D),
        p('M20 30c0-8 16-8 16 0', 'none', GOLD_D, 3)
    ],
    laurel_arch: () => [
        p('M14 56V30a18 18 0 0 1 36 0v26', 'none', LEAF, 4),
        ...[0, 1, 2, 3, 4, 5].flatMap(i => [e(12 + i * 1.5, 50 - i * 6, 4, 2, LEAF_L), e(52 - i * 1.5, 50 - i * 6, 4, 2, LEAF_L)]),
        c(32, 12, 3, GOLD)
    ]
});

/** An SVG picture of a decoration (unknown codes get a small leaf). */
export function decorSvg(code, { className = 'decor-art' } = {}) {
    const svg = s('svg', { viewBox: '0 0 64 64', class: className, 'aria-hidden': 'true', focusable: 'false' });
    const parts = (DRAW[code] || (() => [p('M18 50c0-20 10-32 30-34-1 20-12 32-30 34z', LEAF)]))();
    for (const part of parts) svg.appendChild(part);
    return svg;
}
