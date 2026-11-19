#!/usr/bin/env node
/**
 * Theme audit: every page in pages.mjs, in each colour theme, in headless Chrome (the repo's puppeteer),
 * checked with axe-core's color-contrast rule (WCAG AA) plus three checks of our own:
 *
 *   island     a large box whose own background is dark in a light theme (or light in a dark one):
 *              a hard-coded colour the theme did not reach
 *   firstPaint the theme and page background at the first animation frame equal the final ones
 *              (no flash of the wrong theme before the CSS or a script corrects it)
 *   errors     page script errors
 *
 *   node scripts/theme-audit/run.mjs [--themes dark,light,sand] [--only id,id] [--group manage]
 *        [--out DIR] [--sheet FILE.png] [--sheet-ids id,id] [--concurrency 4] [--quiet]
 *
 * Writes DIR/report.json (default /tmp/theme-audit) and prints counts per theme. Pages are the real
 * templates with invented demo data (no database, no Discord); requests to anything but the local
 * server and the font/icon CDNs are refused. Exit 0 always unless it could not run (2); the test
 * (tests/theme-render.test.js) decides what fails.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
register(pathToFileURL(path.join(ROOT, 'scripts/site-shots/stubs/hooks.mjs')).href, { data: { root: ROOT } });

export const AXE_FILE = path.join(HERE, 'vendor/axe.min.js');
const PUBLIC = path.join(ROOT, 'dashboard/public');
const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.gif': 'image/gif', '.html': 'text/html' };
const AVATAR = fs.readFileSync(path.join(PUBLIC, 'images/CertiFried.png'));
const SOCKET_STUB = 'window.io=function(){var s={on:function(){return s},off:function(){return s},once:function(){return s},emit:function(){return s},connect:function(){return s},disconnect:function(){return s},connected:false};return s};';

/** Runs before any page script: notes the theme and background at the first frame. */
const FIRST_FRAME = `(() => {
  try { localStorage.clear(); } catch (e) {}
  requestAnimationFrame(() => {
    const d = document.documentElement, b = document.body;
    window.__firstFrame = { theme: d.getAttribute('data-theme'), bg: getComputedStyle(b || d).backgroundColor };
  });
})();`;

/** In-page: big boxes painted in the other family's colours (dark box in a light theme, or the reverse). */
function findIslands(light) {
    const lum = (c) => {
        const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null;
        const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        const a = p.length > 3 ? p[3] : 1;
        if (a < 0.6) return null;
        // Only neutral greys count: a coloured fill (a brand button, a status pill) is a choice, not a leak.
        if (Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]) > 48) return null;
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
    };
    const out = [];
    const skip = 'img,video,canvas,iframe,svg,picture,.cf-keep-dark,[data-keep-dark],.cf-dc *,.gd-thumb,.docs-fig,.gd-figure,.pic,.style-thumb-dark,.style-thumb-light,.theme-swatch,.colour-swatch,.color-swatch,input[type=color]';
    for (const el of document.querySelectorAll('body *')) {
        if (el.closest(skip)) continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height < 6000 || r.width < 40 || r.height < 20) continue;
        if (r.bottom + window.scrollY < 0 || r.right < 0 || r.left > document.documentElement.scrollWidth) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.5) continue;
        const L = lum(cs.backgroundColor);
        if (L === null) continue;
        if (light ? L < 0.18 : L > 0.6) {
            const sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '');
            out.push({ sel, bg: cs.backgroundColor, w: Math.round(r.width), h: Math.round(r.height) });
        }
    }
    // Only the outermost of nested islands.
    return out.slice(0, 40);
}

