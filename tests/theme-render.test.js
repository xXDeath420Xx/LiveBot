import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The colour themes render properly (owner, 2026-11-19: "Dark only is my personal preference; some users
 * prefer light. Keep / enhance / ensure those themes properly render."). Dark is the default; Light, Sand
 * and Auto are chosen on Settings (signed in) or with the footer switch (signed out).
 *
 *   static   - the theme is on <html> before first paint, and the server value wins for signed-in users
 *            - no known dark-only hard-coded colour pattern in a themed template's CSS
 *            - Settings swatches show the real theme colours; the Discord preview has a light theme;
 *              the Greenhouse website's Auto-light set equals cf-ui.css's Light block
 *   render   - a representative set of real templates (public, docs, guides, 15 manage pages, sub-sites,
 *              errors, Greenhouse) with invented demo data in headless Chrome, Dark/Light/Sand: no axe-core
 *              colour-contrast violation (WCAG AA), no large neutral box painted in the other family's
 *              colours, and the first frame already in the final theme (scripts/theme-audit/run.mjs)
 *
 * THEME_RENDER_SKIP=1 skips the browser part. The whole-site audit: node scripts/theme-audit/run.mjs.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else if (p.endsWith('.ejs')) out.push(p);
    }
    return out;
}

// Fixed looks by design: OBS overlays (transparent, stream-facing) and the public Steam embed (?theme=light).
const FIXED_LOOK = new Set(['fourtwenty-overlay.ejs', 'fourtwenty-obs-builder.ejs', 'twitch-analytics-obs.ejs', 'steam-library-public.ejs']);

// ── first paint ─────────────────────────────────────────────────────────────────────────────

