#!/usr/bin/env node
/**
 * Generate original Cat Bot sprites — one per rarity tier.
 *
 * Everything here is drawn from scratch as SVG and rasterized with sharp. No upstream
 * artwork is used or derived from; see /LICENSE-CATBOT-NOTICE.md.
 *
 *   node scripts/catbot-generate-art.mjs            # writes assets/catbot/*.png
 *   node scripts/catbot-generate-art.mjs --size 256 # bigger spawn images
 *
 * Output feeds two things:
 *   • the spawn message image
 *   • scripts/catbot-upload-emoji.mjs, which uploads them as application emoji
 */
import sharp from 'sharp';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { CAT_TYPES } from '../core/catbot/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'assets', 'catbot');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SIZE = Number(arg('size', 128));

/**
 * Per-tier look. `coat`/`shade` colour the cat, `bg` the disc behind it, `eye` the eyes.
 * `accent` draws an optional flourish so tiers read apart at emoji size.
 */
const LOOKS = {
  Fine: { coat: '#B0AFAC', shade: '#8E8D8A', bg: '#2F3136', eye: '#7BD88F' },
  Nice: { coat: '#D9A066', shade: '#B57F4C', bg: '#2F3136', eye: '#7BD88F' },
  Good: { coat: '#E8C170', shade: '#C29A4F', bg: '#2F3136', eye: '#7BD88F' },
  Rare: { coat: '#6BA5E7', shade: '#4A7EBB', bg: '#1F2A3A', eye: '#FFE066', accent: 'sparkle' },
  Wild: { coat: '#C77B3C', shade: '#8F5626', bg: '#2A2118', eye: '#F2E14C', accent: 'stripes' },
  Baby: { coat: '#F5D7C4', shade: '#D0A98F', bg: '#2A211C', eye: '#6BC5E7', accent: 'sparkle' },
  Epic: { coat: '#A97BE0', shade: '#7E56B0', bg: '#241A33', eye: '#FFE066', accent: 'sparkle' },
  Sus: { coat: '#E05C5C', shade: '#B03F3F', bg: '#2E1A1A', eye: '#FFFFFF', accent: 'visor' },
  Brave: { coat: '#E8A33D', shade: '#B87A22', bg: '#2E2312', eye: '#FFFFFF', accent: 'cape' },
  Rickroll: { coat: '#D96BA0', shade: '#A84878', bg: '#2E1A26', eye: '#FFE066', accent: 'note' },
  Reverse: { coat: '#5BC7C7', shade: '#3E9494', bg: '#12292A', eye: '#FFE066', accent: 'flip' },
  Superior: { coat: '#E8D07A', shade: '#BFA84E', bg: '#2E2A16', eye: '#FFFFFF', accent: 'crown' },
  Trash: { coat: '#6E6A5F', shade: '#4E4B43', bg: '#22211D', eye: '#9BE07B', accent: 'fly' },
  Legendary: { coat: '#F2C14E', shade: '#C2933A', bg: '#33280E', eye: '#FFFFFF', accent: 'star' },
  Mythic: { coat: '#C46BE0', shade: '#8F45A8', bg: '#261430', eye: '#7BF2E0', accent: 'orb' },
  '8bit': { coat: '#5BE07B', shade: '#33A852', bg: '#101A12', eye: '#FFFFFF', accent: 'pixel' },
  Corrupt: { coat: '#3D3348', shade: '#241E2C', bg: '#0E0A12', eye: '#FF3B3B', accent: 'glitch' },
  Professor: { coat: '#8C7B6B', shade: '#63564A', bg: '#211D18', eye: '#FFFFFF', accent: 'glasses' },
  Divine: { coat: '#FFF3C4', shade: '#E0D08F', bg: '#33300F', eye: '#7BD8F2', accent: 'halo' },
  Real: { coat: '#4A3B30', shade: '#2A211A', bg: '#0D0B09', eye: '#C9A227', accent: 'lens' },
  Ultimate: { coat: '#7BE0F2', shade: '#42A6BC', bg: '#0E2830', eye: '#FFFFFF', accent: 'gem' },
  eGirl: { coat: '#FF8FD6', shade: '#D45BA8', bg: '#2E1226', eye: '#7BF2E0', accent: 'hearts' },
};

