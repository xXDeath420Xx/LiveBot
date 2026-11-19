#!/usr/bin/env node
// Greenhouse Tycoon frontend build (phase 3). One source tree, two outputs:
//
//   node frontend/greenhouse/build.mjs            both
//   node frontend/greenhouse/build.mjs --web      dist/web/: index.html + assets/app.<hash>.js|css, icon, fonts
//                                                 (the dashboard serves it at /greenhouse and
//                                                 /greenhouse/assets/*, see dashboard/routes/greenhouse.js)
//   node frontend/greenhouse/build.mjs --panel    dist/panel/ + dist/greenhouse-panel.zip for the Twitch
//                                                 console: panel.html, panel.js, panel.css, config.html,
//                                                 config.css, Geist-Variable.woff2, Geist-OFL.txt, and
//                                                 dist/PANEL-BUILD.txt (sizes, hash, URLs)
//   node frontend/greenhouse/build.mjs --check    only check an existing dist/panel/
//
// The panel build is NOT minified (Twitch guideline 2.5: reviewers read the code as shipped). The website
// build is minified and its file names carry a content hash, so they can be cached for a year.
// The site's design tokens (--cf-*) are copied from dashboard/public/css/cf-ui.css at build time.
// Website-only code (register H-641): the website bundle starts at src/web-entry.js, which imports the
// website-only modules (views/your-data.js, the Profile "Your data" card) and then main.js; the panel bundle
// starts at main.js. Website-only CSS is styles/web.css. So the panel output is byte-identical whatever those add.
// Fonts (phase 3 follow-up, owner decision): Geist ships inside both outputs from src/fonts/ (the "geist"
// npm package 1.9.2, dist/fonts/*/Geist*-Variable.woff2, SIL Open Font License 1.1, whose text goes along as
// Geist-OFL.txt); nothing is loaded from Google Fonts or any other host. The panel gets Geist only (it shows
// no monospaced text since link codes are website-only); the website also gets Geist Mono.
// Uses esbuild, which the repo already has (node_modules/esbuild); no other dependency.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'src');
const TOKENS_FILE = path.resolve(HERE, '../../dashboard/public/css/cf-ui.css');
const FONTS = path.join(SRC, 'fonts');
export const FONT_FILES = Object.freeze({ sans: 'Geist-Variable.woff2', mono: 'GeistMono-Variable.woff2', licence: 'Geist-OFL.txt' });

export const HELPER_URL = 'https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js';
// Sorted as fs.readdirSync().sort() sorts them (capitals first).
export const PANEL_FILES = Object.freeze(['Geist-OFL.txt', 'Geist-Variable.woff2', 'config.css', 'config.html', 'panel.css', 'panel.html', 'panel.js']);
// Phase 4 (2026-11-18) raised the budgets from 120 KB JS / 25 KB CSS: quests, the season and leaderboard,
// achievements, notifications, Replant, decorations (with their drawings) and the review-save switch added
// about 30 KB of readable code to a panel.js that was already at 119 KB. Fonts are separate files, budgeted
// on their own.
export const BUDGET = Object.freeze({ jsBytes: 170 * 1024, cssBytes: 32 * 1024, fontBytes: 100 * 1024 });
// Every absolute URL the panel code may contain. The SVG namespace is an identifier, never fetched.
export const PANEL_URLS = Object.freeze([
    'https://certifriedmultitool.com',
    'http://www.w3.org/2000/svg'
]);
// No remote stylesheet or font is allowed (the fonts ship in the package).
const FONT_HOSTS = /fonts\.(googleapis|gstatic)\.com/i;

// Code the panel must not contain (Twitch guidelines 2.6/2.7: no dynamic code, no HTML sinks; no native
// dialogs, which may do nothing in the sandboxed frame). Built from parts so this file does not trip
// source scanners that look for the same words.
const FORBIDDEN_JS = [
    ['\\beval\\s*\\(', 'eval'], ['\\bnew\\s+Func' + 'tion\\b', 'the Function constructor'], ['\\.inner' + 'HTML\\b', 'inner' + 'HTML'],
    ['\\.outer' + 'HTML\\b', 'outer' + 'HTML'], ['insertAdjacent' + 'HTML', 'insertAdjacent' + 'HTML'], ['document\\.wr' + 'ite', 'document.wr' + 'ite'],
    ['setTimeout\\(\\s*[\'"`]', 'setTimeout with a string'], ['\\balert\\s*\\(', 'alert()'], ['\\bconfirm\\s*\\(', 'the native confirm()'],
    ['sourceMappingURL', 'a source map reference']
].map(([re, what]) => [new RegExp(re), what]);

// ------------------------------------------------------------------ tokens

