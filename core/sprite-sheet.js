/*
 * Cutting a sheet of emotes into separate emoji.
 *
 * People hand over one picture holding twenty stickers on a flat background, and
 * what is wanted is twenty files. The obvious approach — find every island of
 * non-background pixels — gets it wrong: sparkles, speech text, an anger vein and
 * a floating music note are all separate islands, so one sticker comes out as
 * five pieces with its decoration stripped off.
 *
 * So the sheet is read the way a person reads it: find the horizontal bands that
 * have anything in them, then find the columns inside each band. Everything in a
 * cell belongs to that cell, however many disconnected pieces it is made of, and
 * rows holding different numbers of stickers need no special handling.
 */
import sharp from 'sharp';
import { cutOutBackground } from './emote-pack.js';

/**
 * Where the background is.
 *
 * Sheets come on a flat field — white, or the pale pink these packs like — so the
 * corners say what to look for. Anything close to that colour and reachable from
 * the edge is background; everything else is a drawing.
 */
async function backgroundMask(input, { tolerance = 34 } = {}) {
    const { data, info } = await sharp(input).ensureAlpha().raw()
        .toBuffer({ resolveWithObject: true });
    const { width: w, height: h, channels: ch } = info;

    const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
    let kr = 0, kg = 0, kb = 0;
    for (const [x, y] of corners) {
        const i = (y * w + x) * ch;
        kr += data[i]; kg += data[i + 1]; kb += data[i + 2];
    }
    kr /= 4; kg /= 4; kb /= 4;

    /* Transparent sheets exist too, and on those the alpha channel already says
       everything. Treat a transparent corner as the key rather than its colour. */
    const keyIsAlpha = data[3] === 0;

    const ink = new Uint8Array(w * h);          // 1 = part of a drawing
    for (let p = 0; p < w * h; p++) {
        const i = p * ch;
        if (keyIsAlpha) { ink[p] = data[i + 3] > 16 ? 1 : 0; continue; }
        const d = Math.max(Math.abs(data[i] - kr), Math.abs(data[i + 1] - kg), Math.abs(data[i + 2] - kb));
        ink[p] = (d > tolerance && data[i + 3] > 16) ? 1 : 0;
    }
    return { ink, w, h, key: { r: kr, g: kg, b: kb }, keyIsAlpha };
}

/**
 * Runs of consecutive lines that contain ink.
 *
 * `minGap` is what stops a sticker being split down the middle by the white gap
 * between a character and the sparkle beside it, and `minRun` throws away the
 * one-pixel specks that JPEG artefacts leave behind.
 */
function bands(counts, { minGap = 3, minRun = 6, quiet = 0.02 } = {}) {
    /* The dividing line between rows is rarely empty. On a sheet where sparkles
       from one row reach down past the next, the gap still carries a few pixels —
       eight, against four hundred through a sticker — so a row only counts as
       occupied once it is above a small fraction of the busiest line. Testing for
       exactly zero merges two rows into one tall block. */
    const threshold = Math.max(0, Math.floor(Math.max(...counts) * quiet));
    const out = [];
    let start = null, gap = 0;
    for (let i = 0; i < counts.length; i++) {
        if (counts[i] > threshold) {
            if (start === null) start = i;
            gap = 0;
        } else if (start !== null) {
            gap++;
            if (gap >= minGap) {
                if (i - gap - start >= minRun) out.push([start, i - gap]);
                start = null; gap = 0;
            }
        }
    }
    if (start !== null && counts.length - start >= minRun) out.push([start, counts.length - 1]);

    /* Give the quiet lines back. They are not empty — they hold the tail of a
       music note or the tip of a sparkle — so each band grows into the gap beside
       it, up to halfway, rather than losing the decoration that hangs into it. */
    for (let i = 0; i < out.length; i++) {
        const prevEnd = i === 0 ? -1 : out[i - 1][1];
        const nextStart = i === out.length - 1 ? counts.length : out[i + 1][0];
        out[i][0] = Math.max(prevEnd + 1, out[i][0] - Math.floor((out[i][0] - prevEnd - 1) / 2));
        out[i][1] = Math.min(nextStart - 1, out[i][1] + Math.floor((nextStart - 1 - out[i][1]) / 2));
    }
    return out;
}