/** Decorations layered on top of the cat body. */
function accentSvg(kind, c) {
  switch (kind) {
    case 'sparkle': return `
      <g fill="#FFF6B0" opacity="0.95">
        <path d="M18 20 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2 z"/>
        <path d="M82 66 l1.5 4 4 1.5 -4 1.5 -1.5 4 -1.5 -4 -4 -1.5 4 -1.5 z"/>
      </g>`;
    case 'stripes': return `
      <g stroke="${c.shade}" stroke-width="3" stroke-linecap="round" opacity="0.85">
        <path d="M40 44 h20"/><path d="M38 52 h24"/><path d="M40 60 h20"/>
      </g>`;
    case 'horns': return `
      <g fill="#E05C5C">
        <path d="M30 26 l-6 -14 12 8 z"/><path d="M70 26 l6 -14 -12 8 z"/>
      </g>`;
    case 'visor': return `<rect x="30" y="40" width="40" height="14" rx="7" fill="#9FE7FF" opacity="0.9"/>`;
    case 'cape': return `<path d="M26 46 q24 30 48 0 l-6 34 q-18 10 -36 0 z" fill="#C0392B" opacity="0.85"/>`;
    case 'note': return `
      <g fill="#FFF6B0">
        <circle cx="76" cy="30" r="5"/><rect x="79" y="12" width="3" height="20"/>
        <path d="M82 12 l10 4 v5 l-10 -4 z"/>
      </g>`;
    case 'flip': return `
      <path d="M24 74 a26 26 0 0 0 52 0" fill="none" stroke="#FFF6B0" stroke-width="3"/>
      <path d="M76 74 l-6 -5 m6 5 l-6 5" stroke="#FFF6B0" stroke-width="3" fill="none"/>`;
    case 'crown': return `
      <path d="M32 24 l6 12 h24 l6 -12 -10 6 -8 -11 -8 11 z" fill="#FFD84D" stroke="#B8912A" stroke-width="1.5"/>`;
    case 'fly': return `
      <g fill="#3E3630"><circle cx="80" cy="26" r="3"/><circle cx="88" cy="32" r="2"/></g>`;
    case 'star': return `
      <path d="M50 8 l4 10 11 1 -8 7 2 11 -9 -6 -9 6 2 -11 -8 -7 11 -1 z" fill="#FFD84D"/>`;
    case 'orb': return `
      <circle cx="50" cy="16" r="8" fill="#7BF2E0" opacity="0.5"/>
      <circle cx="50" cy="16" r="4" fill="#FFFFFF" opacity="0.9"/>`;
    case 'pixel': return `
      <g fill="#FFFFFF" opacity="0.75">
        <rect x="24" y="24" width="6" height="6"/><rect x="70" y="24" width="6" height="6"/>
        <rect x="24" y="70" width="6" height="6"/><rect x="70" y="70" width="6" height="6"/>
      </g>`;
    case 'glitch': return `
      <g opacity="0.85">
        <rect x="20" y="46" width="60" height="4" fill="#FF3B3B"/>
        <rect x="26" y="58" width="48" height="3" fill="#3BFFEA"/>
      </g>`;
    case 'glasses': return `
      <g fill="none" stroke="#2B2B2B" stroke-width="3">
        <circle cx="38" cy="47" r="9"/><circle cx="62" cy="47" r="9"/><path d="M47 47 h6"/>
      </g>`;
    case 'halo': return `
      <ellipse cx="50" cy="14" rx="18" ry="5" fill="none" stroke="#FFE97F" stroke-width="4"/>`;
    case 'lens': return `
      <g><circle cx="50" cy="50" r="16" fill="none" stroke="#2B2B2B" stroke-width="4"/>
      <circle cx="50" cy="50" r="7" fill="#4A5A66"/></g>`;
    case 'gem': return `
      <path d="M50 8 l12 10 -12 14 -12 -14 z" fill="#B9F6FF" stroke="#5FD3E8" stroke-width="1.5"/>`;
    case 'hearts': return `
      <g fill="#FF5C9E">
        <path d="M74 22 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 q0 8 -10 14 q-10 -6 -10 -14 z" transform="scale(0.7) translate(30,6)"/>
      </g>`;
    default: return '';
  }
}

