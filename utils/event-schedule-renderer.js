// Gantt-style weekly event schedule renderer.
//
// Draws a 7-column day strip with category sections, each section's events
// rendered as horizontal rounded bars spanning the days they're active.
// Styled to mirror the reference "Event Calendar" mobile-game screenshot.
//
// Canvas is optional. If `canvas` (node-canvas) is not installed we return null
// so callers can gracefully fall back to a text embed.
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let Canvas = null;
try { Canvas = await import('canvas'); } catch { /* silent; image gen disabled */ }

// Register a bundled monochrome emoji font so emoji render as clean glyphs
// (colored via ctx.fillStyle) instead of "tofu" codepoint boxes. Cairo handles
// monochrome (outline) emoji fonts reliably; do this once at module load.
const EMOJI_FONT_FAMILY = 'NotoEmoji';
if (Canvas) {
  try {
    Canvas.registerFont(
      path.join(__dirname, '../assets/fonts/NotoEmoji-Regular.ttf'),
      { family: EMOJI_FONT_FAMILY },
    );
  } catch { /* font registration optional; falls back to tofu */ }
}

// Draw an emoji glyph with the registered monochrome emoji font, then restore
// the previous font. Returns the advance width consumed (glyph width).
// `ctx.fillStyle` is left untouched so the monochrome glyph takes the
// caller's intended color.
function drawEmoji(ctx, emoji, x, y, size) {
  const prevFont = ctx.font;
  ctx.font = `${size}px ${EMOJI_FONT_FAMILY}`;
  ctx.fillText(emoji, x, y);
  const w = ctx.measureText(emoji).width;
  ctx.font = prevFont;
  return w;
}

// ─── Layout constants ───────────────────────────────────────────────────────
const WIDTH = 1080;
const PAD = 0;                    // strip is full-width
const HEADER_H = 200;
const STRIP_H = 90;               // Sun..Sat day header strip
const SECTION_LABEL_H = 44;       // category label bar
const ITEM_ROW_H = 76;            // one event bar row
const ITEM_BAR_H = 56;            // the rounded bar itself (centered in row)
const FOOTER_H = 70;
const SECTION_GAP = 6;            // small gap below each section

const COL_W = WIDTH / 7;

// ─── Small drawing helpers ──────────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return { r: 128, g: 128, b: 128 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function rgba(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function lighten(hex, amt) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => Math.round(c + (255 - c) * amt);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

function darken(hex, amt) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => Math.round(c * (1 - amt));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

// Choose black/white text for contrast against a fill color.
function readableText(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#1B2A33' : '#FFFFFF';
}

function truncate(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ell = '…';
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + ell).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ell;
}

/**
 * Render a weekly Gantt-style event schedule.
 * @param {object} model see file header / task contract for shape.
 * @returns {Promise<Buffer|null>} PNG buffer, or null if canvas is unavailable.
 */