test('themed templates set the theme in <head>, and a signed-in user\'s saved theme wins over storage', () => {
    let n = 0;
    for (const f of walk(views)) {
        const rel = path.relative(views, f);
        let src = fs.readFileSync(f, 'utf8');
        if (src.includes("include('partials/site-head'")) src = src.replace("include('partials/site-head'", fs.readFileSync(path.join(views, 'partials/site-head.ejs'), 'utf8'));
        const tag = (src.match(/<html\s[^\n]*/) || [''])[0];
        if (!/data-theme="<%= locals\.uiTheme/.test(tag)) continue;
        n++;
        const end = src.indexOf('</head>');
        const head = src.slice(0, end > 0 ? end : 6000);
        assert.match(head, /localStorage\.getItem\('ui-theme'\)/, `${rel}: reads the stored theme in <head>`);
        assert.match(head, /locals\.userPrefs \? 'true' : 'false'/, `${rel}: knows whether the server value is a saved preference`);
        assert.doesNotMatch(head, /!== 'dark'\) \{\s*localStorage\.setItem/, `${rel}: storage no longer overrides a saved Dark`);
    }
    assert.ok(n >= 60, `${n} themed templates`);
});

test('the anti-flash logic: signed in keeps the server theme (Dark included); signed out uses storage, else Dark', () => {
    const head = read('dashboard/views/partials/site-head.ejs');
    const body = head.match(/\(function \(\) \{\s*try \{\s*var d = document\.documentElement, saved[\s\S]*?\}\)\(\);/)[0];
    const run = (saved, server, stored) => {
        const attrs = new Map([['data-theme', server], ['data-density', 'comfortable']]);
        const store = new Map(stored ? [['ui-theme', stored]] : []);
        vm.runInNewContext(body.replace("<%= locals.userPrefs ? 'true' : 'false' %>", String(saved)), {
            document: { documentElement: { getAttribute: (k) => attrs.get(k) ?? null, setAttribute: (k, v) => attrs.set(k, v) } },
            localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
        });
        return { theme: attrs.get('data-theme'), stored: store.get('ui-theme') };
    };
    assert.deepEqual(run(true, 'dark', 'light'), { theme: 'dark', stored: 'dark' }, 'saved Dark beats a stale Light in storage');
    assert.deepEqual(run(true, 'sand', null), { theme: 'sand', stored: 'sand' });
    assert.deepEqual(run(false, 'dark', 'light'), { theme: 'light', stored: 'light' }, 'signed out: the footer switch choice');
    assert.deepEqual(run(false, 'dark', null), { theme: 'dark', stored: undefined }, 'signed out, no choice: Dark');
    assert.equal(run(false, 'dark', 'x"><script>').theme, 'dark', 'a junk stored value is ignored');
});

test('signed-out visitors get a theme switch in the footer; signed-in users a link to Settings', () => {
    const foot = read('dashboard/views/partials/site-footer.ejs');
    assert.match(foot, /<select id="cfsTheme">[\s\S]*value="dark">Dark[\s\S]*value="light">Light[\s\S]*value="sand">Sand[\s\S]*value="auto"/);
    assert.match(foot, /localStorage\.setItem\('ui-theme', v\)/);
    assert.match(foot, /if \(locals\.userPrefs\) \{ %>\s*<a class="cfs-theme-link" href="\/settings"/);
});

// ── hard-coded colours ──────────────────────────────────────────────────────────────────────

/** CSS of a template (its <style> blocks and style="" attributes) as [selector, declarations] rules. */
function rulesOf(src) {
    const css = [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
    const attrs = [...src.matchAll(/\sstyle="([^"]*)"/g)].map((m) => `[style-attr] { ${m[1]} }`).join('\n');
    const text = (css + '\n' + attrs).replace(/\/\*[\s\S]*?\*\//g, (c) => (/theme:\s*fixed/.test(c) ? ' __FIXED__ ' : ' ')).replace(/<%[\s\S]*?%>/g, 'X');
    const out = [];
    (function parse(s) {
        let i = 0;
        while (i < s.length) {
            const open = s.indexOf('{', i);
            if (open < 0) break;
            const sel = s.slice(i, open).split(/[;}]/).pop().trim();
            let depth = 1, j = open + 1;
            while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
            const body = s.slice(open + 1, j - 1);
            if (/^@media\s+print|^@page/.test(sel)) { /* print styles may be light */ }
            else if (sel.startsWith('@')) parse(body);
            else out.push([sel, body]);
            i = j;
        }
    })(text);
    return out;
}

const lum = (hex) => {
    let h = hex.replace('#', ''); if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
};
const DARK_ONLY = /html\.print|\.print\b|:not\(\[data-theme="light"\]\)|data-theme="(dark|midnight|amoled|contrast|slate|forest|ember|plum|ocean)"/;

/** Known dark-only patterns: a white overlay or hairline (vanishes on Light), a near-black fill (a dark box on Light). */
function hardCodedColours(src) {
    const found = [];
    for (const [sel, body] of rulesOf(src)) {
        if (/^:root(\[[^\]]*\]|:[a-z-]+\([^)]*\))*$/.test(sel.replace(/\s+/g, ''))) continue;   // token definitions
        if (DARK_ONLY.test(sel) || body.includes('__FIXED__')) continue;
        for (const decl of body.split(';')) {
            const m = decl.match(/^\s*(background(?:-color)?|border(?:-[a-z-]+)?|color|outline(?:-color)?|fill|stroke)\s*:\s*([\s\S]+)$/i);
            if (!m) continue;
            let value = m[2];
            for (let k = 0; k < 4; k++) value = value.replace(/var\(--[\w-]+\s*,[^()]*(\([^()]*\)[^()]*)*\)/g, 'var()');
            if (/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0?\.\d+\s*\)/.test(value)) found.push(`${sel} { ${m[1]}: ${m[2].trim()} }`);
            if (/^background/i.test(m[1]) && (value.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi) || []).some((hx) => lum(hx) < 0.02)) found.push(`${sel} { ${m[1]}: ${m[2].trim()} }`);
        }
    }
    return found;
}