function block(css, selector) {
    const at = css.indexOf(selector);
    if (at < 0) throw new Error(`cf-ui.css: "${selector}" not found`);
    const open = css.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
    }
    throw new Error(`cf-ui.css: "${selector}" is not closed`);
}

const decls = (body) => body.replace(/\/\*[\s\S]*?\*\//g, '').split(/;\s*\n|;(?=\s*--)/).map(d => d.trim().replace(/;$/, '')).filter(d => d.startsWith('--cf-')).map(d => `    ${d};`);

/** The --cf-* custom properties of the site: base scale, dark (default) and light. */
export function tokensCss(file = TOKENS_FILE) {
    const css = fs.readFileSync(file, 'utf8');
    const base = decls(block(css, ':root {'));
    const dark = decls(block(css, ':root:where(:not([data-theme="light"]):not([data-theme="sand"])) {'));
    const light = decls(block(css, ':root[data-theme="light"],'));
    if (base.length < 10 || dark.length < 15 || light.length < 15) throw new Error('cf-ui.css: fewer tokens than expected; has the file changed shape?');
    return `/* Tokens copied from dashboard/public/css/cf-ui.css by frontend/greenhouse/build.mjs. Do not edit here. */
:root {
    color-scheme: dark;
${base.join('\n')}
${dark.join('\n')}
}
:root[data-theme="light"] {
    color-scheme: light;
${light.join('\n')}
}
`;
}

// ------------------------------------------------------------------ bundles

async function bundleJs(target, { minify }) {
    const out = await esbuild.build({
        entryPoints: [path.join(SRC, target === 'web' ? 'web-entry.js' : 'main.js')],
        bundle: true,
        write: false,
        format: 'iife',
        target: ['es2020', 'chrome90', 'firefox90', 'safari14'],
        minify,
        charset: 'utf8',
        legalComments: 'none',
        define: { __GH_TARGET__: JSON.stringify(target) },
        banner: minify ? undefined : {
            js: `/* Greenhouse Tycoon by CertiFried: ${target} build, not minified. Source layout: frontend/greenhouse/src/ (main.js, lib/, ui/, views/, art/). */`
        },
        logLevel: 'silent'
    });
    return out.outputFiles[0].text;
}

async function bundleCss({ minify, web = false }) {
    const extra = web ? ['styles/fonts-web.css', 'styles/web.css'].map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('') : '';
    const out = await esbuild.build({
        stdin: { contents: tokensCss() + fs.readFileSync(path.join(SRC, 'styles/app.css'), 'utf8') + extra, loader: 'css', resolveDir: path.join(SRC, 'styles') },
        bundle: true,
        write: false,
        external: ['*.woff2'],
        minify,
        charset: 'utf8',
        logLevel: 'silent'
    });
    return out.outputFiles[0].text;
}

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 10);
const readFont = (name) => fs.readFileSync(path.join(FONTS, name));

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#151619"/><path d="M16 26v-9" stroke="#b4e04f" stroke-width="2" stroke-linecap="round"/><path d="M16 17c0-5-3.5-8-9-8 0 5 3.5 8 9 8zM16 15c0-4.5 3.4-7.5 8.5-7.5 0 4.5-3.4 7.5-8.5 7.5z" fill="#b4e04f"/></svg>\n`;

/** Website build: dist/web/index.html and hashed assets for /greenhouse/assets/. */
export async function buildWeb({ outDir = path.join(HERE, 'dist/web'), assetBase = '/greenhouse/assets' } = {}) {
    const [js, rawCss] = await Promise.all([bundleJs('web', { minify: true }), bundleCss({ minify: true, web: true })]);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
    // Fonts get content-hashed names too; the stylesheet refers to them by those names (same folder).
    const sans = readFont(FONT_FILES.sans);
    const mono = readFont(FONT_FILES.mono);
    const fontNames = { sans: `Geist-Variable.${hash(sans)}.woff2`, mono: `GeistMono-Variable.${hash(mono)}.woff2` };
    const css = rawCss.replaceAll(FONT_FILES.sans, fontNames.sans).replaceAll(FONT_FILES.mono, fontNames.mono);
    fs.writeFileSync(path.join(outDir, 'assets', fontNames.sans), sans);
    fs.writeFileSync(path.join(outDir, 'assets', fontNames.mono), mono);
    fs.copyFileSync(path.join(FONTS, FONT_FILES.licence), path.join(outDir, 'assets', FONT_FILES.licence));
    const names = { JS: `app.${hash(js)}.js`, CSS: `app.${hash(css)}.css`, ICON: `icon.${hash(ICON_SVG)}.svg`, FONT: fontNames.sans };
    fs.writeFileSync(path.join(outDir, 'assets', names.JS), js);
    fs.writeFileSync(path.join(outDir, 'assets', names.CSS), css);
    fs.writeFileSync(path.join(outDir, 'assets', names.ICON), ICON_SVG);
    const html = fs.readFileSync(path.join(SRC, 'web.html'), 'utf8')
        .replaceAll('{{ASSET_BASE}}', assetBase)
        .replace('{{JS}}', names.JS).replace('{{CSS}}', names.CSS).replace('{{ICON}}', names.ICON).replace('{{FONT}}', names.FONT);
    fs.writeFileSync(path.join(outDir, 'index.html'), html);
    return { outDir, files: names, jsBytes: Buffer.byteLength(js), cssBytes: Buffer.byteLength(css) };
}

