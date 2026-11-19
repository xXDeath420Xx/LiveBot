/**
 * Perceptual fingerprinting for the scam-image blocklist.
 *
 * Pure and DB-free so it can be unit-tested; core/image-blocklist.js owns the storage, the Discord
 * side effects and the guild gating. Split for the same reason commission-spam-match.js is split
 * out of commission-spam-filter.js — the matching rules are the part worth testing directly, and
 * importing the manager would open a database connection to do it.
 *
 * An image is matched only when TWO independent fingerprints agree.
 *
 * dHash alone is not selective enough to act on. Measured over 479 distinct images from this repo,
 * unrelated pairs land within Hamming 10 of each other once in every 70 pairs, and within 16 once
 * in every 17 — so the radius is 10 and is deliberately NOT widened. Loosening one fuzzy signal to
 * buy crop tolerance would cost real conversation.
 *
 * The second signal is colour. dHash reduces to greyscale and stores only "is this pixel brighter
 * than the one to its right", so it discards colour entirely and a coarse RGB grid is largely
 * independent evidence. Requiring both to agree drops unrelated collisions from one in 70 to one in
 * 309, while genuine re-posts are untouched — re-encode, resize to 30%, brighten, saturate, WebP
 * and a pasted-on black bar all measure 0.6-3.4 colour distance against a threshold of 14.
 *
 * Colour is a supplement, NOT a safety net, and it is weakest exactly where this blocklist is used.
 * The scam images are light-UI screenshots, and two unrelated light-UI screenshots measured as
 * close as 3.5 apart on colour — inside the threshold. Within that class dHash is doing all of the
 * separating (the nearest unrelated screenshot sits 20+ bits away against a radius of 10), which is
 * why the radius must stay tight and why tests/image-fingerprint.test.js asserts that margin
 * directly instead of trusting colour to catch what dHash lets through.
 *
 * The third guard is informativeness, and it is the one that prevents a catastrophe. A smooth
 * gradient or near-flat image has no horizontal detail, so every neighbour comparison answers the
 * same way and the hash collapses to all-zeros — matching every other flat image at distance 0.
 * assets/rank-presets/forest.png and a vendored jQuery UI gradient genuinely collide at distance 0.
 * Any image whose popcount falls outside [MIN_BITS, MAX_BITS] is refused in BOTH directions: it can
 * neither be added to the blocklist nor matched against one.
 */
import sharp from 'sharp';

export const DHASH_MATCH = 10;   // Hamming over 64-bit dHash. 16 is NOT safe — see above.
export const COLOUR_MATCH = 14;  // Mean abs RGB channel diff over a 4x4 grid. Reposts measure <=3.4.
export const MIN_BITS = 6;       // Outside [MIN_BITS, MAX_BITS] the hash carries no information.
export const MAX_BITS = 58;

// Both fingerprints resize with fastShrinkOnLoad disabled. sharp normally lets libjpeg shrink during
// decode, which is a different resampling path from the one every other format takes — so the SAME
// picture saved as JPEG and as WebP hashed 12 apart, most of the match budget spent on nothing but a
// re-encode. Discord re-serves uploads as WebP, so that gap was real. One resampler closes it to 5.
const RESIZE = { fit: 'fill', fastShrinkOnLoad: false };

// 9x8 greyscale row-wise "brighter than right neighbour" perceptual hash -> 64-bit BigInt.
async function dHashOf(image) {
    const { data, info } = await image.clone().greyscale().resize(9, 8, RESIZE)
        .raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels || 1;
    const px = (r, c) => data[(r * 9 + c) * ch];
    let hash = 0n, bit = 0n;
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            if (px(r, c) > px(r, c + 1)) hash |= (1n << bit);
            bit++;
        }
    }
    return hash;
}

// 4x4 grid of RGB means. Alpha is flattened onto black first so a transparent PNG and the same
// artwork on a black background do not read as different images.
async function colourSigOf(image) {
    const { data, info } = await image.clone().flatten({ background: '#000000' })
        .resize(4, 4, RESIZE).raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels || 3;
    const sig = new Uint8Array(48);
    for (let i = 0; i < 16; i++) {
        sig[i * 3] = data[i * ch];
        sig[i * 3 + 1] = data[i * ch + 1];
        sig[i * 3 + 2] = data[i * ch + 2];
    }
    return sig;
}

export function popcount(hash) {
    let x = hash, n = 0;
    while (x) { n += Number(x & 1n); x >>= 1n; }
    return n;
}

export function hamming(a, b) {
    let x = a ^ b, count = 0;
    while (x) { count += Number(x & 1n); x >>= 1n; }
    return count;
}

/** Mean absolute per-channel difference, 0-255. */
export function colourDistance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
}

export const sigToHex = sig => Buffer.from(sig).toString('hex');
export const sigFromHex = hex => new Uint8Array(Buffer.from(hex, 'hex'));

/**
 * Both fingerprints plus the informativeness check, from one decode of the buffer.
 * @returns {Promise<{dhash: bigint, bitsSet: number, colourSig: Uint8Array, usable: boolean}>}
 */
export async function fingerprint(buffer) {
    const image = sharp(buffer, { failOn: 'none' });
    const [dhash, colourSig] = await Promise.all([dHashOf(image), colourSigOf(image)]);
    const bitsSet = popcount(dhash);
    return { dhash, bitsSet, colourSig, usable: bitsSet >= MIN_BITS && bitsSet <= MAX_BITS };
}

