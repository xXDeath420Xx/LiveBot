/*
 * Pure helpers for deleted-image evidence (core/evidence-capture.js). No DB, Discord or fs
 * imports, so they are unit-tested locally.
 */

import path from 'node:path';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']);

/** Extension from a filename or URL path, lower-cased, '' when there is none. */
export function extensionOf(nameOrUrl) {
    const raw = String(nameOrUrl || '');
    let pathname = raw;
    try {
        if (/^https?:\/\//i.test(raw)) pathname = new URL(raw).pathname;
    } catch { /* not a URL — treat as a filename */ }
    const ext = path.extname(pathname.split('?')[0]).toLowerCase();
    return ext.length <= 6 ? ext : '';
}

/**
 * Image attachments are the evidence worth keeping — text is already in message_logs, and
 * video/archives are too large to re-host routinely.
 * @param {{ contentType?: string|null, name?: string|null, url?: string|null }} att
 */
export function isImageAttachment(att) {
    if (!att) return false;
    const type = String(att.contentType ?? att.file_type ?? '').toLowerCase();
    if (type) return type.startsWith('image/');
    return IMAGE_EXTENSIONS.has(extensionOf(att.name ?? att.filename ?? att.url));
}

/** Safe, short filename for re-upload and for the local cache. */
export function sanitizeFilename(name, fallback = 'attachment') {
    const base = String(name || '').split(/[\\/]/).pop() || '';
    const clean = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-100);
    return clean || fallback;
}

/** Filename from a CDN URL path (used when only message_logs.attachment_urls survives). */
export function filenameFromUrl(url) {
    try {
        return sanitizeFilename(decodeURIComponent(new URL(url).pathname.split('/').pop() || ''));
    } catch {
        return 'attachment';
    }
}

/**
 * Discord CDN links are signed: `ex=` is the expiry as hex unix seconds. An expired link is
 * refused by the CDN, so there is no point fetching it.
 */
export function isSignedUrlExpired(url, nowMs = Date.now()) {
    try {
        const ex = new URL(url).searchParams.get('ex');
        if (!ex || !/^[0-9a-f]+$/i.test(ex)) return false;
        return parseInt(ex, 16) * 1000 <= nowMs;
    } catch {
        return false;
    }
}

/** Store a URL in a VARCHAR(500): signed CDN URLs fit; anything longer loses its query string. */
export function trimUrl(url, max = 500) {
    if (!url) return null;
    const s = String(url);
    if (s.length <= max) return s;
    const noQuery = s.split('?')[0];
    return noQuery.length <= max ? noQuery : null;
}

/** Per-message upload limit by server boost tier (bytes), with headroom for the multipart body. */
export function uploadLimitBytes(premiumTier = 0) {
    const mb = { 2: 50, 3: 100 }[Number(premiumTier)] ?? 10;
    return Math.floor(mb * 1024 * 1024 * 0.95);
}

/**
 * Split files into upload batches: at most `maxFiles` per message and `limitBytes` in total.
 * A single file larger than the limit is returned in `tooLarge` rather than sent.
 * @param {Array<{ size: number }>} files
 */
export function packBatches(files, limitBytes, maxFiles = 10) {
    const batches = [];
    const tooLarge = [];
    let current = [];
    let currentBytes = 0;
    for (const f of files) {
        const size = Number(f.size) || 0;
        if (size > limitBytes) { tooLarge.push(f); continue; }
        if (current.length >= maxFiles || currentBytes + size > limitBytes) {
            batches.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(f);
        currentBytes += size;
    }
    if (current.length) batches.push(current);
    return { batches, tooLarge };
}

/**
 * Resolve a cache_path stored in the DB against the cache directory, refusing anything that
 * escapes it. The column is ours, but a path read from a database is not trusted with fs calls.
 */
export function resolveCachePath(baseDir, relative) {
    if (!relative) return null;
    const base = path.resolve(baseDir);
    const full = path.resolve(base, String(relative));
    return full.startsWith(base + path.sep) ? full : null;
}

/** Clamp the per-file evidence size limit (MB) a server configured. */
export function clampMaxMb(value, fallback = 8, max = 25) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.max(Math.floor(n), 1), max);
}