/** Twitch panel build: dist/panel/ (readable) and the zip to upload. */
export async function buildPanel({ outDir = path.join(HERE, 'dist/panel'), zipPath = path.join(HERE, 'dist/greenhouse-panel.zip') } = {}) {
    const [js, css] = await Promise.all([bundleJs('panel', { minify: false }), bundleCss({ minify: false })]);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'panel.js'), js);
    fs.writeFileSync(path.join(outDir, 'panel.css'), css);
    for (const f of ['panel.html', 'config.html', 'config.css']) fs.copyFileSync(path.join(SRC, f), path.join(outDir, f));
    for (const f of [FONT_FILES.sans, FONT_FILES.licence]) fs.copyFileSync(path.join(FONTS, f), path.join(outDir, f));

    const problems = checkPanel(outDir);
    if (problems.length) throw new Error(`panel package check failed:\n  ${problems.join('\n  ')}`);

    const files = fs.readdirSync(outDir).sort();
    const h = crypto.createHash('sha256');
    for (const f of files) h.update(f).update(fs.readFileSync(path.join(outDir, f)));
    const contentHash = h.digest('hex').slice(0, 12);
    fs.rmSync(zipPath, { force: true });
    execFileSync('zip', ['-q', '-X', '-j', zipPath, ...files.map(f => path.join(outDir, f))]);
    const zipBytes = fs.statSync(zipPath).size;
    const sizes = Object.fromEntries(files.map(f => [f, fs.statSync(path.join(outDir, f)).size]));
    fs.writeFileSync(path.join(path.dirname(zipPath), 'PANEL-BUILD.txt'), [
        `Greenhouse Tycoon Twitch panel, built ${new Date().toISOString()}`,
        `Zip: ${path.basename(zipPath)} (${zipBytes} bytes), content hash ${contentHash}`,
        `Files: ${files.map(f => `${f} (${sizes[f]} B)`).join(', ')}`,
        'panel.js is not minified (Twitch guideline 2.5); source: frontend/greenhouse/src/.',
        'Panel Viewer Path: panel.html. Config Path: config.html (nothing to configure).',
        'Fetched URLs (guideline 2.12):',
        '  https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js  (Twitch helper, first script)',
        '  https://certifriedmultitool.com/gh-api/api/v2/*                 (game API)',
        '  wss://certifriedmultitool.com/gh-api/ws                         (live update hints)',
        'Fonts: Geist-Variable.woff2 is in the package (SIL Open Font License 1.1, Geist-OFL.txt); no font is fetched.',
        ''
    ].join('\n'));
    return { outDir, zipPath, zipBytes, contentHash, sizes };
}

// ------------------------------------------------------------------ the panel package rules

