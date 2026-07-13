#!/usr/bin/env node
/**
 * Generate the Grow a Tree tile + background sprites.
 *
 * The upstream project renders trees with a closed-source image server and ships no
 * artwork at all, so every sprite here is drawn from scratch as SVG and rasterized with
 * sharp.
 *
 *   node scripts/growtree-generate-art.mjs
 *   node scripts/growtree-generate-art.mjs --tile 96
 *
 * Output: assets/growtree/tiles/<name>.png and assets/growtree/bg/<Name>.png
 */
import sharp from 'sharp';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { TILE, TILE_NAMES } from '../core/growtree/tiles.js';
import { BACKGROUNDS } from '../core/growtree/formulas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'assets', 'growtree');

const val = f => { const i = process.argv.indexOf(`--${f}`); return i !== -1 ? process.argv[i + 1] : null; };
const TILE_SIZE = Number(val('tile') || 96);
// Branches overhang the trunk, so tiles are drawn on a wider canvas than they are tall.
const TILE_W = TILE_SIZE * 3;
const TILE_H = TILE_SIZE;

const BARK = '#6B4A2F';
const BARK_DARK = '#4A3220';
const BARK_LIGHT = '#8A6440';
const LEAF = '#3E8E41';
const LEAF_DARK = '#2C6B2F';
const HOLE = '#2A1B10';

/** The trunk column, centred, common to every tile. */
function trunk(w, h) {
  const x = w / 2 - TILE_SIZE * 0.22;
  const width = TILE_SIZE * 0.44;
  return `
    <rect x="${x}" y="0" width="${width}" height="${h}" fill="${BARK}"/>
    <rect x="${x}" y="0" width="${width * 0.28}" height="${h}" fill="${BARK_LIGHT}" opacity="0.5"/>
    <rect x="${x + width * 0.78}" y="0" width="${width * 0.22}" height="${h}" fill="${BARK_DARK}" opacity="0.6"/>
    <g stroke="${BARK_DARK}" stroke-width="1.5" opacity="0.45">
      <path d="M${x + width * 0.4} 6 v${h - 12}"/>
      <path d="M${x + width * 0.62} 10 v${h - 22}"/>
    </g>`;
}

/** A leafy bough sprouting left or right. */
function branch(side, big, w, h) {
  const cx = w / 2;
  const dir = side === 'right' ? 1 : -1;
  const reach = TILE_SIZE * (big ? 1.15 : 0.8);
  const tipX = cx + dir * reach;
  const tipY = h * (big ? 0.18 : 0.3);
  const limbY = h * 0.62;
  const r = TILE_SIZE * (big ? 0.42 : 0.32);

  return `
    <path d="M${cx} ${limbY} Q${cx + dir * reach * 0.55} ${limbY - h * 0.1} ${tipX} ${tipY + r * 0.55}"
          stroke="${BARK}" stroke-width="${TILE_SIZE * 0.13}" fill="none" stroke-linecap="round"/>
    <g>
      <circle cx="${tipX}" cy="${tipY + r * 0.4}" r="${r}" fill="${LEAF_DARK}"/>
      <circle cx="${tipX - dir * r * 0.45}" cy="${tipY + r * 0.75}" r="${r * 0.78}" fill="${LEAF}"/>
      <circle cx="${tipX + dir * r * 0.35}" cy="${tipY + r * 0.15}" r="${r * 0.66}" fill="${LEAF}"/>
      <circle cx="${tipX}" cy="${tipY - r * 0.2}" r="${r * 0.55}" fill="${LEAF}" opacity="0.9"/>
    </g>`;
}

