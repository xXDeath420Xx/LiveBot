/*
 * Grow a Tree — image renderer.
 *
 * Upstream POSTs to a closed-source image server; we composite locally with sharp instead.
 * Only the top SHOW_LAST_N tiles are drawn, stacked bottom-up on the tree's background,
 * so a 900ft tree renders as fast as a 3ft one.
 */
import sharp from 'sharp';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { TILE_NAMES, visibleTiles, SHOW_LAST_N } from './tiles.js';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'growtree');
const TILES_DIR = join(ASSETS, 'tiles');
const BG_DIR = join(ASSETS, 'bg');

// Tiles are fixed-size; read once from a real sprite so a re-render at a different
// --tile size doesn't need code changes.
let metrics = null;
async function getMetrics() {
  if (metrics) return metrics;
  const base = join(TILES_DIR, 'base.png');
  if (!existsSync(base)) return null;
  const { width, height } = await sharp(base).metadata();
  metrics = { tileW: width, tileH: height };
  return metrics;
}

export function artInstalled() {
  return existsSync(join(TILES_DIR, 'base.png')) && existsSync(join(BG_DIR, 'Ground.png'));
}

function tileFile(tile) {
  const name = TILE_NAMES[tile];
  if (!name) return null;
  const file = join(TILES_DIR, `${name.toLowerCase()}.png`);
  return existsSync(file) ? file : null;
}

/**
 * Render the visible top of a tree.
 * @returns {Promise<Buffer|null>} PNG, or null when the art isn't generated yet.
 */
export async function renderTree({ pieces, background = 'Ground' }) {
  if (!artInstalled()) return null;
  const m = await getMetrics();
  if (!m) return null;

  const bgFile = existsSync(join(BG_DIR, `${background}.png`)) ? join(BG_DIR, `${background}.png`) : join(BG_DIR, 'Ground.png');
  const rows = visibleTiles(pieces, SHOW_LAST_N);
  const canvasH = m.tileH * SHOW_LAST_N;

  const bg = await sharp(bgFile).resize(m.tileW, canvasH, { fit: 'cover', position: 'bottom' }).toBuffer();

  // Bottom-up: the LAST piece is the crown, so it sits at the top of the image.
  const layers = [];
  for (let i = 0; i < rows.length; i++) {
    const file = tileFile(rows[i]);
    if (!file) continue;
    const fromBottom = rows.length - 1 - i; // 0 = lowest visible tile
    layers.push({ input: file, top: canvasH - (fromBottom + 1) * m.tileH, left: 0 });
  }

  return sharp(bg).composite(layers).png({ compressionLevel: 9 }).toBuffer();
}

/** A text fallback for when the sprites aren't installed. */
export function renderTreeAscii(pieces) {
  const rows = visibleTiles(pieces, SHOW_LAST_N);
  const glyph = { 0: '  ║  ', 1: '  ╠  ', 2: '  ╬  ', 3: '  ╠══', 4: '══╣  ', 5: '  ╠══', 6: '══╣  ', 7: ' /║\\ ' };
  return '```\n' + rows.map(t => glyph[t] ?? '  ║  ').reverse().join('\n') + '\n```';
}

export { SHOW_LAST_N };