export async function audit({ themes = ['dark', 'light', 'sand'], only = null, group = null, concurrency = 4, sheetIds = null, quiet = false } = {}) {
    const puppeteer = (await import('puppeteer')).default;
    const { buildPages } = await import('./pages.mjs');
    const { pages: all, greenhouse } = await buildPages({ root: ROOT });
    let pages = all;
    if (group) pages = pages.filter((p) => group.split(',').includes(p.group));
    if (only) pages = pages.filter((p) => only.includes(p.id));
    const byId = new Map(all.map((p) => [p.id, p]));
    let ghTheme = null;
    try { ghTheme = (await import(pathToFileURL(path.join(ROOT, 'dashboard/routes/greenhouse.js')).href)).themedGreenhouseHtml || null; } catch { /* route needs the app */ }
    if (greenhouse && (!only || only.includes('greenhouse')) && (!group || group.split(',').includes('sub'))) {
        pages = [...pages, { id: 'greenhouse', group: 'sub', greenhouse: true }];
    }
    const axeSrc = fs.readFileSync(AXE_FILE, 'utf8');

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        try {
            const m = url.pathname.match(/^\/__page\/([a-z0-9-]+)$/);
            if (m && byId.has(m[1])) {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                return res.end(byId.get(m[1]).html(url.searchParams.get('theme') || 'dark'));
            }
            if (url.pathname === '/greenhouse' && greenhouse) {
                let html = fs.readFileSync(greenhouse.index, 'utf8');
                if (ghTheme) html = ghTheme(html, url.searchParams.get('theme') || 'dark');
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                return res.end(html);
            }
            if (url.pathname.startsWith('/greenhouse/assets/') && greenhouse) {
                const f = path.resolve(greenhouse.assets, '.' + url.pathname.slice('/greenhouse/assets'.length));
                if (f.startsWith(greenhouse.assets + path.sep) && fs.existsSync(f)) {
                    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
                    return fs.createReadStream(f).pipe(res);
                }
            }
            if (url.pathname === '/socket.io/socket.io.js') {
                res.writeHead(200, { 'content-type': 'text/javascript' });
                return res.end(SOCKET_STUB);
            }
            const file = path.resolve(PUBLIC, '.' + decodeURIComponent(url.pathname));
            if (file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
                return fs.createReadStream(file).pipe(res);
            }
            res.writeHead(url.pathname.startsWith('/api/') || url.pathname.startsWith('/gh-api/') ? 503 : 404, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'theme-audit stub server' }));
        } catch (error) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            return res.end(`render failed: ${error.stack || error.message}`);
        }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'] });
    const report = { generated: new Date().toISOString(), themes, pages: {} };
    const shots = {};
    const jobs = [];
    for (const p of pages) for (const t of themes) jobs.push([p, t]);
    let done = 0;
    async function one([p, theme]) {
        // Own context per page: storage (the stored theme) never leaks between pages run side by side.
        const context = await browser.createBrowserContext();
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
        // A page that falls back to alert() when the stubbed API answers 503 would block the browser.
        page.on('dialog', (d) => { errors.push(`dialog: ${d.message().slice(0, 120)}`); d.dismiss().catch(() => {}); });
        const entry = { violations: 0, nodes: [], islands: [], errors, firstPaint: null };
        try {
            await page.setRequestInterception(true);
            page.on('request', (r) => {
                const u = r.url();
                if (u.startsWith(base) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue();
                if (/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//.test(u)) return r.continue();
                // Avatars: a local picture, so an <img onerror> fallback to Discord's default avatar cannot loop.
                if (/^https:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(u)) return r.respond({ status: 200, contentType: 'image/png', body: AVATAR });
                return r.abort();
            });
            await page.setViewport({ width: 1280, height: 860 });
            // The OS preference only matters for Auto; the dark default must hold whatever the OS says.
            await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme === 'dark' ? 'light' : 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
            await page.evaluateOnNewDocument(FIRST_FRAME);
            const url = p.greenhouse ? `${base}/greenhouse?theme=${theme}` : `${base}/__page/${p.id}?theme=${theme}`;
            await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => page.goto(url, { waitUntil: 'load', timeout: 30000 }));
            await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
            await new Promise((r) => setTimeout(r, 300));
            const final = await page.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(document.body || document.documentElement).backgroundColor, first: window.__firstFrame || null }));
            entry.firstPaint = { first: final.first, final: { theme: final.theme, bg: final.bg }, ok: !!final.first && final.first.bg === final.bg };
            await page.evaluate(axeSrc);
            const res = await page.evaluate(async () => {
                const r = await window.axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] }, resultTypes: ['violations'] });
                return (r.violations[0]?.nodes || []).map((n) => ({
                    target: n.target.join(' '), html: n.html.slice(0, 160),
                    fg: n.any[0]?.data?.fgColor, bg: n.any[0]?.data?.bgColor, ratio: n.any[0]?.data?.contrastRatio, need: n.any[0]?.data?.expectedContrastRatio,
                }));
            });
            entry.nodes = res;
            entry.violations = res.length;
            entry.islands = await page.evaluate(findIslands, theme !== 'dark');
            if (!sheetIds || sheetIds.includes(p.id)) {
                await page.evaluate(() => window.scrollTo(0, 0));
                shots[`${p.id}|${theme}`] = await page.screenshot({ type: 'png' });
            }
        } catch (error) {
            entry.failed = String(error.message).slice(0, 200);
        } finally {
            await page.close().catch(() => {});
            await context.close().catch(() => {});
        }
        (report.pages[p.id] ||= { group: p.group })[theme] = entry;
        done++;
        if (!quiet && (done % 25 === 0 || done === jobs.length)) console.log(`  ${done}/${jobs.length}`);
    }
    try {
        const queue = jobs.slice();
        await Promise.all(Array.from({ length: concurrency }, async () => { while (queue.length) await one(queue.shift()); }));
    } finally {
        await browser.close().catch(() => {});
        server.close();
    }
    report.summary = summarise(report);
    return { report, shots };
}

