/*
 * Renders the 𝚃𝚎𝚊𝚖 𝙰𝚞𝚛𝚊 welcome-card background (1100x400, red cosmic nebula, team logos on
 * the flanks, a glow ring where the dark card centres the avatar) into dashboard/public/uploads/,
 * which the site serves at https://certifriedmultitool.com/uploads/<file>.
 *   node scripts/render-teamaura-welcome-bg.mjs <out-file-name>
 */
import { createCanvas, loadImage } from 'canvas';
import { writeFileSync } from 'node:fs';

const W = 1100, H = 400;
const OUT = new URL(`../dashboard/public/uploads/${process.argv[2]}`, import.meta.url);
const logo = await loadImage(new URL('../archives/teamaura-server-info-985116833193553933/aura-logo.png', import.meta.url).pathname);
let seed = 0xA17A;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const c = createCanvas(W, H); const g = c.getContext('2d');
const base = g.createLinearGradient(0, 0, W, H);
base.addColorStop(0, '#0a0309'); base.addColorStop(0.5, '#160510'); base.addColorStop(1, '#08020a');
g.fillStyle = base; g.fillRect(0, 0, W, H);
for (const [rgb, a, n] of [['179,18,46', 0.6, 6], ['120,10,30', 0.6, 5], ['210,50,80', 0.35, 4], ['80,20,110', 0.4, 4]]) for (let i = 0; i < n; i++) {
  const x = rand() * W, y = rand() * H, r = 100 + rand() * 260;
  const rg = g.createRadialGradient(x, y, 0, x, y, r);
  rg.addColorStop(0, `rgba(${rgb},${a * 0.55})`); rg.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = rg; g.fillRect(0, 0, W, H);
}
for (let i = 0; i < 380; i++) {
  const x = rand() * W, y = rand() * H, r = rand() < 0.94 ? rand() * 1.1 + 0.2 : rand() * 1.8 + 1.2;
  g.fillStyle = `rgba(255,${230 + rand() * 25 | 0},${230 + rand() * 25 | 0},${0.35 + rand() * 0.65})`;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  if (r > 1.6) { g.strokeStyle = 'rgba(255,230,235,0.5)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x - r * 5, y); g.lineTo(x + r * 5, y); g.moveTo(x, y - r * 5); g.lineTo(x, y + r * 5); g.stroke(); }
}
// aura glow behind the avatar (dark card: centred, centre y = 40 + 90 + 10 = 140, radius 90)
const halo = g.createRadialGradient(W / 2, 140, 80, W / 2, 140, 190);
halo.addColorStop(0, 'rgba(255,60,90,0.55)'); halo.addColorStop(0.35, 'rgba(179,18,46,0.35)'); halo.addColorStop(1, 'rgba(179,18,46,0)');
g.fillStyle = halo; g.fillRect(0, 0, W, H);
// logos on both flanks, clear of the centred avatar + text column
const lh = 230, lw = lh * logo.width / logo.height;
for (const x of [40, W - 40 - lw]) { g.save(); g.shadowColor = 'rgba(179,18,46,0.9)'; g.shadowBlur = 40; g.globalAlpha = 0.95; g.drawImage(logo, x, (H - lh) / 2, lw, lh); g.restore(); }
const v = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.7);
v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.55)');
g.fillStyle = v; g.fillRect(0, 0, W, H);
writeFileSync(OUT, c.toBuffer('image/png'));
console.log('wrote', OUT.pathname);
