/*
 * Grow a Tree — canopy renderer.
 *
 * The original tile renderer only ever stacked trunk segments, so a tree of any size came out as a
 * bare pole with a few branch nubs — no leaves, ever. This draws the thing people actually picture:
 * a trunk crowned by a full, layered canopy, on a sky, scaled by the tree's height.
 *
 * Original art, composed procedurally as an SVG and rasterised with sharp — nothing is traced from
 * any other bot's sprites. Deterministic per tree: the same tree always renders the same, because
 * every "random" placement is driven by a seed derived from the tree, not Math.random.
 */
import sharp from 'sharp';
import { getTreeHeight } from './formulas.js';

const W = 640, H = 840;

/** Tiny deterministic PRNG (mulberry32) so a given tree always looks identical. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(tree) {
  const s = String(tree?.name ?? '') + ':' + String(tree?.plantedBy ?? '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** A soft rounded blob of foliage. */
function blob(cx, cy, r, fill) {
  return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${fill}"/>`;
}

/**
 * Build the canopy as a cluster of overlapping blobs in three greens (shadow, mid, highlight),
 * sized by `radius`. `density` scales the number of blobs so a bigger crown reads as fuller.
 */
function canopy(cx, cy, radius, rand) {
  const DARK = '#2f7d32', MID = '#43a047', LIGHT = '#66bb6a';
  const out = [];
  const n = Math.round(10 + radius / 10);
  // Shadow pass (bottom-weighted), then mid, then highlight (top-weighted) — cheap depth.
  for (const [shade, yBias, spread, rScale] of [[DARK, 0.35, 1.0, 0.62], [MID, 0.0, 0.9, 0.55], [LIGHT, -0.4, 0.7, 0.42]]) {
    for (let i = 0; i < n; i++) {
      const ang = rand() * Math.PI * 2;
      const d = Math.pow(rand(), 0.5) * radius * spread;
      const bx = cx + Math.cos(ang) * d;
      const by = cy + Math.sin(ang) * d * 0.82 + yBias * radius * 0.25;
      out.push(blob(bx, by, radius * rScale * (0.28 + rand() * 0.22), shade));
    }
  }
  return out.join('');
}

/** One fluffy cloud from three lumps. */
function cloud(x, y, s) {
  return `<g opacity="0.9" fill="#ffffff">
    <ellipse cx="${x}" cy="${y}" rx="${34 * s}" ry="${18 * s}"/>
    <ellipse cx="${x - 26 * s}" cy="${y + 6 * s}" rx="${22 * s}" ry="${14 * s}"/>
    <ellipse cx="${x + 28 * s}" cy="${y + 5 * s}" rx="${24 * s}" ry="${15 * s}"/>
  </g>`;
}

/** A little "m" bird. */
function bird(x, y, s) {
  return `<path d="M ${x - 7 * s} ${y} Q ${x - 3 * s} ${y - 5 * s} ${x} ${y} Q ${x + 3 * s} ${y - 5 * s} ${x + 7 * s} ${y}"
     stroke="#3a3a4a" stroke-width="${1.6 * s}" fill="none" stroke-linecap="round"/>`;
}

/**
 * Render a tree to a PNG buffer. Height drives trunk length and canopy size; a very tall tree keeps
 * its crown in frame (the trunk stops growing past a cap, matching how the reference frames a giant).
 */
export async function renderCanopy(tree, ftOverride = null) {
  const rand = rng(seedOf(tree));
  const ft = Math.max(1, Math.floor(ftOverride ?? getTreeHeight(tree)));

  // Growth curve: young trees are short & thin, mature trees tall & full, then it saturates so the
  // canopy never leaves the frame.
  const t = 1 - Math.exp(-ft / 120);                 // 0..~1 saturating
  const groundY = H - 70;
  const trunkTopY = groundY - (120 + t * 430);       // canopy base
  const trunkW = 14 + t * 46;
  const crownR = 60 + t * 210;
  const crownCy = trunkTopY - crownR * 0.35;

  // Sky gradient + sun + clouds + a rainbow for big trees.
  const clouds = [cloud(120 + rand() * 60, 150 + rand() * 40, 0.8 + rand() * 0.5),
    cloud(500 + rand() * 60, 110 + rand() * 40, 0.9 + rand() * 0.5),
    cloud(430 + rand() * 60, 300 + rand() * 40, 0.7 + rand() * 0.4)].join('');
  const birds = ft > 20 ? Array.from({ length: 3 }, () =>
    bird(80 + rand() * 180, 120 + rand() * 120, 1.2 + rand())).join('') : '';
  const rainbow = ft > 150 ? `<g fill="none" stroke-width="7" opacity="0.5">
    ${['#e57373', '#ffb74d', '#fff176', '#81c784', '#64b5f6', '#9575cd'].map((c, i) =>
      `<path d="M -40 ${groundY} A 260 260 0 0 1 480 ${groundY}" stroke="${c}" transform="translate(0 ${i * 8})"/>`).join('')}
  </g>` : '';

  // Trunk: a gently tapered trunk with a couple of forks near the crown.
  const bx = W / 2;
  const trunk = `
    <path d="M ${bx - trunkW / 2} ${groundY}
             C ${bx - trunkW / 2 - 6} ${(groundY + trunkTopY) / 2}, ${bx - trunkW * 0.35} ${trunkTopY + 40}, ${bx - trunkW * 0.28} ${trunkTopY}
             L ${bx + trunkW * 0.28} ${trunkTopY}
             C ${bx + trunkW * 0.35} ${trunkTopY + 40}, ${bx + trunkW / 2 + 6} ${(groundY + trunkTopY) / 2}, ${bx + trunkW / 2} ${groundY} Z"
          fill="#6b4a2b"/>
    <path d="M ${bx - trunkW * 0.16} ${groundY} L ${bx - trunkW * 0.10} ${trunkTopY + 30}" stroke="#5a3d22" stroke-width="${trunkW * 0.16}" fill="none" opacity="0.6"/>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#4aa3e0"/><stop offset="0.7" stop-color="#8fd3f2"/><stop offset="1" stop-color="#bfe8ff"/>
      </linearGradient>
      <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="#fff6c8"/><stop offset="1" stop-color="#ffe066" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#sky)"/>
    <circle cx="560" cy="90" r="90" fill="url(#sun)"/>
    <circle cx="560" cy="90" r="34" fill="#ffe98a"/>
    ${clouds}${rainbow}${birds}
    <ellipse cx="${W / 2}" cy="${groundY + 30}" rx="${W}" ry="90" fill="#5aa845"/>
    <rect y="${groundY + 26}" width="${W}" height="${H - groundY}" fill="#4d9a3c"/>
    ${trunk}
    ${canopy(bx, crownCy, crownR, rand)}
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
