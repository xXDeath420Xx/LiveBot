/**
 * Versioned <link> tags for pages built as strings and rendered through the shared site frame
 * (services/site-frame.js). The view engine adds ?v=<content hash> to stylesheet references in
 * template source; markup handed to the frame as headHtml is not template source, so pages call
 * stylesheetTag() instead and get the same cache-busting URL (Cloudflare caches /css by URL).
 *
 * The hash is re-read when the file's mtime changes, so a CSS-only deploy
 * (scripts/reload-dashboard.mjs) gets a new URL without a restart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileHash } from './view-engine.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const memo = new Map();   // href -> { mtime, v }

/** '/css/x.css' -> '/css/x.css?v=<hash>' (unchanged when the file is missing). */
export function assetHref(href) {
    const file = path.resolve(PUBLIC_DIR, '.' + href);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return href;
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return href; }
    const hit = memo.get(href);
    if (hit && hit.mtime === mtime) return hit.v ? `${href}?v=${hit.v}` : href;
    const v = fileHash(PUBLIC_DIR, href);
    memo.set(href, { mtime, v });
    return v ? `${href}?v=${v}` : href;
}

/** <link rel="stylesheet"> for a file under dashboard/public. */
export function stylesheetTag(href) {
    return `<link rel="stylesheet" href="${assetHref(href)}">`;
}

export default { assetHref, stylesheetTag };
