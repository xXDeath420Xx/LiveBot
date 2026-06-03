/**
 * Scam-image OCR helper.
 *
 * extractImageText(attachments) downloads image attachments, preprocesses them
 * with sharp (the inputs are photos of screens — glare/angle — so grayscale +
 * normalize + a bounded resize materially improves OCR), and runs tesseract.js
 * through a lazy SINGLETON worker guarded by an async mutex (one OCR job at a
 * time -> bounded memory). Per-image timeout. FAILS OPEN: any error/timeout ->
 * '' so the message pipeline never throws or stalls.
 */
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import logger from '../utils/logger.js';

const MAX_IMAGES = 2;
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const OCR_TIMEOUT_MS = 8_000; // per-image cap (matches design spec)

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
 * @param {Iterable<{contentType?: string, size?: number, url: string}>} attachments
 * @returns {Promise<string>} concatenated OCR text ('' on any failure)
 */
export async function extractImageText(attachments) {
    const images = [...attachments]
        .filter(a => a.contentType?.startsWith('image/'))
        .filter(a => !a.size || a.size <= MAX_BYTES)
        .slice(0, MAX_IMAGES);
    if (images.length === 0) return '';

    const texts = [];
    for (const att of images) {
        try {
            const res = await fetch(att.url);
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > MAX_BYTES) continue;
            const text = await runExclusive(() => withTimeout(ocrOneBuffer(buf), OCR_TIMEOUT_MS, 'ocr'));
            if (text) texts.push(text);
        } catch (err) {
            logger.warn('[ScamImageOCR] OCR failed for attachment', { url: att.url, error: err.message });
        }
    }
    return texts.join('\n');
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
