#!/usr/bin/env node
/**
 * Grow a Tree artwork generator.
 *
 * Every tile and background the game uses is drawn here from SVG primitives and rasterised
 * with sharp. Nothing is traced from or based on other artwork, so the output is original to
 * CertiFried and covered by the project's licence (AGPL-3.0-or-later).
 *
 * The output is reproducible: all "random" detail comes from a seeded PRNG, so running the
 * script twice gives byte-identical PNGs (for the same sharp/librsvg version).
 *
 *   node scripts/assets/growtree-art.mjs              write assets/growtree/{tiles,bg}/*.png
 *   node scripts/assets/growtree-art.mjs --out DIR    write somewhere else (for previews)
 *   node scripts/assets/growtree-art.mjs --preview    also write DIR/preview.png, a sample tree
 *
 * Constraints the renderer (core/growtree/renderer.js) relies on:
 *   - tiles: 288x96 RGBA with a transparent background, one per TILE_NAMES entry,
 *     file name = lower-cased tile name. The trunk occupies the same columns in every tile and
 *     its texture repeats every 96 px, so tiles stack seamlessly in any order.
 *   - backgrounds: 288x576 opaque PNGs named after BACKGROUNDS (Ground, Sky, SpaceEdge).
 *   - palette: warm bark browns and leaf greens on the tiles; sky blues, grass greens and a
 *     deep-space indigo on the backgrounds.
 */
import sharp from 'sharp';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { TILE, TILE_NAMES } from '../../core/growtree/tiles.js';
import { BACKGROUNDS } from '../../core/growtree/formulas.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (flag) => { const i = process.argv.indexOf(`--${flag}`); return i !== -1 ? process.argv[i + 1] : null; };
const OUT = arg('out') ? resolve(arg('out')) : join(ROOT, 'assets', 'growtree');
const PREVIEW = process.argv.includes('--preview');

const S = 96;            // tile height, and the unit every measurement is based on
const W = S * 3;         // tiles are wider than tall so branches can overhang the trunk
const H = S;
const BG_W = W;
const BG_H = S * 6;

const C = {
  barkDeep: '#36241A',
  barkDark: '#4A3220',
  bark: '#6B4A2F',
  barkLight: '#8A6440',
  barkPale: '#A57C52',
  leafDeep: '#1F4F23',
  leafDark: '#2C6B2F',
  leaf: '#3E8E41',
  leafLight: '#5FB35A',
  leafPale: '#8FD07A',
  hole: '#2A1B10',
  holeDeep: '#0F0906',
  soil: '#5A3B22',
  soilDark: '#3F2915',
  grass: '#4F9A3A',
};

/** mulberry32: a tiny seeded PRNG so every run draws the same picture. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n) => Number(n.toFixed(2));

// ---------------------------------------------------------------- trunk

const TRUNK_W = S * 0.44;
const TRUNK_X = W / 2 - TRUNK_W / 2;

/**
 * A vertical bark ridge whose sideways wobble is periodic over the tile height, so the ridge
 * meets itself exactly where one tile sits on another.
 */
function ridge(x, amp, phase, width, color, opacity) {
  const pts = [];
  for (let y = 0; y <= H; y += 6) {
    const dx = amp * Math.sin((2 * Math.PI * y) / H + phase) + amp * 0.4 * Math.sin((4 * Math.PI * y) / H + phase * 2);
    pts.push(`${f(x + dx)} ${y}`);
  }
  return `<path d="M${pts.join(' L')}" stroke="${color}" stroke-width="${width}" fill="none" stroke-linecap="round" opacity="${opacity}"/>`;
}

