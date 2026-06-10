/**
 * Renders a WordSeek grid to a PNG buffer with large, high-contrast letters.
 * Discord code blocks have a fixed (small) font that can't be enlarged and plain
 * text wraps on mobile — an image is the only way to get big, readable, aligned
 * letters everywhere. Static per grid (letters don't change during a round).
 */
import { createCanvas } from 'canvas';

export function renderGridImage(state) {
  const n = state.size;
  const cell = 52;          // px per cell — big and legible
  const pad = 22;
  const W = n * cell + pad * 2;
  const H = n * cell + pad * 2;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // background
  ctx.fillStyle = '#1e1f22';
  ctx.fillRect(0, 0, W, H);

  // faint grid lines
  ctx.strokeStyle = '#34363c';
  ctx.lineWidth = 1;
  for (let i = 0; i <= n; i++) {
    const p = pad + i * cell;
    ctx.beginPath(); ctx.moveTo(pad, p); ctx.lineTo(W - pad, p); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p, pad); ctx.lineTo(p, H - pad); ctx.stroke();
  }

  // letters
  ctx.font = `bold ${Math.floor(cell * 0.62)}px "DejaVu Sans", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = pad + c * cell + cell / 2;
      const y = pad + r * cell + cell / 2 + 2;
      ctx.fillText(String(state.grid[r][c] || '').toUpperCase(), x, y);
    }
  }
  return canvas.toBuffer('image/png');
}