/* ────────────────────────── avatars (core/avatar-protection.js) ──────────────────────────
 *
 * The same two signals at a finer grain, for avatar protection, which needs a SCORE rather than a
 * yes/no and has to survive a re-upload, a round screenshot, a small zoom and a mirror. The scoring,
 * the thresholds and the measurements behind them are in core/avatar-match-logic.js.
 *
 *   variants   256-bit dHash (17x16 greyscale) + the 4x4 RGB grid, for the full frame, zoomed 6%, 3%,
 *              9% and 12%, mirrored and mirrored zoomed 6% (VARIANT_LABELS: a member's avatar is
 *              compared by its first two). Alpha is flattened onto black, as for colourSigOf.
 *   canonical  16x16 RGBA of the ORIGINAL (alpha kept), for the exact scam-avatar hash.
 *   legacy     the blocklist's own 64-bit fingerprint, which blocked_images stores for every row.
 *   thumb      a 96px WebP data URI, so the dashboard can show the image after the avatar is gone.
 */
export const AVATAR_PX = 128;
// [zoom, mirrored] per variant, in VARIANT_LABELS order (core/avatar-match-logic.js).
const AVATAR_VARIANTS = [[0, false], [0.06, false], [0.03, false], [0.09, false], [0.12, false], [0, true], [0.06, true]];

async function avatarVariantOf(rgb, size, crop, mirror) {
    const p = Math.round(size * crop);
    let img = sharp(rgb, { raw: { width: size, height: size, channels: 3 } });
    if (mirror) img = sharp(await img.flop().raw().toBuffer(), { raw: { width: size, height: size, channels: 3 } });
    if (p) img = sharp(await img.extract({ left: p, top: p, width: size - 2 * p, height: size - 2 * p }).raw().toBuffer(),
        { raw: { width: size - 2 * p, height: size - 2 * p, channels: 3 } });
    const [grey, colour] = await Promise.all([
        img.clone().greyscale().resize(17, 16, RESIZE).raw().toBuffer({ resolveWithObject: true }),
        img.clone().resize(4, 4, RESIZE).raw().toBuffer({ resolveWithObject: true }),
    ]);
    const gch = grey.info.channels || 1;
    const g = (r, c) => grey.data[(r * 17 + c) * gch];
    const d = new Uint32Array(8);
    let sum = 0, sq = 0, i = 0;
    for (let r = 0; r < 16; r++) {
        for (let c = 0; c < 17; c++) { const v = g(r, c); sum += v; sq += v * v; }
        for (let c = 0; c < 16; c++, i++) if (g(r, c) > g(r, c + 1)) d[i >> 5] |= (1 << (i & 31));
    }
    const n = 16 * 17;
    const contrast = Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2));
    const cch = colour.info.channels || 3;
    const c = new Uint8Array(48);
    for (let k = 0; k < 16; k++) {
        c[k * 3] = colour.data[k * cch];
        c[k * 3 + 1] = colour.data[k * cch + 1];
        c[k * 3 + 2] = colour.data[k * cch + 2];
    }
    return { d, c, contrast };
}

/**
 * Everything avatar protection needs from one image, from one download.
 * @returns {Promise<{ variants: Array<{d:Uint32Array,c:Uint8Array}>, bits:number, contrast:number,
 *          canonical: Buffer, legacy: { dhash:bigint, bitsSet:number, colourSig:Uint8Array }, thumb: string }>}
 */
export async function avatarFingerprint(buffer) {
    const src = sharp(buffer, { failOn: 'none' });
    const size = AVATAR_PX;
    const [rgb, canonical, thumb, legacy] = await Promise.all([
        src.clone().flatten({ background: '#000000' }).resize(size, size, RESIZE).removeAlpha().raw().toBuffer(),
        src.clone().ensureAlpha().resize(16, 16, RESIZE).raw().toBuffer(),
        src.clone().resize(96, 96, { fit: 'cover' }).webp({ quality: 70 }).toBuffer(),
        fingerprint(buffer),
    ]);
    const variants = [];
    for (const [crop, mirror] of AVATAR_VARIANTS) {
        variants.push(await avatarVariantOf(rgb, size, crop, mirror));
    }
    let bits = 0;
    for (const word of variants[0].d) { let v = word >>> 0; while (v) { bits += v & 1; v >>>= 1; } }
    return {
        variants: variants.map(({ d, c }) => ({ d, c })),
        bits,
        contrast: variants[0].contrast,
        canonical,
        legacy: { dhash: legacy.dhash, bitsSet: legacy.bitsSet, colourSig: legacy.colourSig },
        thumb: `data:image/webp;base64,${thumb.toString('base64')}`,
    };
}

/**
 * Does this fingerprint match a blocklist entry? Both signals must agree, and both sides must carry
 * a usable (non-degenerate) hash.
 * @returns {{id:number,label:string,distance:number,colour:number}|null}
 */
export function matchEntry(fp, entries) {
    if (!fp?.usable) return null;
    for (const entry of entries) {
        if (entry.bitsSet < MIN_BITS || entry.bitsSet > MAX_BITS) continue;
        const distance = hamming(fp.dhash, entry.dhash);
        if (distance > DHASH_MATCH) continue;
        const colour = colourDistance(fp.colourSig, entry.colourSig);
        if (colour > COLOUR_MATCH) continue;
        return { id: entry.id, label: entry.label, distance, colour };
    }
    return null;
}
