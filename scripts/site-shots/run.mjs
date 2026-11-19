#!/usr/bin/env node
/**
 * Screenshots for the website's guides (/docs/guides), taken from the REAL dashboard templates and the
 * bot's own image renderers, filled with Maple Hollow: an invented server with invented members
 * (scripts/site-shots/demo-data.mjs). No real person's data can end up in a picture: nothing here
 * reads the database (stubs/hooks.mjs swaps the pool and the logger out) or calls Discord.
 *
 *   node scripts/site-shots/run.mjs [--only id,id] [--out DIR] [--contact-sheet FILE.png] [--list]
 *
 * For each shot in shots.mjs it renders the page (a manage page through manage-tailwind.ejs, a public
 * page, or a Discord message drawn by /js/cf-msgpreview.js), serves it with dashboard/public on a
 * throwaway 127.0.0.1 port, captures it in headless Chrome (the repo's puppeteer) and writes a WebP
 * (or PNG, when the shot asks for one) to dashboard/public/img/guides/, then rewrites manifest.json
 * there: { images: [{ id, file, alt, width, height, guides }] }. --only re-takes some shots and keeps
 * the other manifest entries. Exit 0 = every shot written, 1 = a shot failed, 2 = could not run.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mergeManifest, strayFiles } from './manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
register(pathToFileURL(path.join(HERE, 'stubs/hooks.mjs')).href, { data: { root: ROOT } });

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const OUT = path.resolve(opt('out', path.join(ROOT, 'dashboard/public/img/guides')));
const ONLY = opt('only') ? opt('only').split(',').map((s) => s.trim()).filter(Boolean) : null;
const SHEET = opt('contact-sheet');
const THUMB_W = 480;
const VIEWS = path.join(ROOT, 'dashboard/views');
const PUBLIC = path.join(ROOT, 'dashboard/public');
const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.gif': 'image/gif' };
const SOCKET_STUB = 'window.io=function(){var s={on:function(){return s},off:function(){return s},once:function(){return s},emit:function(){return s},connect:function(){return s},disconnect:function(){return s},connected:false};return s};';

async function main() {
    const sharp = (await import('sharp')).default;
    const puppeteer = (await import('puppeteer')).default;
    const { buildShots } = await import('./shots.mjs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-shots-'));
    const ctx = await buildShots({ root: ROOT, views: VIEWS, publicDir: PUBLIC, tmp });
    let shots = ctx.shots;
    if (args.includes('--list')) {
        for (const s of shots) console.log(`${s.id.padEnd(28)} ${s.kind.padEnd(8)} ${s.guides.join(',')}`);
        return 0;
    }
    if (ONLY) {
        const unknown = ONLY.filter((id) => !shots.some((s) => s.id === id));
        if (unknown.length) throw new Error(`unknown shot id(s): ${unknown.join(', ')}`);
        shots = shots.filter((s) => ONLY.includes(s.id));
    }
    const byId = new Map(shots.map((s) => [s.id, s]));

    // ── local server: rendered shots, dashboard/public, demo assets, API stubs ──
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        try {
            const m = url.pathname.match(/^\/__shot\/([a-z0-9-]+)$/);
            if (m && byId.has(m[1])) {
                const html = await byId.get(m[1]).html();
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                return res.end(html);
            }
            if (url.pathname === '/socket.io/socket.io.js') {
                res.writeHead(200, { 'content-type': 'text/javascript' });
                return res.end(SOCKET_STUB);
            }
            const stub = ctx.api ? ctx.api(url.pathname, req) : null;
            if (stub) {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify(stub));
            }
            const demo = url.pathname.match(/^\/__demo\/([\w.-]+)$/);
            const file = demo ? path.join(tmp, demo[1]) : path.resolve(PUBLIC, '.' + decodeURIComponent(url.pathname));
            const okRoot = demo ? tmp : PUBLIC;
            if (file.startsWith(okRoot + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
                return fs.createReadStream(file).pipe(res);
            }
            res.writeHead(url.pathname.startsWith('/api/') ? 503 : 404, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'site-shots stub server' }));
        } catch (error) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            return res.end(`render failed: ${error.stack || error.message}`);
        }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    ctx.setBase?.(base);

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars', '--font-render-hinting=none'],
        userDataDir: path.join(tmp, 'profile'),
    });
    const failures = [];
    const written = [];
    fs.mkdirSync(OUT, { recursive: true });
    try {
        for (const s of shots) {
            const page = await browser.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            try {
                // Anything a page asks the outside world for that is not a font, icon or style sheet
                // (avatars on Discord's CDN, embeds) is refused, so nothing real can be pulled in.
                await page.setRequestInterception(true);
                page.on('request', (r) => {
                    const u = r.url();
                    if (u.startsWith(base) || u.startsWith('data:')) return r.continue();
                    if (/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//.test(u)) return r.continue();
                    if (/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/\d\.png/.test(u)) return r.respond({ status: 200, contentType: 'image/png', body: fs.readFileSync(ctx.avatars.juniper) });
                    return r.abort();
                });
                await page.setViewport({ width: s.width, height: s.height, deviceScaleFactor: s.dpr || 1 });
                await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
                await page.goto(`${base}/__shot/${s.id}`, { waitUntil: 'networkidle0', timeout: 45000 });
                await page.evaluate(() => document.fonts && document.fonts.ready);
                // No caret, no animation, no transition half-way.
                await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}' });
                if (s.prepare) await page.evaluate(s.prepare.fn, s.prepare.arg ?? null);
                await new Promise((r) => setTimeout(r, s.settle ?? 250));
                let buf;
                if (s.clip) {
                    const el = await page.$(s.clip);
                    if (!el) throw new Error(`no element matches ${s.clip}`);
                    buf = await el.screenshot({ type: 'png' });
                } else {
                    buf = await page.screenshot({ type: 'png', fullPage: false });
                }
                if (errors.length) console.warn(`  ${s.id}: page error(s): ${errors.slice(0, 3).join(' | ')}`);
                const img = sharp(buf);
                const meta = await img.metadata();
                const targetW = s.outWidth || meta.width;
                const pipeline = targetW < meta.width ? img.resize({ width: targetW }) : img;
                const ext = s.format === 'png' ? 'png' : 'webp';
                const file = `${s.id}.${ext}`;
                const out = ext === 'png'
                    ? await pipeline.png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer({ resolveWithObject: true })
                    : await pipeline.webp({ quality: s.quality || 80, effort: 6 }).toBuffer({ resolveWithObject: true });
                fs.writeFileSync(path.join(OUT, file), out.data);
                // A 480 px copy for cards and the docs overview, so small places never load the full picture.
                const thumbFile = `${s.id}.thumb.webp`;
                const thumb = await sharp(out.data).resize({ width: Math.min(THUMB_W, out.info.width) }).webp({ quality: 78, effort: 6 }).toBuffer({ resolveWithObject: true });
                fs.writeFileSync(path.join(OUT, thumbFile), thumb.data);
                written.push({ id: s.id, file, alt: s.alt, width: out.info.width, height: out.info.height, guides: s.guides,
                    thumb: { file: thumbFile, width: thumb.info.width, height: thumb.info.height }, bytes: out.data.length + thumb.data.length });
                console.log(`  ${file.padEnd(34)} ${String(out.info.width).padStart(5)}x${String(out.info.height).padEnd(5)} ${(out.data.length / 1024).toFixed(0).padStart(4)} KB`);
            } catch (error) {
                failures.push(`${s.id}: ${error.message}`);
                console.error(`  ${s.id}: FAILED ${error.message}`);
            } finally {
                await page.close().catch(() => {});
            }
        }
    } finally {
        await browser.close().catch(() => {});
        server.close();
    }

    // manifest.json: entries for shots not re-taken this run are kept when their file still exists.
    const manifestFile = path.join(OUT, 'manifest.json');
    let previous = [];
    try { previous = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).images || []; } catch { /* first run */ }
    // Which entries stay and which files may go: scripts/site-shots/manifest.mjs (H-752). Images made outside scenes.mjs
    // are marked `external: true` in the manifest and always kept; an --only run deletes only files it replaced.
    const fresh = written.map(({ bytes, ...rest }) => rest);
    const images = mergeManifest({ previous, written: fresh, sceneIds: ctx.shots.map((s) => s.id), only: ONLY, exists: (f) => fs.existsSync(path.join(OUT, f)) });
    fs.writeFileSync(manifestFile, JSON.stringify({
        _about: 'Guide screenshots from scripts/site-shots/run.mjs (invented demo server "Maple Hollow"; no real data). Regenerate with: node scripts/site-shots/run.mjs',
        generated: new Date().toISOString().slice(0, 10),
        images,
    }, null, 1) + '\n');
    // Files in OUT that no kept entry owns are removed on a full run, so the folder never collects strays.
    for (const f of strayFiles({ files: fs.readdirSync(OUT), images, previous, written: fresh, only: ONLY })) fs.rmSync(path.join(OUT, f));
    const total = images.reduce((n, i) => n + fs.statSync(path.join(OUT, i.file)).size + (i.thumb ? fs.statSync(path.join(OUT, i.thumb.file)).size : 0), 0);
    console.log(`${images.length} image(s) in ${path.relative(ROOT, OUT)}, ${(total / 1024 / 1024).toFixed(2)} MB`);

    if (SHEET) await contactSheet(sharp, images, SHEET);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (failures.length) {
        console.error(`${failures.length} shot(s) failed:\n  ${failures.join('\n  ')}`);
        return 1;
    }
    return 0;
}

