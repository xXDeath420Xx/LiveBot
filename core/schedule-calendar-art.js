/*
 * Month poster: a peach Sun–Sat calendar with the owner's art down the left, drawn from the
 * November 2026 poster MamaBear_XaL makes by hand. Cell, border and page colours were sampled from
 * it. Every string is fitted to its cell, because owners write what they like there.
 */
import logger from '../utils/logger.js';

let Canvas = null;
try { Canvas = await import('canvas'); } catch { /* renderer disabled without it */ }

const W = 1920, H = 1080;
const PAGE = '#F5F3EF', WEEKDAY = '#F1D7C5', WEEKEND = '#EAB093', BORDER = '#E2C494';
const OLIVE = '#5C6641', MAROON = '#6C2C2A', INK = '#2A2622', RED = '#C0141C';
const SANS_BLACK = '"CF Sans Black"', SANS_BOLD = '"CF Sans Bold"', SANS_ITALIC = '"CF Sans Italic"', SERIF = '"CF Serif"';
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const GAP = 19, SIDE_W = 216, RIGHT = 49, TOP = 138, DOW_H = 60, BOTTOM = 1058;

function spaced(ctx, text, cx, y, spacing) {
    const widths = [...text].map((c) => ctx.measureText(c).width);
    let x = cx - (widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1)) / 2;
    ctx.textAlign = 'left';
    [...text].forEach((c, i) => { ctx.fillText(c, x, y); x += widths[i] + spacing; });
}

/** Word-wrap with a narrower first line, which clears the date in the cell's corner. */
function wrap(ctx, text, firstW, restW) {
    const lines = [];
    let line = '';
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
        const trial = line ? `${line} ${word}` : word;
        if (!line || ctx.measureText(trial).width <= (lines.length ? restW : firstW)) line = trial;
        else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    return lines;
}

/** Largest size at which every block fits the cell. Each block's size is a share of the title's. */
function fitBlocks(ctx, blocks, w, h, firstW, maxSize) {
    for (let size = maxSize; size >= 11; size -= 1) {
        let total = 0, fits = true;
        const laid = blocks.map((b, bi) => {
            const px = Math.max(10, Math.round(size * b.scale));
            ctx.font = `normal ${px}px ${b.face}`;
            const lines = wrap(ctx, b.text, bi === 0 ? firstW : w, w);
            lines.forEach((l, li) => {
                if (ctx.measureText(l).width > (bi === 0 && li === 0 ? firstW : w)) fits = false;
            });
            total += lines.length * px * 1.04;
            return { ...b, px, lines };
        });
        if (fits && total <= h) return { laid, total };
    }
    return null;
}

function drawCell(ctx, x, y, w, h, day, weekend) {
    ctx.fillStyle = weekend ? WEEKEND : WEEKDAY;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 4;
    ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.font = 'normal 31px Oswald';
    ctx.fillStyle = INK;
    const label = String(day.date);
    ctx.fillText(label, x + 13, y + 40);
    const dateW = ctx.measureText(label).width;

    const off = day.kind === 'off';
    const blocks = [{ text: day.title, face: off ? SANS_BLACK : SERIF, scale: 1, color: day.color, color2: day.color2 }];
    if (day.time) blocks.push({ text: day.time, face: SERIF, scale: 1, color: day.color, color2: day.color2 });
    if (day.note) blocks.push({ text: day.note, face: SERIF, scale: 0.74, color: day.noteColor || day.color });

    const innerW = w - 18, innerH = h - 14;
    const firstW = innerW - 2 * (dateW + 12);
    /* Text beside the date normally reads best, but one long word ("Friendsgiving") can't fit
       there and would shrink the whole cell. Starting under the date is then the larger option. */
    const maxSize = off ? 44 : 34;
    const beside = fitBlocks(ctx, blocks, innerW, innerH, firstW, maxSize);
    const below = fitBlocks(ctx, blocks, innerW, innerH - 42, innerW, maxSize);
    const useBelow = below && (!beside || below.laid[0].px > beside.laid[0].px);
    const fit = useBelow ? below : beside;
    if (!fit) return;
    let ty = useBelow ? y + 42 + (h - 42 - fit.total) / 2 : y + (h - fit.total) / 2;
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    for (const block of fit.laid) {
        ctx.font = `normal ${block.px}px ${block.face}`;
        for (const line of block.lines) {
            const base = ty + block.px * 0.86;
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(255,250,242,.7)';
            ctx.strokeText(line, x + w / 2, base);
            if (block.color2) {
                const g = ctx.createLinearGradient(x, y, x + w, y);
                g.addColorStop(0, block.color);
                g.addColorStop(1, block.color2);
                ctx.fillStyle = g;
            } else {
                ctx.fillStyle = block.color || RED;
            }
            ctx.fillText(line, x + w / 2, base);
            ty += block.px * 1.04;
        }
    }
}