/**
 * Split a sheet into its individual emotes.
 *
 * Returns one entry per cell with a PNG whose background has been made
 * transparent, cropped tight to what is drawn. `row`/`col` are kept so callers
 * can name things by position, which is the only thing that survives when nobody
 * can tell the software what each sticker is.
 */
export async function splitSheet(input, {
    tolerance = 34,
    minGap = 3,
    minRun = 6,
    quiet = 0.02,
    feather = 10,
    /* No padding. `bands()` already grows each band halfway into the gap beside
       it, so the crop edge sits in empty space; adding more on top reaches across
       into the next sticker and brings a sliver of it along. */
    pad = 0,
    dropSmall = 0.25,
} = {}) {
    const { ink, w, h, key, keyIsAlpha } = await backgroundMask(input, { tolerance });

    const rowCounts = new Array(h).fill(0);
    for (let y = 0; y < h; y++) {
        let n = 0;
        for (let x = 0; x < w; x++) n += ink[y * w + x];
        rowCounts[y] = n;
    }

    const cells = [];
    const rowBands = bands(rowCounts, { minGap, minRun, quiet });
    for (const [top, bottom] of rowBands) {
        const colCounts = new Array(w).fill(0);
        for (let x = 0; x < w; x++) {
            let n = 0;
            for (let y = top; y <= bottom; y++) n += ink[y * w + x];
            colCounts[x] = n;
        }
        for (const [left, right] of bands(colCounts, { minGap, minRun, quiet })) {
            /* The band's top and bottom belong to the widest sticker in the row;
               this one may be shorter. Tighten to its own ink. */
            let t = bottom, b = top;
            for (let y = top; y <= bottom; y++) {
                for (let x = left; x <= right; x++) {
                    if (ink[y * w + x]) { if (y < t) t = y; if (y > b) b = y; break; }
                }
            }
            cells.push({ left, top: t, right, bottom: b, row: cells.length });
        }
    }
    if (!cells.length) return [];

    // A band far smaller than the rest is a caption or a watermark, not an emote.
    const areas = cells.map((c) => (c.right - c.left + 1) * (c.bottom - c.top + 1));
    const median = [...areas].sort((a, b) => a - b)[Math.floor(areas.length / 2)];

    const out = [];
    for (const [i, c] of cells.entries()) {
        if (areas[i] < median * dropSmall) continue;
        const left = Math.max(0, c.left - pad);
        const top = Math.max(0, c.top - pad);
        const width = Math.min(w - left, c.right - c.left + 1 + pad * 2);
        const height = Math.min(h - top, c.bottom - c.top + 1 + pad * 2);

        const crop = await sharp(input).ensureAlpha()
            .extract({ left, top, width, height }).png().toBuffer();

        /* Flood fill from the crop's border, not "erase every pixel of the field
           colour". The Kirby sheet sits on pale pink and Kirby is pink: erasing by
           colour ate his own body and left a ghost. Only background the edge can
           reach is background, and his outline stops the fill at his skin. */
        /* A narrow feather on purpose. Widening it to match the tolerance made
           anything merely pale — the grey arc behind one sticker, a white panel
           behind another — come out half-transparent, which reads as a dark box
           on Discord's dark theme. Only pixels within a hair of the field colour
           should fade; real light-coloured artwork must stay solid. */
        const buffer = keyIsAlpha ? crop
            : (await cutOutBackground(crop, { tolerance, feather, key })).buffer;

        out.push({ index: out.length, box: { left, top, width, height }, buffer });
    }
    return out;
}

export default { splitSheet };