/** Problems with a built panel folder (empty list: it passes). Also used by tests/cfx/v2/frontend-build.test.js. */
export function checkPanel(dir) {
    const problems = [];
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    if (JSON.stringify(files) !== JSON.stringify([...PANEL_FILES])) problems.push(`files must be exactly ${PANEL_FILES.join(', ')}; found ${files.join(', ')}`);
    const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');

    for (const page of ['panel.html', 'config.html']) {
        const html = read(page);
        const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
        const srcs = scripts.map(m => (m[1].match(/\bsrc="([^"]+)"/) || [])[1] || null);
        if (srcs[0] !== HELPER_URL) problems.push(`${page}: the Twitch helper must be the first script`);
        for (const [i, m] of scripts.entries()) {
            if (!srcs[i]) problems.push(`${page}: inline script`);
            else if (/^https?:/i.test(srcs[i]) && srcs[i] !== HELPER_URL) problems.push(`${page}: remote script ${srcs[i]}`);
            if (m[2].trim()) problems.push(`${page}: script element with inline code`);
        }
        if (/\son[a-z]+\s*=/i.test(html)) problems.push(`${page}: inline event handler attribute`);
        if (/\b(href|src)="\//i.test(html)) problems.push(`${page}: absolute asset path`);
        if (/javascript:/i.test(html)) problems.push(`${page}: javascript: URL`);
        if (/\bstyle\s*=/i.test(html) || /<style\b/i.test(html)) problems.push(`${page}: inline style`);
        for (const m of html.matchAll(/<link\b[^>]*href="([^"]+)"/gi)) {
            if (/^https?:/i.test(m[1])) problems.push(`${page}: remote stylesheet ${m[1]}`);
        }
        if (FONT_HOSTS.test(html)) problems.push(`${page}: refers to a font host (the fonts ship in the package)`);
    }
    if (!/nothing to set up/i.test(read('config.html'))) problems.push('config.html must say there is nothing to set up');
    if (/panel\.css/.test(read('config.html'))) problems.push('config.html must not use panel.css (it locks the page to the panel size)');

    const js = read('panel.js');
    const jsBytes = Buffer.byteLength(js);
    if (jsBytes > BUDGET.jsBytes) problems.push(`panel.js is ${jsBytes} B, over the ${BUDGET.jsBytes} B budget`);
    const cssBytes = Buffer.byteLength(read('panel.css'));
    if (cssBytes > BUDGET.cssBytes) problems.push(`panel.css is ${cssBytes} B, over the ${BUDGET.cssBytes} B budget`);
    for (const [re, what] of FORBIDDEN_JS) if (re.test(js)) problems.push(`panel.js uses ${what}`);
    for (const m of js.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`)]+/g)) {
        if (!PANEL_URLS.some(u => m[0] === u || m[0].startsWith(`${u}/`))) problems.push(`panel.js contains an unlisted URL: ${m[0]}`);
    }
    // Readable, not minified: normal line lengths, many lines, original function names.
    const lines = js.split('\n');
    const longest = Math.max(...lines.map(l => l.length));
    if (lines.length < 800 || longest > 400) problems.push(`panel.js looks minified (${lines.length} lines, longest ${longest} characters)`);
    for (const name of ['function plantSvg', 'function createSync', 'function createSession']) {
        if (!js.includes(name)) problems.push(`panel.js should keep readable names (missing "${name}")`);
    }
    const css = read('panel.css');
    if (/url\(\s*['"]?https?:/i.test(css)) problems.push('panel.css loads a remote resource');
    if (FONT_HOSTS.test(css) || FONT_HOSTS.test(js)) problems.push('the panel refers to a font host (the fonts ship in the package)');
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
        const ref = m[1].replace(/^\.\//, '');
        if (/^data:/.test(ref)) continue;
        if (ref.startsWith('/') || !files.includes(ref)) problems.push(`panel.css refers to ${m[1]}, which is not in the package`);
    }
    const font = path.join(dir, FONT_FILES.sans);
    if (fs.existsSync(font)) {
        const bytes = fs.statSync(font).size;
        if (bytes > BUDGET.fontBytes) problems.push(`${FONT_FILES.sans} is ${bytes} B, over the ${BUDGET.fontBytes} B budget`);
        if (fs.readFileSync(font).subarray(0, 4).toString('latin1') !== 'wOF2') problems.push(`${FONT_FILES.sans} is not a woff2 file`);
    }
    if (!/SIL OPEN FONT LICENSE Version 1\.1/.test(read(FONT_FILES.licence))) problems.push(`${FONT_FILES.licence} must hold the SIL Open Font License 1.1 text`);
    return problems;
}

// ------------------------------------------------------------------ command line

async function cli() {
    const args = new Set(process.argv.slice(2));
    const only = args.has('--web') ? 'web' : args.has('--panel') ? 'panel' : args.has('--check') ? 'check' : 'both';
    const t0 = Date.now();
    if (only === 'check') {
        const problems = checkPanel(path.join(HERE, 'dist/panel'));
        console.log(problems.length ? `FAIL\n  ${problems.join('\n  ')}` : 'panel package: all checks pass');
        process.exit(problems.length ? 1 : 0);
    }
    if (only === 'web' || only === 'both') {
        const w = await buildWeb();
        console.log(`web:   ${path.relative(process.cwd(), w.outDir)}  js ${w.jsBytes} B (minified), css ${w.cssBytes} B`);
    }
    if (only === 'panel' || only === 'both') {
        const p = await buildPanel();
        console.log(`panel: ${path.relative(process.cwd(), p.outDir)}  ${Object.entries(p.sizes).map(([f, n]) => `${f} ${n} B`).join(', ')}`);
        console.log(`zip:   ${path.relative(process.cwd(), p.zipPath)} ${p.zipBytes} B; all package checks pass`);
    }
    console.log(`done in ${Date.now() - t0} ms`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    cli().catch((err) => { console.error(err.message || err); process.exit(1); });
}