function trunk() {
  const x = TRUNK_X, w = TRUNK_W;
  const ridges = [
    ridge(x + w * 0.22, 1.6, 0.3, 1.6, C.barkDark, 0.55),
    ridge(x + w * 0.41, 2.0, 1.9, 2.0, C.barkDeep, 0.45),
    ridge(x + w * 0.58, 1.4, 3.7, 1.4, C.barkDark, 0.5),
    ridge(x + w * 0.76, 1.8, 5.1, 1.8, C.barkDeep, 0.5),
    ridge(x + w * 0.31, 1.2, 4.4, 1.0, C.barkPale, 0.35),
    ridge(x + w * 0.67, 1.1, 2.6, 0.9, C.barkPale, 0.25),
  ].join('');
  return `
    <defs>
      <linearGradient id="trunkShade" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="${C.barkDark}"/>
        <stop offset="18%" stop-color="${C.barkLight}"/>
        <stop offset="45%" stop-color="${C.bark}"/>
        <stop offset="85%" stop-color="${C.barkDark}"/>
        <stop offset="100%" stop-color="${C.barkDeep}"/>
      </linearGradient>
    </defs>
    <rect x="${f(x)}" y="0" width="${f(w)}" height="${H}" fill="url(#trunkShade)"/>
    ${ridges}
    <rect x="${f(x)}" y="0" width="1.5" height="${H}" fill="${C.barkDeep}" opacity="0.7"/>
    <rect x="${f(x + w - 1.5)}" y="0" width="1.5" height="${H}" fill="${C.barkDeep}" opacity="0.8"/>`;
}

/** A few short bark scuffs, kept clear of the top and bottom edges so tiles still join cleanly. */
function scuffs(seed) {
  const r = prng(seed);
  let out = '';
  for (let i = 0; i < 4; i++) {
    const cx = TRUNK_X + TRUNK_W * (0.2 + r() * 0.6);
    const cy = 16 + r() * (H - 32);
    const len = 4 + r() * 6;
    out += `<path d="M${f(cx)} ${f(cy)} q${f(len * 0.3)} ${f(len * 0.5)} 0 ${f(len)}" stroke="${C.barkDeep}" stroke-width="1.2" fill="none" opacity="0.5"/>`;
  }
  return out;
}

// ---------------------------------------------------------------- holes

function knothole(large) {
  const cx = W / 2 + (large ? 0 : -S * 0.04);
  const cy = H * 0.5;
  const rx = S * (large ? 0.15 : 0.085);
  const ry = S * (large ? 0.2 : 0.115);
  return `
    <defs>
      <radialGradient id="holeIn" cx="0.42" cy="0.38" r="0.7">
        <stop offset="0%" stop-color="${C.holeDeep}"/>
        <stop offset="75%" stop-color="${C.hole}"/>
        <stop offset="100%" stop-color="${C.barkDeep}"/>
      </radialGradient>
    </defs>
    <ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx + 4)}" ry="${f(ry + 4)}" fill="${C.barkLight}" opacity="0.85"/>
    <ellipse cx="${f(cx + 1)}" cy="${f(cy + 1.5)}" rx="${f(rx + 2)}" ry="${f(ry + 2)}" fill="${C.barkDark}"/>
    <ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" fill="url(#holeIn)"/>
    <path d="M${f(cx - rx - 3)} ${f(cy - ry * 0.2)} a${f(rx + 3)} ${f(ry + 3)} 0 0 1 ${f(rx * 1.4)} ${f(-ry - 2.5)}"
          stroke="${C.barkPale}" stroke-width="1.6" fill="none" opacity="0.7" stroke-linecap="round"/>
    ${large ? `<ellipse cx="${f(cx + rx * 0.35)}" cy="${f(cy - ry * 0.3)}" rx="2.2" ry="2.8" fill="#F4E3B5" opacity="0.55"/>
               <ellipse cx="${f(cx - rx * 0.3)}" cy="${f(cy - ry * 0.25)}" rx="1.6" ry="2" fill="#F4E3B5" opacity="0.4"/>` : ''}`;
}

// ---------------------------------------------------------------- branches

