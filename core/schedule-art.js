/*
 * Stream schedule artwork.
 *
 * The built-in month grid is correct and unloved — streamers make their own in
 * Canva because a plain calendar says nothing about them. Nine real examples from
 * this community fall into three shapes, and only one of them was a month grid:
 *
 *   overlay  a landscape card: big title, date range, one line per day, artwork
 *            filling the right-hand side. Five of the nine.
 *   rows     a portrait card: title, then a boxed row per day — DAY / time / game.
 *            Two of the nine, including MetalGurl2K's own.
 *   month    the Sun–Sat grid the bot already drew. Two of the nine.
 *
 * The background comes from one of three places — a drawn gradient, an image the
 * owner uploads, or one generated from a prompt — and that is the whole reason
 * this module exists separately from the renderer that made the month grid.
 *
 * The hard part is not drawing; it is staying READABLE on a background nobody
 * vetted. An uploaded image can be white clouds or a black void, and text picked
 * at authoring time will vanish on one of them. So every text zone is sampled
 * from the actual pixels behind it, the ink is chosen from that, and a scrim is
 * laid down only where the backdrop is too busy to read against. That check is
 * what makes "upload anything" a promise the feature can keep.
 */
import logger from '../utils/logger.js';

let Canvas = null;
try { Canvas = await import('canvas'); } catch { /* renderer disabled without it */ }

export const LAYOUTS = ['overlay', 'rows', 'month', 'exact', 'poster', 'calendar'];
export const BACKGROUNDS = ['default', 'style', 'upload', 'prompt', 'exact'];

/* Weekday and month names are produced in the guild's timezone by the caller;
   this module only ever formats what it is handed. */

// ── readability ────────────────────────────────────────────────────────────

/** Average luminance and variance of a rectangle of the canvas. */
function sampleRegion(ctx, x, y, w, h) {
    const px = ctx.getImageData(Math.max(0, x | 0), Math.max(0, y | 0),
        Math.max(1, w | 0), Math.max(1, h | 0)).data;
    let sum = 0, sumSq = 0, n = 0;
    // Every 16th pixel is plenty for a luminance average and keeps this cheap
    // on a 1650px canvas.
    for (let i = 0; i < px.length; i += 64) {
        const l = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
        sum += l; sumSq += l * l; n++;
    }
    const mean = n ? sum / n : 0.5;
    const variance = n ? Math.max(0, sumSq / n - mean * mean) : 0;
    return { mean, variance };
}

/**
 * Decide ink colour and whether this zone needs a scrim behind it.
 *
 * `variance` is the signal that matters: a flat dark backdrop takes white text
 * happily, but a busy one — character art, fire, confetti — will swallow it
 * whichever colour we pick, and that is when a scrim earns its place.
 */
