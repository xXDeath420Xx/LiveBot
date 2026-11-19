/**
 * Which attachments count as an image, for every content scanner.
 *
 * This exists because of a scam wave in guild 961514092848382043 on 2026-09-13: four screenshots
 * of a fake MrBeast crypto casino, posted into nine channels in twenty-one seconds, untouched by
 * either image scanner. The classifier was not wrong about the pictures — replayed against them it
 * scores seven signal groups and mutes on the first message. It never saw them.
 *
 * Both scanners decided whether an attachment was an image by reading `contentType`, and skipped
 * anything whose declared `size` exceeded their cap. Those are two pieces of metadata the POSTER
 * supplies, they are the first thing anyone evading a filter can alter, and both failure paths
 * returned "not an image" instantly and silently — no log, no row, nothing to find afterwards. A
 * scanner that reads pixels must not be switched off by a header.
 *
 * So: content type OR file extension OR the dimensions Discord only fills in for images it decoded
 * itself. Size is deliberately NOT part of this decision — a picture too big for one scanner's
 * buffer is still a picture, and each scanner caps its own download.
 */

import { effectiveAttachments } from '../utils/message-effective-content.js';

const IMAGE_EXT = /\.(png|jpe?g|jpe|gif|webp|bmp|tiff?|avif|heic|heif|jfif)$/i;

/**
 * @param {{contentType?: string|null, name?: string|null, width?: number|null, height?: number|null}} att
 * @returns {boolean}
 */
export function isImageAttachment(att) {
    if (!att) return false;
    if (typeof att.contentType === 'string' && att.contentType.toLowerCase().startsWith('image/')) return true;
    if (typeof att.name === 'string' && IMAGE_EXT.test(att.name)) return true;
    // Discord reports width/height only for attachments it decoded as an image, so their presence
    // is its own evidence — and unlike content_type it is not taken from the upload's headers.
    if (Number(att.width) > 0 && Number(att.height) > 0) return true;
    return false;
}

/**
 * @param {{attachments?: {values: () => Iterable<any>}}} message
 * @returns {any[]} the message's image attachments in order, forwarded ones included: a forward carries
 *   its images in message_snapshots and leaves message.attachments empty
 */
export function imageAttachments(message) {
    if (!message?.attachments?.values) return [];
    return effectiveAttachments(message).filter(isImageAttachment);
}

/** True when the message carries at least one image attachment. */
export function hasImageAttachment(message) {
    return imageAttachments(message).length > 0;
}

/*
 * One download per image per message. The scam-image blocklist (core/image-blocklist.js), the OCR / QR
 * scan (core/scam-image-ocr.js) and learning a scam image all need the same bytes within a second or two
 * of each other; each used to fetch the attachment itself. The in-flight promise is shared for a minute,
 * keyed on the URL (Discord attachment URLs are unique per upload). Bounded: a few entries, and buffers
 * over SHARE_MAX_BYTES are handed back but not kept.
 */
const SHARE_TTL_MS = 60_000;
const SHARE_MAX_ENTRIES = 24;
const SHARE_MAX_BYTES = 8 * 1024 * 1024;
const shared = new Map();   // url -> { at, promise }

async function downloadCapped(url, maxBytes, timeoutMs) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Read incrementally so a mislabelled or hostile Content-Length cannot make us buffer more than the
    // ceiling: the bytes decide, not the header.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`too large to scan (${declared} bytes > ${maxBytes})`);
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
        total += chunk.length;
        if (total > maxBytes) throw new Error(`too large to scan (> ${maxBytes} bytes)`);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/**
 * The bytes of an image attachment, downloaded once and shared between scanners.
 * Rejects (does not resolve null) on a failed or oversized download, like the scanners' own fetches did.
 * @param {string} url
 * @param {{ maxBytes?: number, timeoutMs?: number }} [opts] maxBytes caps what THIS caller accepts
 * @returns {Promise<Buffer>}
 */
export async function fetchImageBytes(url, { maxBytes = 16 * 1024 * 1024, timeoutMs = 8000 } = {}) {
    const now = Date.now();
    for (const [key, entry] of shared) if (now - entry.at > SHARE_TTL_MS) shared.delete(key);
    let entry = shared.get(url);
    if (!entry) {
        const promise = downloadCapped(url, 16 * 1024 * 1024, timeoutMs);
        entry = { at: now, promise };
        if (shared.size >= SHARE_MAX_ENTRIES) shared.delete(shared.keys().next().value);
        shared.set(url, entry);
        promise.then(buf => { if (buf.length > SHARE_MAX_BYTES) shared.delete(url); }, () => shared.delete(url));
    }
    const buf = await entry.promise;
    if (buf.length > maxBytes) throw new Error(`too large to scan (${buf.length} bytes > ${maxBytes})`);
    return buf;
}

export default { isImageAttachment, imageAttachments, hasImageAttachment, fetchImageBytes };