/** A tapered limb leaving the trunk, ending in a rounded canopy of leaves. */
function branch(side, big, seed) {
  const r = prng(seed);
  const dir = side === 'right' ? 1 : -1;
  const baseX = W / 2 + dir * (TRUNK_W / 2 - 3);
  const baseY = H * 0.7;
  const reach = S * (big ? 1.02 : 0.74);
  const tipX = W / 2 + dir * reach;
  const tipY = H * (big ? 0.36 : 0.42);
  const thick = S * (big ? 0.13 : 0.1);
  const midX = baseX + dir * reach * 0.45;
  const midY = baseY - H * 0.08;

  // Limb as a filled, tapering shape: upper edge out to the tip, lower edge back to the trunk.
  const limb = `<path d="M${f(baseX)} ${f(baseY - thick)}
      Q${f(midX)} ${f(midY - thick * 0.9)} ${f(tipX)} ${f(tipY - 2)}
      L${f(tipX)} ${f(tipY + 3)}
      Q${f(midX)} ${f(midY + thick * 0.5)} ${f(baseX)} ${f(baseY + thick * 0.7)} Z" fill="${C.bark}"/>
    <path d="M${f(baseX)} ${f(baseY - thick * 0.75)} Q${f(midX)} ${f(midY - thick * 0.75)} ${f(tipX)} ${f(tipY - 1)}"
      stroke="${C.barkLight}" stroke-width="1.6" fill="none" opacity="0.6"/>
    <path d="M${f(baseX)} ${f(baseY + thick * 0.55)} Q${f(midX)} ${f(midY + thick * 0.35)} ${f(tipX)} ${f(tipY + 2.5)}"
      stroke="${C.barkDeep}" stroke-width="1.4" fill="none" opacity="0.6"/>`;

  // A twig off the limb, for shape.
  const twigX = baseX + dir * reach * 0.5;
  const twigY = baseY - H * 0.12;
  const twig = `<path d="M${f(twigX)} ${f(twigY)} q${f(dir * 6)} ${f(-H * 0.12)} ${f(dir * 16)} ${f(-H * 0.2)}"
      stroke="${C.bark}" stroke-width="3" fill="none" stroke-linecap="round"/>`;

  // Canopy: a cluster of overlapping leaf blobs, drawn back to front, dark to light.
  const rad = S * (big ? 0.34 : 0.26);
  const cx = tipX - dir * rad * 0.15;
  const cy = Math.max(rad + 2, tipY - rad * 0.2);
  const blobs = [];
  const n = big ? 11 : 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.5;
    const d = rad * (0.45 + r() * 0.35);
    blobs.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d * 0.8, rr: rad * (0.42 + r() * 0.2) });
  }
  // Keep the canopy inside the tile so nothing is clipped by the next row.
  const clampY = (y, rr) => Math.min(H - rr - 1, Math.max(rr + 1, y));
  const clampX = (x, rr) => Math.min(W - rr - 1, Math.max(rr + 1, x));
  const layer = (fill, scale, dy, opacity = 1) => blobs.map((b) => {
    const rr = b.rr * scale;
    return `<circle cx="${f(clampX(b.x, rr))}" cy="${f(clampY(b.y + dy, rr))}" r="${f(rr)}" fill="${fill}" opacity="${opacity}"/>`;
  }).join('');
  const core = `<circle cx="${f(clampX(cx, rad * 0.8))}" cy="${f(clampY(cy, rad * 0.8))}" r="${f(rad * 0.8)}" fill="${C.leafDark}"/>`;
  const sparkle = blobs.slice(0, big ? 6 : 4).map((b) => {
    const x = clampX(b.x - b.rr * 0.25, 3), y = clampY(b.y - b.rr * 0.45, 3);
    return `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(b.rr * 0.28)}" ry="${f(b.rr * 0.18)}" fill="${C.leafPale}" opacity="0.55"/>`;
  }).join('');

  return `${limb}${twig}
    <g>${layer(C.leafDeep, 1.05, 3)}${core}${layer(C.leafDark, 0.95, 1)}${layer(C.leaf, 0.82, -1)}${layer(C.leafLight, 0.5, -3, 0.85)}${sparkle}</g>`;
}

// ---------------------------------------------------------------- sapling (the tree's foot)