export function summarise(report) {
    const s = {};
    for (const t of report.themes) s[t] = { pagesWithViolations: 0, violations: 0, islands: 0, flashes: 0, failed: 0 };
    for (const [, p] of Object.entries(report.pages)) {
        for (const t of report.themes) {
            const e = p[t]; if (!e) continue;
            if (e.failed) s[t].failed++;
            if (e.violations) { s[t].pagesWithViolations++; s[t].violations += e.violations; }
            s[t].islands += e.islands.length;
            if (e.firstPaint && !e.firstPaint.ok) s[t].flashes++;
        }
    }
    return s;
}

/** Contact sheet: one row per page, a column per theme. */
export async function contactSheet(shots, ids, themes, file) {
    const sharp = (await import('sharp')).default;
    const W = 480, H = 322, PAD = 12, LABEL = 22;
    const cells = [];
    ids.forEach((id, row) => themes.forEach((t, col) => {
        const buf = shots[`${id}|${t}`]; if (!buf) return;
        cells.push({ id, t, row, col, buf });
    }));
    const comps = [];
    for (const c of cells) {
        const img = await sharp(c.buf).resize({ width: W, height: H, fit: 'cover', position: 'top' }).png().toBuffer();
        const x = PAD + c.col * (W + PAD), y = PAD + c.row * (H + LABEL + PAD);
        comps.push({ input: img, left: x, top: y + LABEL });
        comps.push({ input: Buffer.from(`<svg width="${W}" height="${LABEL}" xmlns="http://www.w3.org/2000/svg"><text x="0" y="16" font-family="DejaVu Sans, sans-serif" font-size="14" fill="#e5e7eb">${c.id} (${c.t})</text></svg>`), left: x, top: y });
    }
    await sharp({ create: { width: PAD + themes.length * (W + PAD), height: PAD + ids.length * (H + LABEL + PAD), channels: 3, background: '#2b2d31' } })
        .composite(comps).png().toFile(file);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const opt = (n, f = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : f; };
    const out = path.resolve(opt('out', '/tmp/theme-audit'));
    const themes = opt('themes', 'dark,light,sand').split(',');
    const sheetIds = opt('sheet-ids') ? opt('sheet-ids').split(',') : null;
    audit({ themes, only: opt('only') ? opt('only').split(',') : null, group: opt('group'), concurrency: Number(opt('concurrency', 4)), sheetIds: opt('sheet') ? (sheetIds || []) : [] })
        .then(async ({ report, shots }) => {
            fs.mkdirSync(out, { recursive: true });
            fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
            console.log(JSON.stringify(report.summary, null, 1));
            if (opt('sheet')) await contactSheet(shots, sheetIds || Object.keys(report.pages), themes, opt('sheet'));
            process.exit(0);
        }, (e) => { console.error(e.stack || e.message); process.exit(2); });
}