test('the pattern check finds what it should and leaves alone what it should', () => {
    const bad = '<style>.a { background: rgba(255, 255, 255, 0.05); } .b { border: 1px solid rgba(255,255,255,.1) } .c { background: #0b0f11 }</style><div style="background:#111"></div>';
    assert.equal(hardCodedColours(bad).length, 4);
    const ok = `<style>:root { --bg: #0b0f11; --line: rgba(255,255,255,.1); } .a { background: var(--cf-surface, #0b0f11); box-shadow: inset 0 1px 0 rgba(255,255,255,.07); }
        @media print { .p { background: #000; } } html.print .q { background: #000 }
        .art { background: #111; /* theme: fixed (card art) */ } :root:not([data-theme="light"]):not([data-theme="sand"]) .d { background: #000 }</style>`;
    assert.deepEqual(hardCodedColours(ok), []);
});

test('no themed template paints a dark-only hard-coded colour (white overlays and hairlines, near-black fills)', () => {
    const problems = [];
    for (const f of walk(views)) {
        const rel = path.relative(views, f).split(path.sep).join('/');
        if (FIXED_LOOK.has(rel)) continue;
        for (const p of hardCodedColours(fs.readFileSync(f, 'utf8'))) problems.push(`${rel}: ${p.slice(0, 160)}`);
    }
    assert.deepEqual(problems, [], `use the --cf-* tokens (or color-mix(in srgb, var(--cf-text) N%, transparent)); mark deliberate art /* theme: fixed */`);
});

// ── previews, swatches, Greenhouse ──────────────────────────────────────────────────────────