export default async function renderEventSchedule(model) {
  if (!Canvas) return null;

  const {
    title = 'Event Calendar',
    timestampLabel = '',
    weekDays = [],
    sections = [],
    footer = '',
  } = model || {};

  // ─── Compute dynamic height ───────────────────────────────────────────────
  let bodyH = 0;
  for (const sec of sections) {
    const rows = Math.max(1, (sec.items || []).length);
    bodyH += SECTION_LABEL_H + rows * ITEM_ROW_H + SECTION_GAP;
  }
  const height = HEADER_H + STRIP_H + bodyH + FOOTER_H;

  const canvas = Canvas.createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');

  // ─── Page background ──────────────────────────────────────────────────────
  ctx.fillStyle = '#BFE3EC';
  ctx.fillRect(0, 0, WIDTH, height);

  // ─── Header band (vertical blue/teal gradient) ────────────────────────────
  const hg = ctx.createLinearGradient(0, 0, 0, HEADER_H);
  hg.addColorStop(0, '#1E5C82');
  hg.addColorStop(0.55, '#2E8FB5');
  hg.addColorStop(1, '#46C6DE');
  ctx.fillStyle = hg;
  ctx.fillRect(0, 0, WIDTH, HEADER_H);

  // Title
  ctx.textAlign = 'left';
  ctx.fillStyle = '#FFE38A';
  ctx.font = 'bold 60px Arial';
  // soft shadow for the title
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 3;
  ctx.fillText(title, 36, 98);
  ctx.restore();

  // Timestamp w/ clock glyph
  ctx.fillStyle = '#EAF7FB';
  ctx.font = '30px Arial';
  // clock glyph (drawn so we don't rely on emoji fonts)
  const clkX = 52, clkY = 150, clkR = 16;
  ctx.strokeStyle = '#EAF7FB';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(clkX, clkY, clkR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(clkX, clkY);
  ctx.lineTo(clkX, clkY - 9);
  ctx.moveTo(clkX, clkY);
  ctx.lineTo(clkX + 8, clkY + 3);
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.fillText(timestampLabel, clkX + clkR + 12, clkY + 11);

  // Calendar glyph (top-right)
  drawCalendarGlyph(ctx, WIDTH - 190, 56, 150, 110);

  // ─── Day strip (Sun..Sat) ─────────────────────────────────────────────────
  const stripY = HEADER_H;
  ctx.fillStyle = '#2C6E8C';
  ctx.fillRect(0, stripY, WIDTH, STRIP_H);

  const todayCol = weekDays.findIndex(d => d && d.isToday);

  for (let i = 0; i < 7; i++) {
    const d = weekDays[i] || { label: '', date: '' };
    const x = i * COL_W;
    const isToday = !!d.isToday;

    if (isToday) {
      // highlighted column header tab
      ctx.fillStyle = '#FFF4DA';
      roundRect(ctx, x + 6, stripY + 8, COL_W - 12, STRIP_H - 12, 12);
      ctx.fill();
      ctx.strokeStyle = '#E0B463';
      ctx.lineWidth = 3;
      roundRect(ctx, x + 6, stripY + 8, COL_W - 12, STRIP_H - 12, 12);
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, stripY + 14);
      ctx.lineTo(x, stripY + STRIP_H - 14);
      ctx.stroke();
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = isToday ? '#C77F1A' : '#DFF3F9';
    ctx.font = 'bold 26px Arial';
    ctx.fillText(d.label || '', x + COL_W / 2, stripY + 38);
    ctx.font = 'bold 28px Arial';
    ctx.fillStyle = isToday ? '#9A5A00' : '#FFFFFF';
    ctx.fillText(d.date || '', x + COL_W / 2, stripY + 72);
  }

  // Faint vertical band through the body for today's column.
  const bodyTop = stripY + STRIP_H;
  const bodyBottom = height - FOOTER_H;
  if (todayCol >= 0) {
    ctx.fillStyle = 'rgba(255,231,150,0.28)';
    ctx.fillRect(todayCol * COL_W, bodyTop, COL_W, bodyBottom - bodyTop);
  }

  // Faint column grid lines across the body.
  ctx.strokeStyle = 'rgba(70,120,140,0.18)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 7; i++) {
    ctx.beginPath();
    ctx.moveTo(i * COL_W, bodyTop);
    ctx.lineTo(i * COL_W, bodyBottom);
    ctx.stroke();
  }

  // ─── Sections ─────────────────────────────────────────────────────────────
  let y = bodyTop;
  for (const sec of sections) {
    const color = sec.color || '#3498DB';
    const items = sec.items || [];

    // Section label bar
    ctx.fillStyle = rgba(color, 0.22);
    ctx.fillRect(0, y, WIDTH, SECTION_LABEL_H);
    // accent tab on the left
    ctx.fillStyle = color;
    ctx.fillRect(0, y, 8, SECTION_LABEL_H);

    ctx.textAlign = 'left';
    ctx.fillStyle = darken(color, 0.45);
    const labelBaseline = y + SECTION_LABEL_H / 2 + 9;
    let labelX = 22;
    if (sec.emoji) {
      const ew = drawEmoji(ctx, sec.emoji, labelX, labelBaseline, 26);
      labelX += ew + 8;
    }
    ctx.font = 'bold 26px Arial';
    ctx.fillText(sec.name || '', labelX, labelBaseline);

    y += SECTION_LABEL_H;

    // Item rows
    for (const item of items) {
      const startCol = Math.max(0, Math.min(6, item.startCol | 0));
      const span = Math.max(1, Math.min(7 - startCol, (item.span | 0) || 1));
      const barX = startCol * COL_W + 6;
      const barW = span * COL_W - 12;
      const barY = y + (ITEM_ROW_H - ITEM_BAR_H) / 2;

      // Bar gradient (vertical, lighter top → base color bottom) + border.
      const bg = ctx.createLinearGradient(0, barY, 0, barY + ITEM_BAR_H);
      bg.addColorStop(0, lighten(color, 0.28));
      bg.addColorStop(1, color);
      ctx.fillStyle = bg;
      roundRect(ctx, barX, barY, barW, ITEM_BAR_H, 14);
      ctx.fill();
      ctx.strokeStyle = darken(color, 0.25);
      ctx.lineWidth = 2;
      roundRect(ctx, barX, barY, barW, ITEM_BAR_H, 14);
      ctx.stroke();

      // "today" start marker dot near the bar's left edge (mirrors reference).
      if (todayCol >= 0 && startCol === todayCol) {
        ctx.fillStyle = '#E74C3C';
        ctx.beginPath();
        ctx.arc(barX + 10, barY - 2, 7, 0, Math.PI * 2);
        ctx.fill();
      }

      // Emoji + title inside the bar.
      const txtColor = readableText(color);
      ctx.fillStyle = txtColor;
      ctx.textAlign = 'left';
      let tx = barX + 18;
      const emoji = item.emoji || '';
      if (emoji) {
        const ew = drawEmoji(ctx, emoji, tx, barY + ITEM_BAR_H / 2 + 11, 30);
        tx += ew + 12;
      }
      ctx.font = 'bold 26px Arial';
      const maxTextW = barX + barW - tx - 14;
      const title = truncate(ctx, item.title || '', Math.max(20, maxTextW));
      ctx.fillText(title, tx, barY + ITEM_BAR_H / 2 + 10);

      y += ITEM_ROW_H;
    }

    y += SECTION_GAP;
  }

  // ─── Footer ───────────────────────────────────────────────────────────────
  ctx.fillStyle = '#A9D6E2';
  ctx.fillRect(0, height - FOOTER_H, WIDTH, FOOTER_H);
  ctx.fillStyle = '#234653';
  ctx.font = 'bold 24px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(footer || '', WIDTH / 2, height - FOOTER_H / 2 + 8);

  return canvas.toBuffer('image/png');
}

