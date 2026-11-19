/**
 * Scam-image OCR helper.
 *
 * extractImageText(attachments) downloads image attachments, preprocesses them
 * with sharp (the inputs are photos of screens — glare/angle — so grayscale +
 * normalize + a bounded resize materially improves OCR), and runs tesseract.js
 * through a lazy SINGLETON worker guarded by an async mutex (one OCR job at a
 * time -> bounded memory). Per-image timeout. FAILS OPEN: any error/timeout ->
 * '' so the message pipeline never throws or stalls.
 *
 * Three things here are shaped by the 2026-09-13 wave that got through (see
 * core/message-images.js for the full account):
 *
 *  - Which attachments are images is NOT decided here any more. It is decided by
 *    isImageAttachment, off pixels-or-filename rather than a poster-supplied
 *    content type.
 *
 *  - A declared size over the cap used to remove an image from the scan set
 *    entirely, so an oversized screenshot was scanned less carefully than a small
 *    one. Now the DOWNLOAD is capped instead: too big to read is reported, not
 *    silently treated as innocent.
 *
 *  - OCR text is cached on the SHA-256 of the decoded bytes. The wave was the same
 *    four pictures posted nine times; at ~2s per image, scanning each copy would
 *    have queued a minute of OCR behind the first message while the spam kept
 *    landing. Keyed on the bytes, not on a filename or a URL, so a cache hit is
 *    the same image by definition.
 *
 * scanImages() (message threats, migration 327) reads each image ONCE for every image check of the
 * message: OCR text (phishing genre classifier, per-guild image-text rules) and QR codes (decoded URLs go
 * through the phishing / link checks; strict mode removes any QR image). The bytes come from the shared
 * download in core/message-images.js, which the scam-image blocklist uses too.
 *
 * QR decoding uses the `jsqr` package (pure JS, no native parts) on the raw pixels sharp already gives
 * us. It is loaded lazily: until `jsqr` is installed qrDecoderAvailable() is false, scans report
 * `qr.available: false`, and the dashboard says so. Nothing is sent to a third-party decoder.
 */
import crypto from 'crypto';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import logger from '../utils/logger.js';
import { isImageAttachment, fetchImageBytes } from './message-images.js';

const MAX_IMAGES = 4;               // Scam posts in this family carry four screenshots.
const MAX_BYTES = 16 * 1024 * 1024; // Hard download ceiling (memory), not a "looks innocent" test.
const OCR_TIMEOUT_MS = 8_000;       // per-image cap (matches design spec)
const FETCH_TIMEOUT_MS = 8_000;     // node fetch has no default timeout; a hung CDN must not wedge
                                    // the caller, which is awaited inline in messageCreate.
const TEXT_CACHE_TTL_MS = 10 * 60 * 1000;
const TEXT_CACHE_MAX = 500;

let workerPromise = null;
async function getWorker() {
    if (!workerPromise) {
        workerPromise = createWorker('eng').catch(err => {
            workerPromise = null; // allow retry on next call
            throw err;
        });
    }
    return workerPromise;
}

// Serialize OCR jobs: chain every call onto the previous so only one runs at once.
let queue = Promise.resolve();
function runExclusive(fn) {
    const result = queue.then(fn, fn);
    queue = result.then(() => {}, () => {});
    return result;
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timeout after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ───────────────────────────── OCR text cache ───────────────────────────── */

const textCache = new Map(); // sha256 -> { text, at }

function cacheGet(key) {
    const hit = textCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > TEXT_CACHE_TTL_MS) { textCache.delete(key); return null; }
    // Refresh insertion order so the eviction below is least-recently-used.
    textCache.delete(key);
    textCache.set(key, hit);
    return hit;
}

function cacheSet(key, text) {
    if (textCache.size >= TEXT_CACHE_MAX) {
        const oldest = textCache.keys().next().value;
        if (oldest !== undefined) textCache.delete(oldest);
    }
    textCache.set(key, { text, at: Date.now() });
}

/** Exposed for tests and for a clean shutdown. */
export function clearOcrTextCache() { textCache.clear(); }

/* ───────────────────────────── download + OCR ───────────────────────────── */

// The download is shared with the scam-image blocklist (core/message-images.js); the byte ceiling is
// still ours, enforced on the bytes actually received.
function download(url) {
    return fetchImageBytes(url, { maxBytes: MAX_BYTES, timeoutMs: FETCH_TIMEOUT_MS });
}

/* ───────────────────────────── QR codes ───────────────────────────── */

const QR_MAX_SIDE = 800;            // jsQR is synchronous: bound the pixels it walks
const QR_MAX_PER_IMAGE = 3;
const qrCache = new Map();          // sha256 -> { payloads, at }

let jsqrPromise = null;
function loadJsQr() {
    if (!jsqrPromise) {
        jsqrPromise = import('jsqr')
            .then(m => (typeof m.default === 'function' ? m.default : (typeof m === 'function' ? m : null)))
            .catch(() => null);
    }
    return jsqrPromise;
}

/** Is a QR decoder installed? (`jsqr`; see the header.) */
export async function qrDecoderAvailable() {
    return !!(await loadJsQr());
}