/** Every image on one sheet with its id under it, for reviewing a run. */
async function contactSheet(sharp, images, file) {
    const COLS = 4, CELL = 420, PAD = 16, LABEL = 28;
    const rows = Math.ceil(images.length / COLS);
    const cells = [];
    for (const [i, im] of images.entries()) {
        const thumb = await sharp(path.join(OUT, im.file)).resize({ width: CELL, height: CELL - LABEL, fit: 'inside', background: '#0b0d10' }).png().toBuffer({ resolveWithObject: true });
        const x = PAD + (i % COLS) * (CELL + PAD), y = PAD + Math.floor(i / COLS) * (CELL + PAD);
        cells.push({ input: thumb.data, left: x + Math.round((CELL - thumb.info.width) / 2), top: y });
        const label = Buffer.from(`<svg width="${CELL}" height="${LABEL}" xmlns="http://www.w3.org/2000/svg"><text x="0" y="20" font-family="DejaVu Sans, sans-serif" font-size="15" fill="#e5e7eb">${im.file} (${im.width}x${im.height})</text></svg>`);
        cells.push({ input: label, left: x, top: y + CELL - LABEL });
    }
    await sharp({ create: { width: PAD + COLS * (CELL + PAD), height: PAD + rows * (CELL + PAD), channels: 3, background: '#0b0d10' } })
        .composite(cells).png().toFile(file);
    console.log(`contact sheet: ${file}`);
}

main().then((code) => process.exit(code), (error) => {
    console.error(`site-shots could not run: ${error.stack || error.message}`);
    process.exit(2);
});