export function inkFor(ctx, x, y, w, h) {
    const { mean, variance } = sampleRegion(ctx, x, y, w, h);
    const busy = variance > 0.045;
    const ink = mean < 0.5 ? '#FFFFFF' : '#14121A';
    const shadow = mean < 0.5 ? 'rgba(0,0,0,.75)' : 'rgba(255,255,255,.65)';
    return {
        ink,
        shadow,
        scrim: busy ? (mean < 0.5 ? 'rgba(8,6,14,.62)' : 'rgba(255,255,255,.68)') : null,
        mean,
        variance,
    };
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/** Draw text with a soft shadow so it survives a mid-tone backdrop. */
function inked(ctx, text, x, y, { ink, shadow }) {
    ctx.save();
    ctx.shadowColor = shadow;
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = ink;
    ctx.fillText(text, x, y);
    ctx.restore();
}

/** Shrink a string until it fits, rather than letting it run off the card. */
function fitText(ctx, text, maxWidth, font, minSize = 14) {
    const [style, sizeRaw, ...rest] = font.split(' ');
    let size = parseInt(sizeRaw, 10);
    const family = rest.join(' ');
    for (; size > minSize; size -= 2) {
        ctx.font = `${style} ${size}px ${family}`;
        if (ctx.measureText(text).width <= maxWidth) break;
    }
    return ctx.font;
}


/** Find the largest font size (within reason) at which `text` fits BOTH the
    given maxWidth and maxHeight. Binary-searches between minSize and the
    size-ceiling implied by maxHeight. This replaces the one-way shrink of
    fitText where the caller had to guess a cap — if the cap was too small
    for a short string the panel stayed empty. */
function autoFit(ctx, text, maxWidth, maxHeight, face, {
    minSize = 10, ceil = 160, heightFactor = 1.15,
} = {}) {
    if (!text) return face.replace(/\d+px/, `${minSize}px`);
    // Width upper bound: measure at a reference size and scale.
    const probeSize = 48;
    ctx.font = face.replace(/\d+px/, `${probeSize}px`);
    const w = ctx.measureText(text).width || 1;
    const byWidth = Math.floor(probeSize * (maxWidth / w));
    // Height upper bound: a px-size roughly equals font cap-height, and
    // typographic height ≈ size * heightFactor for most display fonts.
    const byHeight = Math.floor(maxHeight / heightFactor);
    const target = Math.max(minSize, Math.min(ceil, byWidth, byHeight));
    // Re-verify with a short binary search: synthetic math can overshoot by a
    // couple of px when the font has unusual metrics.
    let lo = minSize, hi = target, best = minSize;
    for (let i = 0; i < 7 && lo <= hi; i++) {
        const mid = Math.floor((lo + hi) / 2);
        ctx.font = face.replace(/\d+px/, `${mid}px`);
        if (ctx.measureText(text).width <= maxWidth && mid * heightFactor <= maxHeight) {
            best = mid; lo = mid + 1;
        } else { hi = mid - 1; }
    }
    return face.replace(/\d+px/, `${best}px`);
}


/** Break `text` into at most `maxLines` lines that each fit `maxWidth` at
    the current ctx.font. Falls back to a single truncated line if the
    whole thing can't be broken small enough. */
function wrapLines(ctx, text, maxWidth) {
    const words = String(text || '').trim().split(/\s+/);
    if (!words.length || !words[0]) return [''];
    const lines = [];
    let i = 0;
    while (i < words.length) {
        let line = '';
        let nextI = i;
        for (let j = i; j < words.length; j++) {
            const trial = line ? line + ' ' + words[j] : words[j];
            if (ctx.measureText(trial).width <= maxWidth) {
                line = trial;
                nextI = j + 1;
            } else {
                // Overlong single word — accept it, never loop forever.
                if (!line) { line = words[j]; nextI = j + 1; }
                break;
            }
        }
        lines.push(line);
        i = nextI;
    }
    return lines;
}

/** autoFit for multi-line text. Picks the largest size at which every wrapped
    line fits `maxWidth` AND total block height fits `maxHeight`. */
function autoFitWrapped(ctx, text, maxWidth, maxHeight, face, {
    minSize = 14, ceil = 120, lineGap = 1.1,
} = {}) {
    let lo = minSize, hi = ceil, best = minSize, bestLines = [String(text || '')];
    for (let i = 0; i < 9 && lo <= hi; i++) {
        const mid = Math.floor((lo + hi) / 2);
        ctx.font = face.replace(/\d+px/, mid + 'px');
        const lines = wrapLines(ctx, text, maxWidth);
        const totalH = mid * lineGap * lines.length;
        const widest = Math.max.apply(null, lines.map(l => ctx.measureText(l).width));
        if (widest <= maxWidth && totalH <= maxHeight) {
            best = mid; bestLines = lines; lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    ctx.font = face.replace(/\d+px/, best + 'px');
    bestLines = wrapLines(ctx, text, maxWidth);
    return { font: face.replace(/\d+px/, best + 'px'), size: best, lines: bestLines };
}

// ── backgrounds ────────────────────────────────────────────────────────────

/**
 * Paint the backdrop and return the canvas context.
 *
 * `cover` scales an image to fill without distorting it — a 1024×576 generation
 * stretched to a portrait card would look like a funhouse mirror.
 */
async function paintBackground(ctx, width, height, { mode, imageBuffer, accent, textZone }) {
    if (mode !== 'default' && imageBuffer) {
        try {
            /* The blur is done with sharp, not canvas.
             *
             * node-canvas accepts `ctx.filter = 'blur(14px)'` and reports it back,
             * but silently ignores it for drawImage — measured: edge energy 48
             * before and 48 after. Trusting it left generated lettering perfectly
             * crisp underneath the schedule. sharp actually blurs.
             *
             * Only the text region is softened. A generated background reliably
             * contains garbled words (the models cannot spell) and an uploaded one
             * may be somebody's finished poster with its own day names on it;
             * either competes with the schedule. The artwork stays sharp wherever
             * no text sits over it. */
            const { default: sharp } = await import('sharp');
            let base = await sharp(imageBuffer)
                .resize(width, height, { fit: 'cover', position: 'attention' })
                .toFormat('png').toBuffer();

            if (textZone) {
                const x = Math.max(0, Math.round(textZone.x));
                const y = Math.max(0, Math.round(textZone.y));
                const w = Math.min(width - x, Math.round(textZone.w));
                const h = Math.min(height - y, Math.round(textZone.h));
                if (w > 8 && h > 8) {
                    const softened = await sharp(base)
                        .extract({ left: x, top: y, width: w, height: h })
                        .blur(18)
                        .toBuffer();
                    base = await sharp(base)
                        .composite([{ input: softened, left: x, top: y }])
                        .toFormat('png').toBuffer();
                }
            }
            const img = await Canvas.loadImage(base);
            ctx.drawImage(img, 0, 0, width, height);
            return 'image';
        } catch (e) {
            logger.warn(`[ScheduleArt] background image unusable, falling back: ${e.message}`,
                { category: 'twitch' });
        }
    }
    // Drawn fallback. Also what 'default' uses.
    const a = accent || '#9B59D0';
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, '#140E22');
    grad.addColorStop(0.55, shade(a, -0.45));
    grad.addColorStop(1, '#0B0912');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    // A slow diagonal sheen stops a flat gradient reading as a placeholder.
    const sheen = ctx.createLinearGradient(0, height, width, 0);
    sheen.addColorStop(0, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.5, 'rgba(255,255,255,.05)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, width, height);
    return 'drawn';
}

function shade(hex, amount) {
    const h = hex.replace('#', '');
    const n = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    const out = n.map((v) => Math.round(Math.min(255, Math.max(0, v + amount * 255))));
    return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// ── layouts ────────────────────────────────────────────────────────────────

/**
 * Landscape card: title, date range, one line per day down the left, artwork
 * showing through on the right. The shape five of the nine examples used.
 */
async function drawOverlay(opts) {
    const width = 1600, height = 900;
    const canvas = Canvas.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const kind = await paintBackground(ctx, width, height,
        { ...opts, textZone: { x: 0, y: 0, w: Math.round(width * 0.68), h: height } });

    const pad = 78;
    // Text occupies the left 58%: the art in every example sat on the right.
    const colW = Math.round(width * 0.58) - pad;
    const zone = inkFor(ctx, pad - 20, 40, colW + 40, height - 80);
    // An image background always gets a scrim here, whatever the variance says:
    // a flat black backdrop scores as calm right up until the moment stray
    // generated lettering sits in it.
    if (kind === 'image' && !zone.scrim) zone.scrim = zone.mean < 0.5 ? 'rgba(8,6,14,.74)' : 'rgba(255,255,255,.78)';
    if (zone.scrim) {
        // A soft-edged panel rather than a hard box, so it reads as part of the art.
        const g = ctx.createLinearGradient(0, 0, width * 0.78, 0);
        g.addColorStop(0, zone.scrim);
        g.addColorStop(0.72, zone.scrim);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width * 0.78, height);
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    let y = pad + 92;

    ctx.font = fitText(ctx, opts.title.toUpperCase(), colW, 'normal 104px Anton');
    inked(ctx, opts.title.toUpperCase(), pad, y, zone);
    y += 54;

    if (opts.subtitle) {
        ctx.font = `normal 40px Oswald`;
        ctx.globalAlpha = 0.92;
        inked(ctx, opts.subtitle.toUpperCase(), pad, y, zone);
        ctx.globalAlpha = 1;
        y += 34;
    }

    // Accent rule under the heading — every example separated title from list.
    ctx.fillStyle = opts.accent || '#C7A5E8';
    ctx.fillRect(pad, y, Math.min(colW, 340), 6);
    y += 62;

    const rows = opts.rows.slice(0, 7);
    const room = height - y - pad;
    const step = Math.min(96, Math.floor(room / Math.max(1, rows.length)));

    for (const row of rows) {
        const rowZone = inkFor(ctx, pad, y - step * 0.6, colW, step);
        // Day, in the accent colour, then time and title in the reading colour.
        ctx.font = `normal ${Math.round(step * 0.42)}px Oswald`;
        const day = row.day.toUpperCase();
        ctx.save();
        ctx.shadowColor = rowZone.shadow; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
        ctx.fillStyle = opts.accent || '#C7A5E8';
        ctx.fillText(day, pad, y);
        ctx.restore();
        const dayW = ctx.measureText(day).width;

        // A missing time must not leave a stray separator behind — "SUNDAY — — — Rest day".
        const parts = row.cancelled
            ? ['CANCELLED']
            : [row.time, row.title].map((p) => String(p || '').trim())
                .filter((p) => p && p !== '—' && p !== '-');
        const tail = parts.length ? `  —  ${parts.join('  —  ')}` : '';
        ctx.font = fitText(ctx, tail, colW - dayW, `normal ${Math.round(step * 0.38)}px Oswald`, 18);
        if (row.cancelled) {
            ctx.save();
            ctx.shadowColor = rowZone.shadow; ctx.shadowBlur = 8;
            ctx.fillStyle = '#FF6B6B';
            ctx.fillText(tail, pad + dayW, y);
            ctx.restore();
        } else {
            inked(ctx, tail, pad + dayW, y, rowZone);
        }
        y += step;
    }

    if (opts.footer) {
        const fz = inkFor(ctx, pad, height - pad - 30, colW, 40);
        ctx.font = 'normal 30px Oswald';
        ctx.globalAlpha = 0.85;
        inked(ctx, opts.footer, pad, height - pad + 6, fz);
        ctx.globalAlpha = 1;
    }
    return canvas.toBuffer('image/png');
}

/**
 * Portrait card: a boxed row per day. MetalGurl2K's own schedule is this shape —
 * DAY and time on the left, what she's playing on the right.
 */
async function drawRows(opts) {
    const rows = opts.rows.slice(0, 7);
    const width = 1000;
    const header = 250, baseRowH = 116, lineH = 32, gap = 14, pad = 46, leftW = 300;
    /* One time per line, never one long comma-joined string. A day with two
       streams used to draw "10:00 PM – 12:30 AM, 10:00 PM – 12:30 AM CDT" as a
       single line at a fixed size, which ran off the left edge of the card and
       through the divider. Stacked, each line fits the column; the row grows. */
    const timeLines = (row) => {
        if (row.cancelled) return ['CANCELLED'];
        const times = Array.isArray(row.times) && row.times.length ? row.times : null;
        if (!times) return [row.time || ''];
        return times.map((t, i) => (i === times.length - 1 && row.zone ? `${t} ${row.zone}` : t));
    };
    const rowHeight = (row) => baseRowH + (timeLines(row).length - 1) * lineH;
    const height = header + rows.reduce((h, r) => h + rowHeight(r) + gap, 0)
        + pad + (opts.footer ? 70 : 0);
    const canvas = Canvas.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    // This layout covers the whole card in panels, so the whole card is the text zone.
    const kind = await paintBackground(ctx, width, height,
        { ...opts, textZone: { x: 0, y: 0, w: width, h: height } });

    const head = inkFor(ctx, 0, 0, width, header);
    if (kind === 'image' && !head.scrim) head.scrim = head.mean < 0.5 ? 'rgba(8,6,14,.74)' : 'rgba(255,255,255,.78)';
    if (head.scrim) { ctx.fillStyle = head.scrim; ctx.fillRect(0, 0, width, header); }
    ctx.textAlign = 'center';
    ctx.font = fitText(ctx, opts.title.toUpperCase(), width - pad * 2, 'normal 78px Anton');
    inked(ctx, opts.title.toUpperCase(), width / 2, 118, head);
    if (opts.subtitle) {
        ctx.font = 'normal 36px Oswald';
        ctx.globalAlpha = 0.9;
        inked(ctx, opts.subtitle.toUpperCase(), width / 2, 170, head);
        ctx.globalAlpha = 1;
    }
    ctx.fillStyle = opts.accent || '#C7A5E8';
    ctx.fillRect(width / 2 - 120, 196, 240, 5);

    let y = header;
    for (const row of rows) {
        const rowH = rowHeight(row);
        const lines = timeLines(row);
        const z = inkFor(ctx, pad, y, width - pad * 2, rowH);
        // Each row gets its own panel: it is what makes this layout readable on
        // a photographic background, and it matches the boxed look of the examples.
        ctx.save();
        roundRect(ctx, pad, y, width - pad * 2, rowH, 16);
        /* Panels sit over the artwork, so they have to be opaque enough to read
           against and sheer enough to still show it. A pale backdrop needs less
           covering than a busy dark one — a flat 0.82 white over pastel artwork
           erases the very thing the owner picked it for. */
        const heavy = kind === 'image' && z.variance > 0.03;
        ctx.fillStyle = z.mean < 0.5
            ? (heavy ? 'rgba(10,8,16,.80)' : 'rgba(10,8,16,.58)')
            : (heavy ? 'rgba(255,255,255,.80)' : 'rgba(255,255,255,.55)');
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = row.cancelled ? 'rgba(255,107,107,.8)' : (opts.accent || '#C7A5E8');
        ctx.stroke();
        ctx.restore();

        ctx.textAlign = 'center';
        ctx.font = `normal 38px Oswald`;
        ctx.save();
        ctx.shadowColor = z.shadow; ctx.shadowBlur = 6;
        ctx.fillStyle = opts.accent || '#C7A5E8';
        ctx.fillText(row.day.toUpperCase(), pad + leftW / 2, y + 50);
        ctx.restore();
        // Every line in a row shares one size — the widest decides it — so the
        // times stay aligned instead of each shrinking by a different amount.
        const timeFont = lines
            .map((line) => fitText(ctx, line, leftW - 28, 'normal 28px Oswald', 16))
            .reduce((a, b) => (parseInt(b.split(' ')[1], 10) < parseInt(a.split(' ')[1], 10) ? b : a));
        lines.forEach((line, i) => {
            ctx.font = timeFont;
            inked(ctx, line, pad + leftW / 2, y + 88 + i * lineH, z);
        });

        // Divider, then the game.
        ctx.fillStyle = z.mean < 0.5 ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.18)';
        ctx.fillRect(pad + leftW, y + 18, 2, rowH - 36);
        ctx.textAlign = 'center';
        const rightX = pad + leftW + (width - pad * 2 - leftW) / 2;
        ctx.font = fitText(ctx, row.title || '—', width - pad * 2 - leftW - 40, 'normal 46px Anton', 20);
        if (row.cancelled) {
            ctx.save(); ctx.shadowColor = z.shadow; ctx.shadowBlur = 6;
            ctx.fillStyle = '#FF6B6B'; ctx.fillText(row.title || 'NO STREAM', rightX, y + rowH / 2 + 16); ctx.restore();
        } else {
            inked(ctx, row.title || '—', rightX, y + rowH / 2 + 16, z);
        }
        y += rowH + gap;
    }

    if (opts.footer) {
        const fz = inkFor(ctx, 0, y, width, 60);
        ctx.textAlign = 'center';
        ctx.font = 'normal 28px Oswald';
        ctx.globalAlpha = 0.88;
        inked(ctx, opts.footer, width / 2, y + 40, fz);
        ctx.globalAlpha = 1;
    }
    return canvas.toBuffer('image/png');
}

/**
 * Render a schedule card.
 *
 * opts: { layout, title, subtitle, footer, accent, rows:[{day,time,title,cancelled}],
 *         mode, imageBuffer }
 */


/**
 * Default 7-panel layout for a portrait canvas when no Gemini-detected regions
 * exist (either detection failed, or we deliberately skipped it because we
 * generated a blank backdrop ourselves). Returns the same shape
 * `getCachedPanels` would return, so drawExact can consume it unchanged.
 *
 * The horizontal centre column is used so a round-trip blank template with
 * corner character art does not get text written over those illustrations.
 */
export function defaultPanels(width, height) {
    const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const HUES = { Monday:'warm', Tuesday:'warm', Wednesday:'cool',
                   Thursday:'mixed', Friday:'warm', Saturday:'cool', Sunday:'mixed' };
    const portrait = height >= width;
    /* Reserve more top space on portrait, less on landscape. Reserve bottom
       slot for the kitten / fox / corner character art, which Gemini
       consistently places in a lower corner. */
    const titleH = Math.round(height * (portrait ? 0.09 : 0.11));
    const titleY = Math.round(height * 0.025);
    const subH   = Math.round(height * (portrait ? 0.045 : 0.055));
    const footH  = Math.round(height * 0.035);
    const topReserved = titleY + titleH + subH + Math.round(height * 0.025);
    const bottomReserved = Math.round(height * (portrait ? 0.08 : 0.15)) + footH;
    const panelArea = height - topReserved - bottomReserved;
    const gap = portrait ? 10 : 6;
    const panelH = Math.floor((panelArea - gap * 6) / 7);
    /* Width: leave MORE room on the sides on landscape so corner characters
       (top-left face, bottom-right kittens) stay visible around the stack. */
    const panelW = Math.round(width * (portrait ? 0.78 : 0.58));
    const panelX = Math.round((width - panelW) / 2);
    const panels = DAYS.map((d, i) => ({
        day: d, x: panelX, y: topReserved + i * (panelH + gap),
        w: panelW, h: panelH, hue: HUES[d],
    }));
    return {
        width, height,
        title:    { x: Math.round(width * 0.1),  y: titleY,            w: Math.round(width * 0.8),  h: titleH },
        subtitle: { x: Math.round(width * 0.15), y: titleY + titleH,   w: Math.round(width * 0.7),  h: subH },
        footer:   { x: Math.round(width * 0.15), y: height - footH - Math.round(height * 0.015),
                    w: Math.round(width * 0.7), h: footH },
        panels,
    };
}

// ── exact layout (preserve the owner's artwork, write text into their panels) ─

/* Weekday-coloured gradients. The reference poster uses fire-orange on warm
   days and ice-blue on cool days; "mixed" days (fire+ice themed) get both.
   These are picked per panel from the Gemini-detected `hue` label. */
const DAY_GRADIENTS = {
    warm:  ['#FFE28A', '#FF9A3C', '#E24A17'],
    cool:  ['#E9F6FF', '#78C9FF', '#2A6FD1'],
    mixed: ['#FFE28A', '#FF9A3C', '#78C9FF', '#2A6FD1'],
};

/** Build a vertical multi-stop gradient fillStyle for a text run. */
function hueGradient(ctx, hue, x, y, h) {
    const stops = DAY_GRADIENTS[hue] || DAY_GRADIENTS.mixed;
    const g = ctx.createLinearGradient(x, y - h, x, y + h * 0.2);
    stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
    return g;
}

/** Draw text with an outer glow matching the family (gold-amber or ice-blue). */
function glowedText(ctx, text, x, y, { fill, glow = 'rgba(0,0,0,.85)', blur = 14, strokeW = 2, strokeStyle = 'rgba(0,0,0,.65)' }) {
    ctx.save();
    // Soft dark stroke first — gives the glow something crisp to bloom from.
    if (strokeW > 0) {
        ctx.lineWidth = strokeW;
        ctx.strokeStyle = strokeStyle;
        ctx.strokeText(text, x, y);
    }
    ctx.shadowColor = glow;
    ctx.shadowBlur = blur;
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
    // Second pass tightens the character edges that the shadow smeared.
    ctx.shadowBlur = 0;
    ctx.fillText(text, x, y);
    ctx.restore();
}

/**
 * Render into the owner's own poster.
 *
 * `opts.regions` comes from the Gemini Vision panel detector in
 * utils/schedule-panel-detect.js: an object with { width, height, title?,
 * subtitle?, footer?, panels: [{day, x, y, w, h, hue}] }. If regions is null —
 * detection failed or returned nothing usable — the caller should drop to the
 * `overlay` layout; this function will not draw a sensible fallback.
 */
async function drawExact(opts) {
    if (!opts.imageBuffer || !opts.regions?.panels?.length) return null;

    /* ── Phase 1: measure required height for each panel from the actual
       title text at a readable fixed size, so the image can grow to fit
       instead of forcing the title to shrink to illegibility. ──────── */
    const srcW = opts.regions.width;
    const srcH = opts.regions.height;
    const measureCanvas = Canvas.createCanvas(srcW, 10);
    const mctx = measureCanvas.getContext('2d');
    const rowsByDay = new Map((opts.rows || []).map((r) => [String(r.day).toLowerCase(), r]));

    const TITLE_SIZE = 22;
    const TIME_SIZE  = 22;
    const LINE_GAP   = 1.14;
    const panelMinH  = 110;

    const panelPlan = opts.regions.panels.map((panel) => {
        const row = rowsByDay.get(String(panel.day).toLowerCase());
        const pw = panel.w;
        const pad = Math.max(8, Math.round(pw * 0.025));
        const rightW = Math.round(pw * 0.60) - pad;

        // Time lines
        const timeStr = row?.cancelled ? 'CANCELLED'
            : (row && Array.isArray(row.times) && row.times.length
                ? (row.zone ? `${row.times.join(' · ')} ${row.zone}` : row.times.join(' · '))
                : (row?.time || ''));
        mctx.font = `normal ${TIME_SIZE}px Oswald`;
        const timeLines = timeStr ? wrapLines(mctx, timeStr, rightW) : [];
        const timeBlockH = Math.round(timeLines.length * TIME_SIZE * LINE_GAP);

        // Title lines — the big one. Measure at TITLE_SIZE with wrap, no limit.
        const title = row?.cancelled ? '' : (row?.title || '');
        mctx.font = `bold ${TITLE_SIZE}px "Cinzel Decorative"`;
        const titleLines = title ? wrapLines(mctx, title, rightW) : [];
        const titleBlockH = Math.round(titleLines.length * TITLE_SIZE * LINE_GAP);

        const gap = 8;
        const required = pad * 2 + timeBlockH + (timeBlockH && titleBlockH ? gap : 0) + titleBlockH;
        const h = Math.max(panelMinH, required);
        return { panel, row, h, pw, pad, rightW, timeLines, titleLines };
    });

    const panelGap = 10;
    const totalPanelsH = panelPlan.reduce((a, p) => a + p.h, 0) + panelGap * (panelPlan.length - 1);

    // Reserve space for title/subtitle/footer identical to defaultPanels layout.
    const titleH = Math.round(srcH * 0.09);
    const titleY = Math.round(srcH * 0.025);
    const subH   = Math.round(srcH * 0.045);
    const footH  = Math.round(srcH * 0.035);
    const topReserved = titleY + titleH + subH + Math.round(srcH * 0.025);
    const bottomReserved = Math.round(srcH * 0.08) + footH;

    const requiredHeight = topReserved + totalPanelsH + bottomReserved;
    const canvasH = Math.max(srcH, requiredHeight);
    const canvasW = srcW;

    /* ── Phase 2: composite backdrop to canvasW×canvasH. Stretch
       vertically with sharp.resize({fit:'fill'}) so the decorative
       border extends to the new height instead of cropping. ────── */
    const { default: sharp } = await import('sharp');
    let bgBuf = opts.imageBuffer;
    if (canvasH !== srcH || canvasW !== srcW) {
        bgBuf = await sharp(opts.imageBuffer)
            .resize(canvasW, canvasH, { fit: 'fill' })
            .toFormat('png').toBuffer();
    }
    const img = await Canvas.loadImage(bgBuf);
    const canvas = Canvas.createCanvas(canvasW, canvasH);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvasW, canvasH);

    /* ── Phase 3: draw title + subtitle + panels + footer ──────── */
    if (opts.title) {
        const t = { x: Math.round(canvasW * 0.1), y: titleY,
                    w: Math.round(canvasW * 0.8), h: titleH };
        const title = opts.title.toUpperCase();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = autoFit(ctx, title, t.w - 20, t.h - 10,
            'normal 160px "Cinzel Decorative"', { minSize: 24 });
        const fill = hueGradient(ctx, 'warm', t.x + t.w / 2, t.y + t.h / 2, t.h * 0.6);
        glowedText(ctx, title, t.x + t.w / 2, t.y + t.h / 2,
            { fill, glow: 'rgba(255,160,40,.78)', blur: 26, strokeW: 3,
              strokeStyle: 'rgba(0,0,0,.72)' });
    }
    if (opts.subtitle) {
        const s2 = { x: Math.round(canvasW * 0.15), y: titleY + titleH,
                     w: Math.round(canvasW * 0.7), h: subH };
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = autoFit(ctx, opts.subtitle, s2.w - 20, s2.h - 6,
            'normal 100px "Alex Brush"', { minSize: 20, heightFactor: 1.4 });
        glowedText(ctx, opts.subtitle, s2.x + s2.w / 2, s2.y + s2.h / 2,
            { fill: '#FFF8E6', glow: 'rgba(255,200,120,.6)', blur: 18, strokeW: 1 });
    }

    // Panels stacked at the content-driven heights.
    let py = topReserved;
    for (const p of panelPlan) {
        const panel = p.panel;
        const hue = ['warm', 'cool', 'mixed'].includes(panel.hue) ? panel.hue : 'mixed';
        const borderColor = hue === 'cool' ? '#78C9FF' : hue === 'warm' ? '#FF9A3C' : '#C7A5E8';
        const glowColor = hue === 'cool' ? 'rgba(120,200,255,.75)'
                        : hue === 'warm' ? 'rgba(255,160,40,.75)' : 'rgba(200,160,240,.7)';
        const px = Math.round((canvasW - panel.w) / 2);
        const pw = panel.w;
        const ph = p.h;
        const pad = p.pad;
        const r = Math.min(14, Math.round(ph * 0.1));

        ctx.save();
        roundRect(ctx, px, py, pw, ph, r);
        ctx.fillStyle = 'rgba(10,8,22,.62)';
        ctx.fill();
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 20;
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = borderColor;
        ctx.stroke();
        ctx.restore();

        const leftW  = Math.round(pw * 0.38) - pad;
        const rightW = p.rightW;
        const leftX  = px + pad;
        const rightX = px + pw - rightW - pad;

        /* Day name — Berkshire Swash, autofit to panel height (NOT the title
           block height), gives bigger letters when the panel grew tall. */
        const dayText = String(panel.day);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = autoFit(ctx, dayText, leftW, ph - pad * 2,
            'normal 140px "Berkshire Swash"', { minSize: 22, heightFactor: 1.25 });
        const dayFill = hueGradient(ctx, hue, leftX, py + ph / 2, ph * 0.5);
        glowedText(ctx, dayText, leftX, py + ph / 2,
            { fill: dayFill, glow: glowColor, blur: 18, strokeW: 2.2,
              strokeStyle: 'rgba(0,0,0,.65)' });

        // Right column — draw the exact lines we planned, at TIME/TITLE sizes.
        let cursorY = py + pad;
        if (p.timeLines.length) {
            ctx.font = `normal ${TIME_SIZE}px Oswald`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            for (const line of p.timeLines) {
                glowedText(ctx, line, rightX, cursorY + TIME_SIZE * 0.85,
                    { fill: p.row?.cancelled ? '#FF6B6B' : '#FFEBB0',
                      glow: hue === 'cool' ? 'rgba(60,120,200,.55)' : 'rgba(180,80,20,.55)',
                      blur: 10, strokeW: 1.2 });
                cursorY += Math.round(TIME_SIZE * LINE_GAP);
            }
            if (p.titleLines.length) cursorY += 6;
        }
        if (p.titleLines.length) {
            ctx.font = `bold ${TITLE_SIZE}px "Cinzel Decorative"`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            for (const line of p.titleLines) {
                glowedText(ctx, line, rightX, cursorY + TITLE_SIZE * 0.85,
                    { fill: '#FFFFFF',
                      glow: hue === 'cool' ? 'rgba(100,200,255,.85)' : 'rgba(255,170,60,.85)',
                      blur: 14, strokeW: 1.4 });
                cursorY += Math.round(TITLE_SIZE * LINE_GAP);
            }
        }

        py += ph + panelGap;
    }

    if (opts.footer) {
        const f = { x: Math.round(canvasW * 0.15),
                    y: canvasH - footH - Math.round(canvasH * 0.015),
                    w: Math.round(canvasW * 0.7), h: footH };
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = autoFit(ctx, opts.footer, f.w - 20, f.h - 4,
            'normal 80px "Alex Brush"', { minSize: 16, heightFactor: 1.4 });
        glowedText(ctx, opts.footer, f.x + f.w / 2, f.y + f.h / 2,
            { fill: '#F5E3B8', glow: 'rgba(0,0,0,.65)', blur: 10, strokeW: 0 });
    }
    return canvas.toBuffer('image/png');
}

/* ── poster layout ─────────────────────────────────────────────────────────
 *
 * Match a Canva-style streamer poster: big metallic-gold "STREAM SCHEDULE"
 * at the top, purple→pink date range beneath it, one day-per-line down the
 * left column with the stream title as a sub-caption, and a brush-script
 * "@username on Twitch" at the bottom. All text lives in the left ~56 % of
 * the canvas so corner character art on the right stays visible.
 *
 * Unlike `exact`, no detected regions are needed — the layout is driven by
 * canvas size alone, so this works on any uploaded poster whose text has
 * been stripped by the style pipeline (or on a Gemini-generated backdrop).
 */
async function drawPoster(opts) {
    if (!opts.imageBuffer) return null;
    const img = await Canvas.loadImage(opts.imageBuffer);
    const W = img.width, H = img.height;
    const canvas = Canvas.createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, W, H);

    const COL_X = Math.round(W * 0.05);
    const COL_W = Math.round(W * 0.56);
    const DAYS  = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

    // Normalise rows into a day→entry map so the full week always renders in order,
    // and empty days get a dim "no stream" line instead of a gap.
    const byDay = new Map();
    for (const r of (opts.rows || [])) {
        const key = String(r.day || '').toLowerCase();
        const times = Array.isArray(r.times) && r.times.length ? r.times : (r.time ? [r.time] : []);
        byDay.set(key, { day: r.day, times, zone: r.zone || '', title: r.title || '', cancelled: !!r.cancelled });
    }
    const zone = [...byDay.values()].find(v => v.zone)?.zone || '';
    const lines = DAYS.map((d) => {
        const e = byDay.get(d.toLowerCase());
        if (!e || (!e.times.length && !e.title)) {
            return { day: d, headline: `${d} — no stream`, sub: null, empty: true };
        }
        if (e.cancelled) {
            return { day: d, headline: `${d} — cancelled`, sub: e.title || null, empty: false, cancelled: true };
        }
        const timeStr = e.times.length ? `${e.times.join(' · ')}${zone ? ' ' + zone : ''}` : (zone || '');
        return { day: d, headline: `${d} — ${timeStr}`, sub: e.title || null, empty: false };
    });

    const strokedText = (text, x, y, { fill, strokeW = 0, strokeStyle = 'rgba(0,0,0,.75)',
                                        shadowColor = null, shadowBlur = 0 }) => {
        ctx.save();
        if (shadowColor) { ctx.shadowColor = shadowColor; ctx.shadowBlur = shadowBlur; }
        if (strokeW > 0) { ctx.lineWidth = strokeW; ctx.strokeStyle = strokeStyle; ctx.strokeText(text, x, y); }
        ctx.fillStyle = fill;
        ctx.fillText(text, x, y);
        ctx.restore();
    };
    const fitFont = (text, maxW, familyTpl) => {
        let size = Number(familyTpl.match(/\{(\d+)\}px/)?.[1] ?? 72);
        while (size > 10) {
            const f = familyTpl.replace(/\{\d+\}px/, `${size}px`);
            ctx.font = f;
            if (ctx.measureText(text).width <= maxW) return f;
            size -= 2;
        }
        return familyTpl.replace(/\{\d+\}px/, '12px');
    };
    const wrapToLines = (text, maxW, maxLines = 2) => {
        const words = String(text || '').split(/\s+/).filter(Boolean);
        const out = []; let cur = '';
        for (const w of words) {
            const probe = cur ? `${cur} ${w}` : w;
            if (ctx.measureText(probe).width <= maxW) cur = probe;
            else {
                if (cur) out.push(cur);
                cur = w;
                if (out.length === maxLines - 1 && ctx.measureText(cur).width > maxW) {
                    while (cur && ctx.measureText(cur + '…').width > maxW) cur = cur.slice(0, -1);
                    cur += '…';
                    break;
                }
            }
        }
        if (cur) out.push(cur);
        return out.slice(0, maxLines);
    };

    // Title — metallic gold Anton, fitted to the left column.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const titleText = (opts.title || 'STREAM SCHEDULE').toUpperCase();
    ctx.font = fitFont(titleText, COL_W, 'normal {118}px Anton');
    const titleY = Math.round(H * 0.14);
    const titleH = parseInt(ctx.font.match(/(\d+)px/)[1], 10);
    const titleGrad = ctx.createLinearGradient(0, titleY - titleH, 0, titleY + titleH * 0.05);
    titleGrad.addColorStop(0.00, '#F7DF8A');
    titleGrad.addColorStop(0.45, '#FFF1A8');
    titleGrad.addColorStop(0.55, '#B6871E');
    titleGrad.addColorStop(1.00, '#8B5A0D');
    strokedText(titleText, COL_X, titleY, {
        fill: titleGrad, strokeW: 4, strokeStyle: 'rgba(0,0,0,.78)',
        shadowColor: 'rgba(0,0,0,.75)', shadowBlur: 18,
    });

    // Subtitle — date range in Oswald, purple→pink gradient.
    if (opts.subtitle) {
        const subText = String(opts.subtitle).toUpperCase();
        ctx.font = fitFont(subText, Math.round(COL_W * 0.75), 'normal {44}px Oswald');
        const subY = titleY + 54;
        const subH = parseInt(ctx.font.match(/(\d+)px/)[1], 10);
        const subGrad = ctx.createLinearGradient(COL_X, subY - subH, COL_X + COL_W, subY);
        subGrad.addColorStop(0, '#C7A5E8');
        subGrad.addColorStop(1, '#F7B6F0');
        strokedText(subText, COL_X, subY, {
            fill: subGrad, strokeW: 1.5, shadowColor: 'rgba(0,0,0,.6)', shadowBlur: 10,
        });
    }

    // Body — day lines. Font sized so all 7 rows (plus wrapped subs) fit between
    // the subtitle and the bottom signature.
    const linesTop = titleY + Math.round(H * 0.09);
    const linesBottom = Math.round(H * 0.82);
    const estRows = lines.reduce((a, l) => a + (l.sub ? 2 : 1), 0);
    const perLine = Math.max(16, Math.floor((linesBottom - linesTop) / estRows));
    const bodySize = Math.max(22, Math.min(34, Math.round(perLine * 0.70)));
    const subBodySize = Math.round(bodySize * 0.68);
    const dayGap = Math.round(bodySize * 0.35);

    let cursorY = linesTop;
    for (const line of lines) {
        ctx.font = `bold ${bodySize}px Oswald`;
        cursorY += Math.round(bodySize * 0.95);
        const fill = line.cancelled ? 'rgba(255,107,107,.9)'
                   : line.empty ? 'rgba(255,213,79,.45)'
                   : '#FFD54F';
        strokedText(line.headline, COL_X, cursorY, {
            fill, strokeW: line.empty ? 1 : 2,
            shadowColor: 'rgba(0,0,0,.80)', shadowBlur: line.empty ? 6 : 12,
        });
        if (line.sub) {
            ctx.font = `normal ${subBodySize}px Oswald`;
            for (const seg of wrapToLines(line.sub, COL_W, 2)) {
                cursorY += Math.round(subBodySize * 1.15);
                strokedText(seg, COL_X, cursorY, {
                    fill: '#FFFFFF', strokeW: 1.2,
                    shadowColor: 'rgba(0,0,0,.75)', shadowBlur: 8,
                });
            }
        }
        cursorY += dayGap;
    }

    // Signature — "@handle on Twitch" in Alex Brush, bottom-left.
    if (opts.footer) {
        const sig = String(opts.footer);
        ctx.font = fitFont(sig, COL_W, 'normal {96}px "Alex Brush"');
        strokedText(sig, COL_X, Math.round(H * 0.96), {
            fill: '#FFFFFF', strokeW: 2.4, strokeStyle: 'rgba(60,20,80,.85)',
            shadowColor: 'rgba(0,0,0,.75)', shadowBlur: 18,
        });
    }

    return canvas.toBuffer('image/png');
}

export async function renderSchedule(opts) {
    if (!Canvas) return null;
    const layout = LAYOUTS.includes(opts.layout) ? opts.layout : 'overlay';
    if (!opts.rows?.length) return null;
    if (layout === 'exact') {
        const out = await drawExact(opts);
        if (out) return out;
        /* exact failed (no regions, or Canvas blew up on a huge image) — the
           caller passed an imageBuffer, so overlay still works and the owner's
           artwork is in it at least. */
    }
    if (layout === 'poster') {
        const out = await drawPoster(opts);
        if (out) return out;
        // Poster needs an imageBuffer; without one, drop through to overlay
        // so the schedule still posts rather than silently failing.
    }
    if (layout === 'rows') return drawRows(opts);
    return drawOverlay(opts);
}

export default { renderSchedule, LAYOUTS, BACKGROUNDS, inkFor, drawExact, defaultPanels };