// Draws a stylized calendar icon in the header's top-right.
function drawCalendarGlyph(ctx, x, y, w, h) {
  // body
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, '#6A8BE0');
  g.addColorStop(1, '#3A57B5');
  ctx.fillStyle = g;
  roundRect(ctx, x, y, w, h, 14);
  ctx.fill();
  ctx.strokeStyle = '#E8EEFF';
  ctx.lineWidth = 4;
  roundRect(ctx, x, y, w, h, 14);
  ctx.stroke();

  // top band
  ctx.fillStyle = '#27407F';
  roundRect(ctx, x, y, w, 30, 14);
  ctx.fill();

  // binder rings
  ctx.fillStyle = '#CBD6F5';
  ctx.beginPath(); ctx.arc(x + w * 0.3, y, 6, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + w * 0.7, y, 6, 0, Math.PI * 2); ctx.fill();

  // date squares grid
  ctx.fillStyle = '#DCE6FF';
  const cols = 3, rows = 2;
  const pad = 14, gap = 8;
  const cellW = (w - pad * 2 - gap * (cols - 1)) / cols;
  const cellH = (h - 30 - pad - gap * (rows - 1)) / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = x + pad + c * (cellW + gap);
      const cy = y + 30 + (pad - 6) + r * (cellH + gap);
      roundRect(ctx, cx, cy, cellW, cellH, 4);
      ctx.fill();
    }
  }
}