/** A cat: head, ears, muzzle, eyes, whiskers — all original geometry. */
function catSvg(type) {
  const c = LOOKS[type];
  if (!c) throw new Error(`No look defined for cat type "${type}"`);
  const pixelated = type === '8bit';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${SIZE}" height="${SIZE}"
    shape-rendering="${pixelated ? 'crispEdges' : 'auto'}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="65%">
      <stop offset="0%" stop-color="${c.bg}" stop-opacity="1"/>
      <stop offset="100%" stop-color="${c.bg}" stop-opacity="0.35"/>
    </radialGradient>
  </defs>

  <circle cx="50" cy="50" r="48" fill="url(#bg)"/>

  <!-- ears -->
  <path d="M22 40 L28 14 L46 30 Z" fill="${c.coat}"/>
  <path d="M78 40 L72 14 L54 30 Z" fill="${c.coat}"/>
  <path d="M27 36 L30 21 L40 31 Z" fill="${c.shade}" opacity="0.75"/>
  <path d="M73 36 L70 21 L60 31 Z" fill="${c.shade}" opacity="0.75"/>

  <!-- head -->
  <ellipse cx="50" cy="52" rx="30" ry="27" fill="${c.coat}"/>
  <ellipse cx="50" cy="60" rx="30" ry="19" fill="${c.shade}" opacity="0.28"/>

  <!-- eyes -->
  <ellipse cx="38" cy="48" rx="5.5" ry="7" fill="${c.eye}"/>
  <ellipse cx="62" cy="48" rx="5.5" ry="7" fill="${c.eye}"/>
  <ellipse cx="38" cy="48" rx="2" ry="5.5" fill="#161616"/>
  <ellipse cx="62" cy="48" rx="2" ry="5.5" fill="#161616"/>

  <!-- muzzle -->
  <path d="M50 60 l-4 -4 h8 z" fill="#F2A0B5"/>
  <path d="M50 60 v4 M50 64 q-5 4 -9 0 M50 64 q5 4 9 0" stroke="${c.shade}" stroke-width="1.6" fill="none" stroke-linecap="round"/>

  <!-- whiskers -->
  <g stroke="${c.shade}" stroke-width="1.4" stroke-linecap="round" opacity="0.8">
    <path d="M22 56 h12"/><path d="M22 62 h12"/>
    <path d="M78 56 h-12"/><path d="M78 62 h-12"/>
  </g>

  ${accentSvg(c.accent, c)}
</svg>`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const missing = CAT_TYPES.filter(t => !LOOKS[t]);
  if (missing.length) throw new Error(`Missing looks for: ${missing.join(', ')}`);
  const extra = Object.keys(LOOKS).filter(t => !CAT_TYPES.includes(t));
  if (extra.length) throw new Error(`Looks defined for unknown types: ${extra.join(', ')}`);

  let total = 0;
  for (const type of CAT_TYPES) {
    const svg = catSvg(type);
    const file = join(OUT_DIR, `${type.toLowerCase()}.png`);
    const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
    await writeFile(file, png);
    total += png.length;
    console.log(`  ${type.padEnd(10)} ${String(png.length).padStart(6)} bytes  ${file}`);
  }
  console.log(`\n${CAT_TYPES.length} sprites, ${(total / 1024).toFixed(1)} KiB total → ${OUT_DIR}`);
  console.log('Next: node scripts/catbot-upload-emoji.mjs   (uploads them as application emoji)');
}

main().catch(err => { console.error(err); process.exit(1); });