function tileSvg(tile) {
  const w = TILE_W, h = TILE_H;
  let extra = '';

  switch (tile) {
    case TILE.SMALL_HOLE:
      extra = `<ellipse cx="${w / 2 - TILE_SIZE * 0.04}" cy="${h * 0.5}" rx="${TILE_SIZE * 0.09}" ry="${TILE_SIZE * 0.12}" fill="${HOLE}"/>`;
      break;
    case TILE.LARGE_HOLE:
      extra = `
        <ellipse cx="${w / 2}" cy="${h * 0.5}" rx="${TILE_SIZE * 0.16}" ry="${TILE_SIZE * 0.2}" fill="${HOLE}"/>
        <ellipse cx="${w / 2 + TILE_SIZE * 0.05}" cy="${h * 0.44}" rx="${TILE_SIZE * 0.04}" ry="${TILE_SIZE * 0.05}" fill="#0F0906"/>`;
      break;
    case TILE.RIGHT_BRANCH_1: extra = branch('right', false, w, h); break;
    case TILE.RIGHT_BRANCH_2: extra = branch('right', true, w, h); break;
    case TILE.LEFT_BRANCH_1: extra = branch('left', false, w, h); break;
    case TILE.LEFT_BRANCH_2: extra = branch('left', true, w, h); break;
    case TILE.SAPLING: {
      // The foot of the tree: roots flaring into the soil.
      const cx = w / 2;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
        ${trunk(w, h)}
        <path d="M${cx} ${h * 0.55} q${-TILE_SIZE * 0.5} ${h * 0.2} ${-TILE_SIZE * 0.62} ${h * 0.45} l${TILE_SIZE * 0.3} 0 q${TILE_SIZE * 0.1} ${-h * 0.2} ${TILE_SIZE * 0.32} ${-h * 0.3} z" fill="${BARK}"/>
        <path d="M${cx} ${h * 0.55} q${TILE_SIZE * 0.5} ${h * 0.2} ${TILE_SIZE * 0.62} ${h * 0.45} l${-TILE_SIZE * 0.3} 0 q${-TILE_SIZE * 0.1} ${-h * 0.2} ${-TILE_SIZE * 0.32} ${-h * 0.3} z" fill="${BARK_DARK}"/>
      </svg>`;
    }
    default: break; // BASE
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    ${trunk(w, h)}
    ${extra}
  </svg>`;
}

const BG_W = TILE_W;
const BG_H = TILE_H * 6;

function bgSvg(name) {
  if (name === 'Sky') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${BG_W}" height="${BG_H}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#4FA3E3"/><stop offset="100%" stop-color="#BFE3F7"/>
      </linearGradient></defs>
      <rect width="${BG_W}" height="${BG_H}" fill="url(#g)"/>
      <g fill="#FFFFFF" opacity="0.85">
        <ellipse cx="${BG_W * 0.22}" cy="${BG_H * 0.2}" rx="52" ry="22"/>
        <ellipse cx="${BG_W * 0.3}" cy="${BG_H * 0.19}" rx="34" ry="18"/>
        <ellipse cx="${BG_W * 0.78}" cy="${BG_H * 0.42}" rx="44" ry="19"/>
      </g>
    </svg>`;
  }
  if (name === 'SpaceEdge') {
    const stars = Array.from({ length: 90 }, (_, i) => {
      // Deterministic scatter — no Math.random, so regenerating is reproducible.
      const x = ((i * 7919) % BG_W);
      const y = ((i * 104729) % BG_H);
      const r = (i % 3) * 0.7 + 0.6;
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="#FFFFFF" opacity="${0.35 + (i % 5) * 0.13}"/>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${BG_W}" height="${BG_H}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#05060F"/><stop offset="70%" stop-color="#15173A"/>
        <stop offset="100%" stop-color="#3A2A6B"/>
      </linearGradient></defs>
      <rect width="${BG_W}" height="${BG_H}" fill="url(#g)"/>
      ${stars}
    </svg>`;
  }
  // Ground
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BG_W}" height="${BG_H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#8FD0F0"/><stop offset="70%" stop-color="#CFE9C4"/>
      <stop offset="70%" stop-color="#5C8C3F"/><stop offset="100%" stop-color="#3E6B2A"/>
    </linearGradient></defs>
    <rect width="${BG_W}" height="${BG_H}" fill="url(#g)"/>
    <circle cx="${BG_W * 0.8}" cy="${BG_H * 0.12}" r="34" fill="#FFE97F" opacity="0.9"/>
  </svg>`;
}

async function main() {
  await mkdir(join(OUT, 'tiles'), { recursive: true });
  await mkdir(join(OUT, 'bg'), { recursive: true });

  for (const [id, name] of Object.entries(TILE_NAMES)) {
    const png = await sharp(Buffer.from(tileSvg(Number(id)))).png({ compressionLevel: 9 }).toBuffer();
    const file = join(OUT, 'tiles', `${name.toLowerCase()}.png`);
    await writeFile(file, png);
    console.log(`  tile ${name.padEnd(15)} ${String(png.length).padStart(6)} bytes`);
  }

  for (const name of BACKGROUNDS) {
    const png = await sharp(Buffer.from(bgSvg(name))).png({ compressionLevel: 9 }).toBuffer();
    await writeFile(join(OUT, 'bg', `${name}.png`), png);
    console.log(`  bg   ${name.padEnd(15)} ${String(png.length).padStart(6)} bytes`);
  }

  console.log(`\n${Object.keys(TILE_NAMES).length} tiles + ${BACKGROUNDS.length} backgrounds → ${OUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
