/*
 * Renders the 𝚃𝚎𝚊𝚖 𝙰𝚞𝚛𝚊 #server-info section banners (red cosmic nebula + team logo + chrome
 * title) into archives/teamaura-server-info-985116833193553933/banner-<key>.png.
 *   node scripts/render-teamaura-banners.mjs
 */
import { createCanvas, loadImage } from 'canvas';
import { writeFileSync } from 'node:fs';

const DIR = new URL('../archives/teamaura-server-info-985116833193553933/', import.meta.url);
const W = 1000, H = 300;
const BANNERS = { welcome: 'WELCOME', links: 'LINKS', rules: 'RULES', mods: 'MODS', invite: 'INVITE LINK' };
const logo = await loadImage(new URL('aura-logo.png', DIR).pathname);

function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

for (const [key, text] of Object.entries(BANNERS)) {
  const c = createCanvas(W, H); const g = c.getContext('2d');
  const rand = rng(0xA0A + key.length * 97 + key.charCodeAt(0));
  // deep space base
  const base = g.createLinearGradient(0, 0, W, H);
  base.addColorStop(0, '#07030a'); base.addColorStop(0.5, '#12040b'); base.addColorStop(1, '#060208');
  g.fillStyle = base; g.fillRect(0, 0, W, H);
  // nebula clouds: aura red, crimson, a touch of violet
  const clouds = [['179,18,46', 0.55], ['120,10,30', 0.6], ['200,40,70', 0.35], ['70,20,90', 0.35], ['179,18,46', 0.4]];
  for (const [rgb, a] of clouds) for (let i = 0; i < 4; i++) {
    const x = rand() * W, y = rand() * H, r = 80 + rand() * 220;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `rgba(${rgb},${a * 0.6})`); rg.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
  }
  // stars
  for (let i = 0; i < 260; i++) {
    const x = rand() * W, y = rand() * H, r = rand() < 0.93 ? rand() * 1.1 + 0.2 : rand() * 1.8 + 1.2;
    g.fillStyle = `rgba(255,${225 + rand() * 30 | 0},${225 + rand() * 30 | 0},${0.35 + rand() * 0.65})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    if (r > 1.6) { // sparkle cross on the bright ones
      g.strokeStyle = 'rgba(255,230,235,0.55)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x - r * 5, y); g.lineTo(x + r * 5, y); g.moveTo(x, y - r * 5); g.lineTo(x, y + r * 5); g.stroke();
    }
  }
  // vignette
  const v = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.65);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.65)');
  g.fillStyle = v; g.fillRect(0, 0, W, H);
  // logo, left, with a red halo
  const lh = 250, lw = lh * logo.width / logo.height, lx = 30, ly = (H - lh) / 2;
  g.save(); g.shadowColor = 'rgba(179,18,46,0.9)'; g.shadowBlur = 40; g.drawImage(logo, lx, ly, lw, lh); g.restore();
  // title: chrome fill, dark outline, red glow
  const tx = lx + lw + 40, maxW = W - tx - 40;
  let size = 150; g.font = `${size}px Anton`;
  while (g.measureText(text).width > maxW) { size -= 4; g.font = `${size}px Anton`; }
  const m = g.measureText(text); const ty = H / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  const x0 = tx + (maxW - m.width) / 2;
  g.save(); g.shadowColor = 'rgba(179,18,46,1)'; g.shadowBlur = 35; g.fillStyle = '#b3122e'; g.fillText(text, x0 + 4, ty + 5); g.restore();
  g.lineJoin = 'round'; g.lineWidth = 10; g.strokeStyle = '#1a0308'; g.strokeText(text, x0, ty);
  const top = ty - m.actualBoundingBoxAscent, chrome = g.createLinearGradient(0, top, 0, ty);
  chrome.addColorStop(0, '#ffffff'); chrome.addColorStop(0.45, '#d9d9df'); chrome.addColorStop(0.5, '#8a8a94');
  chrome.addColorStop(0.62, '#c9c9d1'); chrome.addColorStop(1, '#f4f4f8');
  g.fillStyle = chrome; g.fillText(text, x0, ty);
  writeFileSync(new URL(`banner-${key}.png`, DIR), c.toBuffer('image/png'));
  console.log('rendered', key, size + 'px');
}
