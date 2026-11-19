/*
 * Downloads: CertiFried Studio (the stream bot's Windows app, docs/superpowers/specs/2026-11-19-stream-bot-design.md §5).
 *
 *   GET /downloads/studio          the download page (public, site frame, Dark/Light/Sand)
 *   GET /downloads/studio/:file    the files themselves, and the auto-update feed electron-updater reads
 *                                  (generic provider, https://certifriedmultitool.com/downloads/studio/latest.yml)
 *
 * Files live outside git in STUDIO_DOWNLOADS_DIR (default /home/death/certifried-downloads/studio). Only names on
 * the whitelist below are served: latest.yml, SHA256SUMS.txt, CertiFried-Studio-Setup-<semver>.exe (+ .blockmap)
 * and CertiFried-Studio-Portable-<semver>.exe. Nothing from the request reaches the file system except a name
 * that matched the whitelist.
 *
 * The page reads the version and release date from latest.yml and the SHA-256 of each build from SHA256SUMS.txt
 * (`<sha256>  <file name>` per line); when that file is missing it hashes the builds itself, cached by size and
 * modification time.
 *
 * Tested in tests/stream-bot-studio-downloads.test.js.
 */
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import logger from '../../utils/logger.js';

const router = express.Router();
export const DEFAULT_DOWNLOADS_DIR = '/home/death/certifried-downloads/studio';
export const downloadsDir = () => path.resolve(process.env.STUDIO_DOWNLOADS_DIR || DEFAULT_DOWNLOADS_DIR);

const SEMVER = '\\d{1,4}\\.\\d{1,4}\\.\\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?';
const FILES = [
    { re: /^latest\.yml$/, type: 'text/yaml; charset=utf-8', noCache: true },
    { re: /^SHA256SUMS\.txt$/, type: 'text/plain; charset=utf-8', noCache: true },
    { re: new RegExp(`^CertiFried-Studio-Setup-${SEMVER}\\.exe$`), type: 'application/vnd.microsoft.portable-executable', download: true },
    { re: new RegExp(`^CertiFried-Studio-Setup-${SEMVER}\\.exe\\.blockmap$`), type: 'application/octet-stream' },
    { re: new RegExp(`^CertiFried-Studio-Portable-${SEMVER}\\.exe$`), type: 'application/vnd.microsoft.portable-executable', download: true },
];

/** The whitelist entry for a requested name, or null. */
export function allowedFile(name) {
    if (typeof name !== 'string' || name.length > 120) return null;
    return FILES.find((f) => f.re.test(name)) || null;
}

/** version and releaseDate from electron-builder's latest.yml (top-level keys only; no YAML library needed). */
export function parseLatestYml(text) {
    const out = { version: null, releaseDate: null, path: null };
    for (const line of String(text || '').split(/\r?\n/)) {
        const m = line.match(/^(version|releaseDate|path):\s*['"]?([^'"]*)['"]?\s*$/);
        if (m) out[m[1]] = m[2].trim();
    }
    if (out.version && !new RegExp(`^${SEMVER}$`).test(out.version)) out.version = null;
    return out;
}

/** `<sha256>  <name>` lines → Map(name → sha256). */
export function parseSums(text) {
    const map = new Map();
    for (const line of String(text || '').split(/\r?\n/)) {
        const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/);
        if (m) map.set(m[2], m[1].toLowerCase());
    }
    return map;
}

const hashCache = new Map();   // file path -> { key, sha256 }
async function sha256Of(file, st) {
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = hashCache.get(file);
    if (hit && hit.key === key) return hit.sha256;
    const sha256 = await new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
    });
    hashCache.set(file, { key, sha256 });
    return sha256;
}

/** What the page shows: { version, releaseDate, builds: [{ kind, label, file, size, sha256 }], sums } or null when nothing is published. */
export async function release(dir = downloadsDir()) {
    let latest;
    try { latest = parseLatestYml(await fsp.readFile(path.join(dir, 'latest.yml'), 'utf8')); } catch { return null; }
    if (!latest.version) return null;
    let sums = new Map();
    let hasSums = false;
    try { sums = parseSums(await fsp.readFile(path.join(dir, 'SHA256SUMS.txt'), 'utf8')); hasSums = true; } catch { /* hash the files instead */ }
    const builds = [];
    for (const [kind, label, name] of [
        ['setup', 'Installer', `CertiFried-Studio-Setup-${latest.version}.exe`],
        ['portable', 'Portable (no install)', `CertiFried-Studio-Portable-${latest.version}.exe`],
    ]) {
        const file = path.join(dir, name);
        let st;
        try { st = await fsp.stat(file); } catch { continue; }
        if (!st.isFile()) continue;
        let sha256 = sums.get(name) || null;
        if (!sha256) { try { sha256 = await sha256Of(file, st); } catch { sha256 = null; } }
        builds.push({ kind, label, file: name, size: st.size, sha256 });
    }
    if (!builds.length) return null;
    return { version: latest.version, releaseDate: latest.releaseDate ? new Date(latest.releaseDate).toISOString() : null, builds, sums: hasSums };
}

router.get('/downloads/studio', async (req, res) => {
    let rel = null;
    try { rel = await release(); } catch (err) { logger.warn('[Downloads] could not read the Studio release', { error: err?.message }); }
    res.render('studio-download', { user: req.user || null, release: rel });
});

router.get('/downloads/studio/:file', (req, res) => {
    const name = String(req.params.file || '');
    const entry = allowedFile(name);
    if (!entry) return res.status(404).type('text/plain').send('Not found');
    const dir = downloadsDir();
    const file = path.join(dir, name);
    if (path.dirname(file) !== dir) return res.status(404).type('text/plain').send('Not found');
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.status(404).type('text/plain').send('Not found'); return; }
        res.status(200).set({
            'Content-Type': entry.type, 'Content-Length': String(st.size), 'X-Content-Type-Options': 'nosniff',
            'Cache-Control': entry.noCache ? 'no-cache' : 'public, max-age=3600',
            ...(entry.download ? { 'Content-Disposition': `attachment; filename="${name}"` } : {}),
        });
        if (req.method === 'HEAD') { res.end(); return; }
        const stream = fs.createReadStream(file);
        stream.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
        stream.pipe(res);
    });
    return undefined;
});

export default router;