test('Settings theme swatches show the real theme background and accent', () => {
    const s = read('dashboard/views/settings-tailwind.ejs');
    const ui = read('dashboard/public/css/cf-ui.css');
    const block = (sel) => { const i = ui.indexOf(sel); return ui.slice(i, ui.indexOf('}', i)); };
    const dark = block(':root:where(:not([data-theme="light"]):not([data-theme="sand"])) {');
    const light = block(':root[data-theme="light"],');
    const tok = (b, k) => b.match(new RegExp(`${k}:\\s*(#[0-9a-f]{6})`, 'i'))[1].toLowerCase();
    const sw = (name) => s.match(new RegExp(`data-swatch="${name}"\\]\\s*\\{ --sw-bg: (#[0-9a-f]{6}); --sw-accent: (#[0-9a-f]{6}); \\}`, 'i')).slice(1).map((x) => x.toLowerCase());
    assert.deepEqual(sw('dark'), [tok(dark, '--cf-bg'), tok(dark, '--cf-accent')]);
    assert.deepEqual(sw('light'), [tok(light, '--cf-bg'), tok(light, '--cf-accent')]);
    const sand = ui.match(/:root\[data-theme="sand"\] \{ --cf-bg: (#[0-9a-f]{6});/)[1];
    const sandAccent = ui.match(/:root\[data-theme="sand"\] \{ --cf-accent: (#[0-9a-f]{6});/)[1];
    assert.deepEqual(sw('sand'), [sand, sandAccent]);
});

test('the Discord message preview has Discord\'s light theme in Light and Sand', () => {
    const css = read('dashboard/public/css/cf-msgpreview.css');
    assert.match(css, /:root:is\(\[data-theme="light"\], \[data-theme="sand"\]\) \.cf-dc \{ background: #ffffff; color: #313338;/);
    assert.match(css, /\.cf-dc\.cf-dc :where\(\.cf-dc-text, \.cf-dc-md/, 'message text is not repainted by page rules');
    assert.match(read('dashboard/public/js/cf-msgpreview.js'), /var\(--cf-dc-bar-none, #1e1f22\)/);
});

test('Greenhouse website: the route themes <html>; its Auto-light set equals cf-ui.css Light; the panel is untouched', async () => {
    const { themedGreenhouseHtml } = await import('../dashboard/routes/greenhouse.js');
    const html = '<html lang="en">\n<head>\n<meta name="color-scheme" content="dark">';
    assert.equal(themedGreenhouseHtml(html, 'dark'), html);
    assert.equal(themedGreenhouseHtml(html, 'midnight'), html);
    assert.match(themedGreenhouseHtml(html, 'light'), /<html lang="en" data-theme="light">[\s\S]*content="light"/);
    assert.match(themedGreenhouseHtml(html, 'sand'), /data-theme="light" data-theme-variant="sand"/);
    assert.match(themedGreenhouseHtml(html, 'auto'), /data-theme-mode="auto"[\s\S]*content="light dark"/);
    assert.equal(themedGreenhouseHtml(html, '"><x'), html);
    const ui = read('dashboard/public/css/cf-ui.css');
    const i = ui.indexOf(':root[data-theme="light"],');
    const light = [...ui.slice(i, ui.indexOf('}', i)).matchAll(/(--cf-[\w-]+):\s*([^;]+);/g)].filter((m) => !/url\(/.test(m[2]));
    assert.ok(light.length >= 20);
    const web = read('frontend/greenhouse/src/styles/web.css');
    const auto = web.slice(web.indexOf(':root[data-theme-mode="auto"]'));
    for (const [, k, v] of light) assert.ok(auto.includes(`${k}: ${v.trim()};`), `web.css Auto-light has ${k}: ${v.trim()}`);
    // The website-only theme code never reaches the panel bundle (its entry is main.js).
    assert.doesNotMatch(read('frontend/greenhouse/src/main.js'), /web-theme/);
    assert.match(read('frontend/greenhouse/src/web-entry.js'), /import '\.\/web-theme\.js';/);
});

// ── render ──────────────────────────────────────────────────────────────────────────────────

const SAMPLE = [
    'home', 'commands', 'status', 'privacy', 'docs', 'guides', 'guide-getting-started', 'guide-moderation',
    'manage-overview', 'manage-leveling', 'manage-welcome', 'manage-moderation', 'manage-automod', 'manage-streamers',
    'manage-reaction-roles', 'manage-tickets', 'manage-economy', 'manage-starboard', 'manage-announce', 'manage-logging',
    'manage-security', 'manage-counting', 'manage-classic-overview',
    'servers', 'settings', 'profile', 'vault', 'cards-create', 'cah-lobby', 'kick-panel', 'twitch-analytics', 'my-schedules',
    'error', 'greenhouse',
];

test('representative pages in Dark, Light and Sand: no contrast violation, no wrong-family box, no flash', { skip: process.env.THEME_RENDER_SKIP === '1', timeout: 900000 }, async () => {
    const { audit } = await import('../scripts/theme-audit/run.mjs');
    const { report } = await audit({ only: SAMPLE, concurrency: 3, sheetIds: [], quiet: true });
    const problems = [];
    for (const id of SAMPLE) {
        const p = report.pages[id];
        if (!p) { problems.push(`${id}: not rendered`); continue; }
        for (const t of report.themes) {
            const e = p[t];
            if (e.failed) problems.push(`${id} ${t}: failed (${e.failed})`);
            for (const n of e.nodes) problems.push(`${id} ${t}: contrast ${n.ratio}:1 (${n.fg} on ${n.bg}, needs ${n.need}) ${n.target}`);
            for (const n of e.islands) problems.push(`${id} ${t}: ${n.bg} box ${n.w}x${n.h} ${n.sel}`);
            if (e.firstPaint && !e.firstPaint.ok) problems.push(`${id} ${t}: first frame ${JSON.stringify(e.firstPaint.first)} != ${JSON.stringify(e.firstPaint.final)}`);
            // Greenhouse uses the game's own light set for Light and Sand (data-theme="light" + a Sand variant).
            const want = id === 'greenhouse' ? { dark: null, light: 'light', sand: 'light' }[t] : t;
            if ((e.firstPaint?.final?.theme ?? null) !== want) problems.push(`${id} ${t}: ended as ${e.firstPaint?.final?.theme}`);
        }
    }
    assert.deepEqual(problems, []);
});