function foot(seed) {
  const r = prng(seed);
  const cx = W / 2;
  const roots = [];
  for (const dir of [-1, 1]) {
    for (const [spread, drop, wdt] of [[0.62, 0.42, 0.3], [0.38, 0.36, 0.22]]) {
      const end = cx + dir * S * spread;
      roots.push(`<path d="M${f(cx + dir * TRUNK_W * 0.2)} ${f(H * 0.5)}
        Q${f(cx + dir * S * spread * 0.55)} ${f(H * 0.62)} ${f(end)} ${f(H * (0.5 + drop))}
        L${f(end - dir * S * wdt)} ${f(H * (0.5 + drop))}
        Q${f(cx + dir * TRUNK_W * 0.35)} ${f(H * 0.75)} ${f(cx)} ${f(H * 0.62)} Z"
        fill="${dir < 0 ? C.bark : C.barkDark}"/>`);
    }
  }
  const mound = `<ellipse cx="${cx}" cy="${H + 4}" rx="${f(S * 0.95)}" ry="${f(S * 0.2)}" fill="${C.soil}"/>
    <ellipse cx="${cx}" cy="${H + 7}" rx="${f(S * 0.8)}" ry="${f(S * 0.14)}" fill="${C.soilDark}"/>`;
  let grass = '';
  for (let i = 0; i < 26; i++) {
    const gx = cx - S * 0.95 + r() * S * 1.9;
    const gh = 4 + r() * 8;
    const lean = (r() - 0.5) * 6;
    grass += `<path d="M${f(gx)} ${f(H - 1)} q${f(lean * 0.4)} ${f(-gh * 0.6)} ${f(lean)} ${f(-gh)}" stroke="${i % 3 ? C.grass : C.leafLight}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
  }
  const sprout = `<path d="M${f(cx + TRUNK_W * 0.55)} ${f(H * 0.38)} q${f(8)} ${f(-6)} ${f(14)} ${f(-4)}" stroke="${C.bark}" stroke-width="2" fill="none" stroke-linecap="round"/>
    <ellipse cx="${f(cx + TRUNK_W * 0.55 + 16)}" cy="${f(H * 0.38 - 6)}" rx="6" ry="3.4" fill="${C.leafLight}" transform="rotate(-25 ${f(cx + TRUNK_W * 0.55 + 16)} ${f(H * 0.38 - 6)})"/>`;
  return `${roots.join('')}${mound}${grass}${sprout}`;
}

// ---------------------------------------------------------------- tiles

function tileSvg(tile) {
  let body;
  switch (tile) {
    case TILE.SMALL_HOLE: body = trunk() + scuffs(11) + knothole(false); break;
    case TILE.LARGE_HOLE: body = trunk() + scuffs(12) + knothole(true); break;
    case TILE.RIGHT_BRANCH_1: body = trunk() + scuffs(13) + branch('right', false, 31); break;
    case TILE.RIGHT_BRANCH_2: body = trunk() + scuffs(14) + branch('right', true, 32); break;
    case TILE.LEFT_BRANCH_1: body = trunk() + scuffs(15) + branch('left', false, 33); break;
    case TILE.LEFT_BRANCH_2: body = trunk() + scuffs(16) + branch('left', true, 34); break;
    case TILE.SAPLING: body = trunk() + foot(41); break;
    default: body = trunk() + scuffs(10); break; // BASE
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
}

// ---------------------------------------------------------------- backgrounds

function cloud(x, y, scale, opacity) {
  const parts = [[0, 0, 30, 14], [-22, 5, 20, 10], [24, 4, 22, 11], [6, -9, 18, 11], [-8, -6, 14, 9]];
  return `<g opacity="${opacity}" filter="url(#soft)">${parts.map(([dx, dy, rx, ry]) =>
    `<ellipse cx="${f(x + dx * scale)}" cy="${f(y + dy * scale)}" rx="${f(rx * scale)}" ry="${f(ry * scale)}" fill="#FFFFFF"/>`).join('')}</g>`;
}

const softFilter = `<filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.4"/></filter>
  <filter id="haze" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="18"/></filter>`;

function hillPath(seed, baseY, amp, step) {
  const r = prng(seed);
  let d = `M0 ${BG_H} L0 ${f(baseY)}`;
  for (let x = 0; x <= BG_W; x += step) {
    const y = baseY - amp * (0.5 + 0.5 * Math.sin(x / 47 + seed)) - r() * amp * 0.3;
    d += ` L${x} ${f(y)}`;
  }
  return `${d} L${BG_W} ${BG_H} Z`;
}

function bgSvg(name) {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${BG_W}" height="${BG_H}" viewBox="0 0 ${BG_W} ${BG_H}">`;
  if (name === 'Sky') {
    return `${open}<defs>${softFilter}
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3B8FD6"/><stop offset="55%" stop-color="#7EC1EC"/><stop offset="100%" stop-color="#CBE9F8"/>
      </linearGradient></defs>
      <rect width="${BG_W}" height="${BG_H}" fill="url(#g)"/>
      ${cloud(BG_W * 0.24, BG_H * 0.16, 1.3, 0.92)}
      ${cloud(BG_W * 0.8, BG_H * 0.38, 1.05, 0.85)}
      ${cloud(BG_W * 0.15, BG_H * 0.62, 0.8, 0.7)}
      ${cloud(BG_W * 0.7, BG_H * 0.82, 1.2, 0.75)}
      <g stroke="#2E5E86" stroke-width="1.4" fill="none" stroke-linecap="round" opacity="0.55">
        <path d="M${f(BG_W * 0.56)} ${f(BG_H * 0.24)} q4 -4 8 0 q4 -4 8 0"/>
        <path d="M${f(BG_W * 0.63)} ${f(BG_H * 0.27)} q3 -3 6 0 q3 -3 6 0"/>
      </g>
    </svg>`;
  }
  if (name === 'SpaceEdge') {
    const r = prng(77);
    let stars = '';
    for (let i = 0; i < 120; i++) {
      const x = r() * BG_W, y = r() * BG_H * 0.85;
      const big = r() < 0.08;
      stars += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(big ? 1.6 + r() : 0.5 + r() * 0.8)}" fill="${r() < 0.2 ? '#CFE0FF' : '#FFFFFF'}" opacity="${f(0.35 + r() * 0.6)}"/>`;
      if (big) stars += `<path d="M${f(x - 4)} ${f(y)} h8 M${f(x)} ${f(y - 4)} v8" stroke="#FFFFFF" stroke-width="0.6" opacity="0.6"/>`;
    }
    return `${open}<defs>${softFilter}
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#04050E"/><stop offset="60%" stop-color="#121433"/>
        <stop offset="88%" stop-color="#2D2766"/><stop offset="100%" stop-color="#4F6FC4"/>
      </linearGradient></defs>
      <rect width="${BG_W}" height="${BG_H}" fill="url(#g)"/>
      <g filter="url(#haze)" opacity="0.5">
        <ellipse cx="${f(BG_W * 0.3)}" cy="${f(BG_H * 0.3)}" rx="80" ry="40" fill="#5B3C9E"/>
        <ellipse cx="${f(BG_W * 0.7)}" cy="${f(BG_H * 0.5)}" rx="70" ry="34" fill="#2C6E8F"/>
      </g>
      ${stars}
      <circle cx="${f(BG_W * 0.78)}" cy="${f(BG_H * 0.14)}" r="15" fill="#C9B79C"/>
      <circle cx="${f(BG_W * 0.78 + 5)}" cy="${f(BG_H * 0.14 - 3)}" r="15" fill="#04050E" opacity="0.55"/>
      <ellipse cx="${BG_W / 2}" cy="${BG_H + 40}" rx="${BG_W}" ry="70" fill="#7FB4F0" opacity="0.35" filter="url(#haze)"/>
    </svg>`;
  }
  // Ground: open sky over rolling hills, the tree planted on the nearest one.
  const horizon = BG_H * 0.7;
  return `${open}<defs>${softFilter}
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#7FC3EE"/><stop offset="100%" stop-color="#D6EFF5"/>
      </linearGradient>
      <linearGradient id="near" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#5E9A43"/><stop offset="100%" stop-color="#3A6526"/>
      </linearGradient></defs>
    <rect width="${BG_W}" height="${BG_H}" fill="url(#g)"/>
    <circle cx="${f(BG_W * 0.8)}" cy="${f(BG_H * 0.12)}" r="40" fill="#FFF3B0" opacity="0.35" filter="url(#haze)"/>
    <circle cx="${f(BG_W * 0.8)}" cy="${f(BG_H * 0.12)}" r="26" fill="#FFE47A"/>
    ${cloud(BG_W * 0.25, BG_H * 0.22, 1.1, 0.85)}
    ${cloud(BG_W * 0.62, BG_H * 0.4, 0.8, 0.7)}
    <path d="${hillPath(3, horizon - 26, 22, 12)}" fill="#9CC79A" opacity="0.9"/>
    <path d="${hillPath(7, horizon - 6, 16, 12)}" fill="#79AE66"/>
    <rect x="0" y="${f(horizon + 8)}" width="${BG_W}" height="${f(BG_H - horizon)}" fill="url(#near)"/>
    <path d="M0 ${f(horizon + 14)} Q${BG_W / 2} ${f(horizon - 4)} ${BG_W} ${f(horizon + 14)} L${BG_W} ${BG_H} L0 ${BG_H} Z" fill="url(#near)"/>
  </svg>`;
}