/** Disclaimer text. [[double brackets]] mark a run drawn red and underlined. */
function drawDisclaimer(ctx, text, x, y, w, h) {
    ctx.fillStyle = WEEKEND;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 4;
    ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);

    const words = [];
    String(text).split(/(\[\[.*?\]\])/).forEach((part) => {
        const red = part.startsWith('[[');
        part.replace(/\[\[|\]\]/g, '').split(/\s+/).filter(Boolean).forEach((word) => words.push({ word, red }));
    });
    const innerW = w - 24, innerH = h - 16;
    for (let size = 30; size >= 11; size -= 1) {
        ctx.font = `normal ${size}px ${SANS_ITALIC}`;
        const space = ctx.measureText(' ').width;
        const lines = [[]];
        let lineW = 0;
        for (const item of words) {
            const wordW = ctx.measureText(item.word).width;
            if (lineW && lineW + space + wordW > innerW) { lines.push([]); lineW = 0; }
            lines[lines.length - 1].push({ ...item, wordW });
            lineW += (lineW ? space : 0) + wordW;
        }
        const lineH = size * 1.32;
        if (lines.length * lineH > innerH) continue;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        let ty = y + (h - lines.length * lineH) / 2 + size;
        for (const line of lines) {
            let tx = x + 12;
            line.forEach((item, i) => {
                ctx.fillStyle = item.red ? RED : OLIVE;
                ctx.fillText(item.word, tx, ty);
                const gapW = i < line.length - 1 ? space : 0;
                // The space belongs to the underline only between two red words.
                if (item.red) ctx.fillRect(tx, ty + 3, item.wordW + (line[i + 1]?.red ? gapW : 0), 2);
                tx += item.wordW + gapW;
            });
            ty += lineH;
        }
        return;
    }
}

function offsetText(ctx, text, x, y, fill, shadow) {
    ctx.fillStyle = shadow;
    ctx.fillText(text, x + 3, y + 3);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
}

/**
 * opts: { monthName, year, firstWeekday (0 = Sunday), days (from buildMonth), title, disclaimer, sideArt }
 * `sideArt` is a Buffer. Without one the grid takes the whole width.
 */
export async function drawCalendar(opts) {
    if (!Canvas) return null;
    const canvas = Canvas.createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = PAGE;
    ctx.fillRect(0, 0, W, H);

    let left = 49;
    if (opts.sideArt) {
        try {
            const art = await Canvas.loadImage(opts.sideArt);
            const scale = Math.min(SIDE_W / art.width, H / art.height);
            const dw = art.width * scale, dh = art.height * scale;
            ctx.drawImage(art, (SIDE_W - dw) / 2, (H - dh) / 2, dw, dh);
            left = SIDE_W + 19;
        } catch (e) {
            logger.warn(`[ScheduleCalendar] side art unusable: ${e.message}`, { category: 'twitch' });
        }
    }
    const gridW = W - left - RIGHT;
    const colW = (gridW - GAP * 6) / 7;

    // Heading, on one line and fitted to the grid.
    const month = String(opts.monthName).toUpperCase();
    const year = String(opts.year);
    const title = String(opts.title || 'Stream Schedule').toUpperCase();
    let size = 84;
    for (; size > 40; size -= 2) {
        ctx.font = `normal ${size}px ${SANS_BLACK}`;
        if (ctx.measureText(`${month} ${year}`).width + size * 1.2 + ctx.measureText(title).width <= gridW) break;
    }
    ctx.font = `normal ${size}px ${SANS_BLACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    let hx = left;
    const hy = 100;
    offsetText(ctx, month, hx, hy, OLIVE, MAROON);
    hx += ctx.measureText(`${month} `).width;
    offsetText(ctx, year, hx, hy, MAROON, OLIVE);
    hx += ctx.measureText(year).width + size * 1.2;
    offsetText(ctx, title, hx, hy, OLIVE, INK);

    // Day-of-week bar.
    DOW.forEach((name, i) => {
        const x = left + i * (colW + GAP);
        ctx.fillStyle = i === 0 || i === 6 ? WEEKEND : WEEKDAY;
        ctx.fillRect(x, TOP, colW, DOW_H);
        ctx.strokeStyle = BORDER;
        ctx.lineWidth = 4;
        ctx.strokeRect(x + 2, TOP + 2, colW - 4, DOW_H - 4);
        ctx.font = `normal 33px ${SANS_BOLD}`;
        ctx.fillStyle = INK;
        ctx.textBaseline = 'middle';
        spaced(ctx, name, x + colW / 2, TOP + DOW_H / 2 + 2, 16);
    });
    ctx.textBaseline = 'alphabetic';

    // Weeks. The disclaimer sits in the empty cells after the last day, as on the poster; a month
    // that leaves too few of them gets a band across the bottom instead.
    const weeks = Math.ceil((opts.firstWeekday + opts.days.length) / 7);
    const trailing = weeks * 7 - opts.firstWeekday - opts.days.length;
    const inline = trailing >= 3;
    const band = opts.disclaimer && !inline ? 92 : 0;
    const gridTop = TOP + DOW_H + 20;
    const room = BOTTOM - gridTop - (band ? band + 20 : 0);
    const rowH = (room - 20 * (weeks - 1)) / weeks;

    opts.days.forEach((day, i) => {
        const slot = opts.firstWeekday + i;
        const col = slot % 7;
        const x = left + col * (colW + GAP);
        const y = gridTop + Math.floor(slot / 7) * (rowH + 20);
        drawCell(ctx, x, y, colW, rowH, day, col === 0 || col === 6);
    });

    if (opts.disclaimer) {
        if (inline) {
            const col = 7 - trailing;
            drawDisclaimer(ctx, opts.disclaimer, left + col * (colW + GAP), gridTop + (weeks - 1) * (rowH + 20),
                trailing * colW + (trailing - 1) * GAP, rowH);
        } else {
            drawDisclaimer(ctx, opts.disclaimer, left, BOTTOM - band, gridW, band);
        }
    }
    return canvas.toBuffer('image/png');
}
