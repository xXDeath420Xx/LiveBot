/*
 * Making an emote move.
 *
 * Every animated emote on Discord or Twitch is one of about a dozen effects —
 * a hop, a shake, a spin, a hue cycle. None of them need new artwork: they are
 * transforms of a still picture over twelve frames, which means any emote in a
 * server can have an animated twin without drawing anything twice.
 *
 * Two constraints shape everything here:
 *
 *   1. GIF alpha is one bit. There is no half-transparent pixel, so a soft edge
 *      becomes a hard one. These emotes survive it because they carry a thick
 *      sticker outline — checked against both Discord themes — but the threshold
 *      is deliberate, not a default.
 *   2. 256 KiB, the same ceiling as a still emoji, for twelve times the pixels.
 *      A hue-cycling frame set uses far more of the palette than a hop, so the
 *      encoder has to be allowed to give ground: fewer colours, then fewer
 *      frames, then fewer pixels, in that order — motion reads at emoji size
 *      long after fine detail has stopped mattering.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import logger from '../utils/logger.js';

const run = promisify(execFile);

export const MAX_BYTES = 256 * 1024;
const SIZE = 128;

/**
 * The effects, and what each one does to one frame.
 *
 * `t` runs 0 → 1 across the loop. Each returns how to place the artwork:
 * `scale` of the canvas, `dx`/`dy` in pixels, `rotate` in degrees, `hue` shift,
 * `flip` to mirror, and an optional `backdrop` colour behind everything.
 *
 * `margin` is how much of the canvas the artwork leaves free, so a spin or a hop
 * does not clip itself on the edge.
 */
export const EFFECTS = {
    bounce: {
        label: 'Bounce', frames: 12, fps: 14, margin: 0.18,
        at: (t) => ({ dy: -Math.round(14 * Math.abs(Math.sin(Math.PI * t))) }),
    },
    jump: {
        label: 'Jump (squash & stretch)', frames: 12, fps: 14, margin: 0.2,
        at: (t) => {
            const h = Math.abs(Math.sin(Math.PI * t));
            // Squash on the ground, stretch in the air — the oldest trick there is.
            return { dy: -Math.round(16 * h), scaleX: 1 + 0.12 * (0.4 - h), scaleY: 1 - 0.12 * (0.4 - h) };
        },
    },
    shake: {
        label: 'Shake (intensifies)', frames: 8, fps: 24, margin: 0.14,
        at: () => ({ dx: Math.round((Math.random() - 0.5) * 10), dy: Math.round((Math.random() - 0.5) * 10) }),
    },
    tremble: {
        label: 'Tremble', frames: 8, fps: 20, margin: 0.1,
        at: (t, i) => ({ dx: (i % 2 ? 2 : -2), dy: (i % 3 ? 1 : -1) }),
    },
    spin: {
        label: 'Spin', frames: 16, fps: 18, margin: 0.28,
        at: (t) => ({ rotate: Math.round(360 * t) }),
    },
    wiggle: {
        label: 'Wiggle', frames: 12, fps: 16, margin: 0.22,
        at: (t) => ({ rotate: Math.round(14 * Math.sin(2 * Math.PI * t)) }),
    },
    pulse: {
        label: 'Pulse', frames: 12, fps: 14, margin: 0.16,
        at: (t) => ({ scale: 1 + 0.14 * Math.sin(2 * Math.PI * t) }),
    },
    zoom: {
        label: 'Zoom in', frames: 12, fps: 16, margin: 0.2,
        at: (t) => ({ scale: 0.55 + 0.45 * Math.min(1, t * 1.6) }),
    },
    slide: {
        label: 'Slide in', frames: 12, fps: 16, margin: 0.12,
        at: (t) => ({ dx: Math.round(-SIZE * Math.max(0, 1 - t * 1.8)) }),
    },
    flip: {
        label: 'Flip', frames: 12, fps: 12, margin: 0.12,
        at: (t) => {
            // A cheap 3D flip: squeeze horizontally through the halfway point.
            const p = Math.cos(2 * Math.PI * t);
            return { scaleX: Math.max(0.06, Math.abs(p)), flip: p < 0 };
        },
    },
    rainbow: {
        label: 'Rainbow', frames: 12, fps: 14, margin: 0.08,
        at: (t) => ({ hue: Math.round(360 * t) }),
    },
    party: {
        label: 'Party (rainbow behind)', frames: 12, fps: 14, margin: 0.1,
        at: (t) => ({ backdrop: hsl(Math.round(360 * t), 85, 62), dy: -Math.round(5 * Math.abs(Math.sin(Math.PI * t))) }),
    },
    rave: {
        label: 'Rave', frames: 10, fps: 20, margin: 0.16,
        at: (t) => ({
            hue: Math.round(360 * t),
            dx: Math.round((Math.random() - 0.5) * 8),
            dy: Math.round((Math.random() - 0.5) * 8),
        }),
    },
    roll: {
        label: 'Roll across', frames: 16, fps: 18, margin: 0.26,
        at: (t) => ({ rotate: Math.round(360 * t), dx: Math.round(SIZE * 0.5 * Math.sin(2 * Math.PI * t)) }),
    },
};

function hsl(h, s, l) {
    return `hsl(${h}, ${s}%, ${l}%)`;
}