// ---------------------------------------------------------------- main

async function png(svg) {
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

async function main() {
  await mkdir(join(OUT, 'tiles'), { recursive: true });
  await mkdir(join(OUT, 'bg'), { recursive: true });

  for (const [id, name] of Object.entries(TILE_NAMES)) {
    const buf = await png(tileSvg(Number(id)));
    await writeFile(join(OUT, 'tiles', `${name.toLowerCase()}.png`), buf);
    console.log(`  tile ${name.padEnd(15)} ${String(buf.length).padStart(6)} bytes`);
  }
  for (const name of BACKGROUNDS) {
    let buf = await png(bgSvg(name));
    buf = await sharp(buf).flatten({ background: '#000000' }).ensureAlpha().png({ compressionLevel: 9 }).toBuffer();
    await writeFile(join(OUT, 'bg', `${name}.png`), buf);
    console.log(`  bg   ${name.padEnd(15)} ${String(buf.length).padStart(6)} bytes`);
  }

  if (PREVIEW) {
    // A sample tree on each background, side by side, to eyeball the set.
    const order = [TILE.LEFT_BRANCH_2, TILE.BASE, TILE.RIGHT_BRANCH_1, TILE.LARGE_HOLE, TILE.LEFT_BRANCH_1, TILE.SMALL_HOLE, TILE.RIGHT_BRANCH_2, TILE.BASE, TILE.SAPLING];
    const panels = [];
    for (const name of BACKGROUNDS) {
      const rows = order.slice(-6);
      const layers = rows.map((t, i) => ({ input: join(OUT, 'tiles', `${TILE_NAMES[t].toLowerCase()}.png`), top: i * H, left: 0 }));
      panels.push(await sharp(join(OUT, 'bg', `${name}.png`)).composite(layers).png().toBuffer());
    }
    const sheet = await sharp({ create: { width: BG_W * panels.length + 8 * (panels.length - 1), height: BG_H, channels: 4, background: '#202020' } })
      .composite(panels.map((p, i) => ({ input: p, left: i * (BG_W + 8), top: 0 }))).png().toBuffer();
    await writeFile(join(OUT, 'preview.png'), sheet);
    console.log(`  preview → ${join(OUT, 'preview.png')}`);
  }
  console.log(`\n${Object.keys(TILE_NAMES).length} tiles + ${BACKGROUNDS.length} backgrounds → ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