/**
 * Decode the QR codes in one image. jsQR finds one code per pass, so a found code is painted over and
 * the image searched again (up to QR_MAX_PER_IMAGE codes).
 * @returns {Promise<string[]>} payloads ([] when none)
 */
async function decodeQrBuffer(buf, decode) {
    const { data, info } = await sharp(buf, { animated: false })
        .resize(QR_MAX_SIDE, QR_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
    const payloads = [];
    for (let pass = 0; pass < QR_MAX_PER_IMAGE; pass++) {
        const hit = decode(pixels, info.width, info.height, { inversionAttempts: 'attemptBoth' });
        if (!hit || typeof hit.data !== 'string') break;
        payloads.push(hit.data);
        const loc = hit.location;
        if (!loc) break;
        const xs = [loc.topLeftCorner.x, loc.topRightCorner.x, loc.bottomLeftCorner.x, loc.bottomRightCorner.x];
        const ys = [loc.topLeftCorner.y, loc.topRightCorner.y, loc.bottomLeftCorner.y, loc.bottomRightCorner.y];
        const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 4);
        const x1 = Math.min(info.width - 1, Math.ceil(Math.max(...xs)) + 4);
        const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 4);
        const y1 = Math.min(info.height - 1, Math.ceil(Math.max(...ys)) + 4);
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const i = (y * info.width + x) * 4;
                pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255;
            }
        }
    }
    return payloads;
}

async function ocrOneBuffer(buffer) {
    const pre = await sharp(buffer)
        .grayscale()
        .resize(1400, 1400, { fit: 'inside', withoutEnlargement: false })
        .normalize()
        .png()
        .toBuffer();
    const worker = await getWorker();
    const { data } = await worker.recognize(pre);
    return (data?.text || '').trim();
}

/**
 * Read every image of a message once: OCR text and/or QR codes.
 * @param {Iterable<object>} attachments
 * @param {{ ocr?: boolean, qr?: boolean, qrDecoder?: Function }} [opts]  qrDecoder: injected for tests
 * @returns {Promise<{ text:string, qr:{ available:boolean, codes:number, payloads:string[] }, images:number, failures:number }>}
 */
export async function scanImages(attachments, { ocr = true, qr = false, qrDecoder = null } = {}) {
    const all = [...attachments].filter(isImageAttachment);
    const images = all.slice(0, MAX_IMAGES);
    const decode = qr ? (qrDecoder || await loadJsQr()) : null;
    const out = { text: '', qr: { available: !!decode, codes: 0, payloads: [] }, images: images.length, failures: 0 };
    if (images.length === 0 || (!ocr && !decode)) return out;

    const texts = [];
    let failures = 0;
    for (const att of images) {
        let buf;
        try {
            buf = await download(att.url);
        } catch (err) {
            failures++;
            logger.warn('[ScamImageOCR] could not download attachment', {
                url: att.url, name: att.name, size: att.size, error: err.message,
            });
            continue;
        }
        const key = crypto.createHash('sha256').update(buf).digest('hex');

        if (decode) {
            try {
                const hit = qrCache.get(key);
                let payloads;
                if (hit && Date.now() - hit.at < TEXT_CACHE_TTL_MS) payloads = hit.payloads;
                else {
                    payloads = await decodeQrBuffer(buf, decode);
                    if (qrCache.size >= TEXT_CACHE_MAX) qrCache.delete(qrCache.keys().next().value);
                    qrCache.set(key, { payloads, at: Date.now() });
                }
                out.qr.codes += payloads.length;
                out.qr.payloads.push(...payloads);
            } catch (err) {
                logger.warn('[ScamImageOCR] QR decode failed for attachment', { name: att.name, error: err.message });
            }
        }

        if (!ocr) continue;
        try {
            const cached = cacheGet(key);
            if (cached) {
                if (cached.text) texts.push(cached.text);
                continue;
            }

            const text = await runExclusive(() => withTimeout(ocrOneBuffer(buf), OCR_TIMEOUT_MS, 'ocr'));
            cacheSet(key, text);
            if (text) texts.push(text);
        } catch (err) {
            failures++;
            logger.warn('[ScamImageOCR] OCR failed for attachment', {
                url: att.url, name: att.name, size: att.size, error: err.message,
            });
        }
    }

    // The silent skip is what let the 2026-09-13 wave through: images present, nothing scanned,
    // nothing logged, and no way afterwards to tell whether the filter had looked at all. If every
    // image in a post failed, say so — it is the difference between "scanned, clean" and "blind".
    if (ocr && !texts.length && failures === images.length) {
        logger.warn('[ScamImageOCR] no image in this post could be scanned', {
            images: images.length, skipped: all.length - images.length,
        });
    }

    out.failures = failures;
    out.text = texts.join('\n');
    return out;
}

/**
 * @param {Iterable<{contentType?: string, name?: string, size?: number, width?: number, height?: number, url: string}>} attachments
 * @returns {Promise<string>} concatenated OCR text ('' on any failure)
 */
export async function extractImageText(attachments) {
    return (await scanImages(attachments, { ocr: true, qr: false })).text;
}

/** Gracefully terminate the OCR worker (optional shutdown wiring). */
export async function terminateScamOcrWorker() {
    if (!workerPromise) return;
    try {
        const worker = await workerPromise;
        await worker.terminate();
    } catch { /* ignore */ }
    workerPromise = null;
}