/** Build one frame of the animation as a 128×128 RGBA PNG. */
async function renderFrame(art, spec, t, i) {
    const p = spec.at(t, i) || {};
    const base = Math.round(SIZE * (1 - spec.margin));

    let w = Math.max(8, Math.round(base * (p.scale ?? 1) * (p.scaleX ?? 1)));
    let h = Math.max(8, Math.round(base * (p.scale ?? 1) * (p.scaleY ?? 1)));

    let img = sharp(art).resize(w, h, { fit: 'fill' });
    if (p.flip) img = img.flop();
    if (p.hue) img = img.modulate({ hue: p.hue });
    if (p.rotate) {
        img = img.rotate(p.rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    }

    const piece = await img.png().toBuffer();
    const meta = await sharp(piece).metadata();

    const canvas = sharp({
        create: {
            width: SIZE, height: SIZE, channels: 4,
            background: p.backdrop
                ? p.backdrop
                : { r: 0, g: 0, b: 0, alpha: 0 },
        },
    });

    const left = Math.round((SIZE - meta.width) / 2) + (p.dx ?? 0);
    const top = Math.round((SIZE - meta.height) / 2) + (p.dy ?? 0);

    /* Anything pushed off the canvas has to be cropped, not refused: sharp
       rejects a composite whose origin is negative or past the edge. */
    const sx = Math.max(0, -left), sy = Math.max(0, -top);
    const vw = Math.min(meta.width - sx, SIZE - Math.max(0, left));
    const vh = Math.min(meta.height - sy, SIZE - Math.max(0, top));
    if (vw <= 0 || vh <= 0) return canvas.png().toBuffer();

    const visible = await sharp(piece)
        .extract({ left: sx, top: sy, width: vw, height: vh })
        .png().toBuffer();

    return canvas
        .composite([{ input: visible, left: Math.max(0, left), top: Math.max(0, top) }])
        .png().toBuffer();
}

/**
 * Encode a directory of frames as a looping GIF.
 *
 * palettegen/paletteuse rather than ffmpeg's default: a single shared palette
 * chosen from the whole clip keeps colours stable between frames, and
 * `reserve_transparent` is what keeps a transparent hole transparent instead of
 * filling it with the nearest palette colour.
 */
async function encodeGif(dir, { fps, colours = 128 }) {
    const out = path.join(dir, 'out.gif');
    await run('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-framerate', String(fps),
        '-i', path.join(dir, 'f%03d.png'),
        '-filter_complex',
        `[0:v]split[a][b];[a]palettegen=max_colors=${colours}:reserve_transparent=1:stats_mode=diff[p];` +
        '[b][p]paletteuse=alpha_threshold=128:dither=bayer:bayer_scale=3',
        '-loop', '0',
        out,
    ]);
    return fs.readFile(out);
}

/**
 * Animate one still emote.
 *
 * `art` is any image — a 128px emoji PNG is the expected thing. Returns a GIF
 * under Discord's limit, or throws saying why it could not get there.
 */
export async function animateEmote(art, effectName, { size = SIZE } = {}) {
    const spec = EFFECTS[effectName];
    if (!spec) throw new Error(`no such effect: ${effectName}`);

    const dir = path.join(os.tmpdir(), `emote-anim-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    try {
        // Work from a clean square so every effect starts from the same footing.
        const square = await sharp(art)
            .ensureAlpha()
            .trim({ threshold: 1 }).toBuffer()
            .catch(() => sharp(art).ensureAlpha().toBuffer());
        const source = await sharp(square)
            .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png().toBuffer();

        for (let i = 0; i < spec.frames; i++) {
            const frame = await renderFrame(source, spec, i / spec.frames, i);
            await fs.writeFile(path.join(dir, `f${String(i).padStart(3, '0')}.png`), frame);
        }

        /* Give ground in the order that costs the least. Colours first — a hop
           does not need 128 of them; frames next, because a slightly choppier
           loop still reads; pixels last, since that is the only one anybody
           actually sees at emoji size. */
        for (const colours of [128, 64, 32]) {
            const gif = await encodeGif(dir, { fps: spec.fps, colours });
            if (gif.length <= MAX_BYTES) return { buffer: gif, bytes: gif.length, effect: effectName };
        }

        // Drop every other frame and halve the rate so the timing still matches.
        const kept = [];
        for (let i = 0; i < spec.frames; i += 2) kept.push(i);
        for (const [i, src] of kept.entries()) {
            await fs.rename(path.join(dir, `f${String(src).padStart(3, '0')}.png`),
                path.join(dir, `k${String(i).padStart(3, '0')}.png`));
        }
        for (const f of await fs.readdir(dir)) {
            if (f.startsWith('f')) await fs.unlink(path.join(dir, f));
        }
        for (const f of await fs.readdir(dir)) {
            if (f.startsWith('k')) await fs.rename(path.join(dir, f), path.join(dir, `f${f.slice(1)}`));
        }
        for (const colours of [64, 32]) {
            const gif = await encodeGif(dir, { fps: Math.round(spec.fps / 2), colours });
            if (gif.length <= MAX_BYTES) return { buffer: gif, bytes: gif.length, effect: effectName, reduced: true };
        }

        throw new Error('that effect will not fit in 256 KiB');
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

/** Is ffmpeg actually here? Called before offering the feature. */
export async function animationAvailable() {
    try {
        await run('ffmpeg', ['-version']);
        return true;
    } catch (e) {
        logger.warn(`[EmoteAnimate] ffmpeg is not available: ${e.message}`, { category: 'emoji' });
        return false;
    }
}

/** Upload a prepared GIF as an animated emoji. */
export function gifDataUri(gif) {
    return `data:image/gif;base64,${gif.toString('base64')}`;
}

export default { EFFECTS, animateEmote, animationAvailable, gifDataUri, MAX_BYTES };
