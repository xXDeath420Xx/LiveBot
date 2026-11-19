import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import { GUIDES, AREAS, getGuide, guideImage, inline, linksIn, imagesIn } from '../dashboard/content/guides/index.js';

/*
 * The how-to guides (/docs/guides, dashboard/content/guides/, views/docs-guides.ejs), the docs overview
 * (/docs, views/docs-tailwind.ejs) and the home page showcase (views/landing-chooser.ejs):
 *   - every guide's data is valid: unique slugs, known area, steps with titles, images that exist in
 *     the screenshot manifest (and on disk), related guides that exist, no Reddit or Meta platforms
 *     offered as working
 *   - unknown or hostile slugs are rejected; the inline text marks escape everything else
 *   - the index and a guide page render, with every image sized and lazy below the fold
 *   - every link on /docs, the guides and the home page showcase resolves: site paths to a route,
 *     a static file or a guide; /commands#name to a command module; #id to an id on the same page
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const pub = path.join(root, 'dashboard/public');
const manifest = JSON.parse(fs.readFileSync(path.join(pub, 'img/guides/manifest.json'), 'utf8'));
const siteGuides = { GUIDES, AREAS, getGuide, guideImage, inline };
const engine = createViewEngine({ viewsDir: views, cache: false });
const render = (template, locals) => engine.renderFile(path.join(views, `${template}.ejs`), {
    user: null, clientId: '100900000000000001', uiTheme: 'dark', uiStyle: 'cards', uiDensity: 'comfortable', csrfToken: 't', siteGuides, ...locals,
});

// ── guide data ──
test('every guide has valid data', () => {
    const slugs = GUIDES.map((g) => g.slug);
    assert.equal(new Set(slugs).size, slugs.length, 'guide slugs are unique');
    assert.ok(GUIDES.length >= 16, `at least 16 guides (${GUIDES.length})`);
    const areas = new Set(AREAS.map((a) => a.id));
    for (const g of GUIDES) {
        assert.match(g.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${g.slug}: slug format`);
        assert.ok(g.title && g.summary, `${g.slug}: title and summary`);
        assert.ok(areas.has(g.area), `${g.slug}: area ${g.area} is one of AREAS`);
        assert.ok(g.result && g.result.image, `${g.slug}: a "What you'll get" image`);
        assert.ok(Array.isArray(g.steps) && g.steps.length >= 2, `${g.slug}: numbered steps`);
        for (const s of g.steps) assert.ok(s.title && Array.isArray(s.text) && s.text.length, `${g.slug}: step "${s.title}" has a title and text`);
        assert.ok(Array.isArray(g.notes) && g.notes.length, `${g.slug}: Good to know notes`);
        assert.ok(Array.isArray(g.related) && g.related.length, `${g.slug}: related guides`);
        for (const r of g.related) {
            assert.ok(getGuide(r), `${g.slug}: related guide "${r}" exists`);
            assert.notEqual(r, g.slug, `${g.slug}: does not relate to itself`);
        }
    }
});

test('every guide image is in the manifest and on disk, with alt text and a size', () => {
    const byId = new Map(manifest.images.map((i) => [i.id, i]));
    for (const g of GUIDES) {
        for (const id of imagesIn(g)) {
            const im = byId.get(id);
            assert.ok(im, `${g.slug}: image "${id}" is in manifest.json`);
            assert.ok(fs.existsSync(path.join(pub, 'img/guides', im.file)), `${id}: ${im.file} exists`);
            assert.ok(im.thumb && fs.existsSync(path.join(pub, 'img/guides', im.thumb.file)), `${id}: thumbnail exists`);
            assert.ok(String(im.alt || '').length > 20, `${id}: alt text`);
            assert.ok(im.width > 0 && im.height > 0, `${id}: width and height`);
            assert.deepEqual(guideImage(id).src, `/img/guides/${im.file}`);
        }
    }
});

test('screenshots stay under the size budget', () => {
    const dir = path.join(pub, 'img/guides');
    const total = fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
    assert.ok(total < 6.5 * 1024 * 1024, `img/guides is ${(total / 1048576).toFixed(2)} MB`);
});

test('guides do not offer retired or unsupported platforms', () => {
    for (const g of GUIDES) {
        const text = JSON.stringify(g);
        for (const m of text.matchAll(/reddit/gi)) {
            const around = text.slice(Math.max(0, m.index - 80), m.index + 120);
            assert.match(around, /not available|retired/i, `${g.slug}: Reddit only as not available`);
        }
        for (const m of text.matchAll(/instagram|facebook|threads/gi)) {
            const around = text.slice(Math.max(0, m.index - 120), m.index + 80);
            assert.match(around, /not supported/i, `${g.slug}: ${m[0]} only as not supported`);
        }
    }
});

test('slugs are looked up, never used as paths', () => {
    assert.equal(getGuide('levels').slug, 'levels');
    for (const bad of ['../levels', 'levels/', '..', '', 'LEVELS', 'levels.js', 'index', '__proto__', 'constructor', 'a'.repeat(80), null, undefined, 3]) {
        assert.equal(getGuide(bad), null, `rejects ${String(bad).slice(0, 20)}`);
    }
});

test('inline marks escape everything else', () => {
    assert.equal(inline('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
    assert.equal(inline('use `/a <b>`'), 'use <code>/a &lt;b&gt;</code>');
    assert.equal(inline('**Save**'), '<strong>Save</strong>');
    assert.equal(inline('[docs](/docs)'), '<a href="/docs">docs</a>');
    assert.equal(inline('[x](javascript:alert(1))'), 'x)');
    assert.equal(inline('[x](//evil.example)'), 'x');
    assert.equal(inline('[x](/a" onclick="y)'), '[x](/a&quot; onclick=&quot;y)');
});

// ── rendering ──
test('the guides index renders every guide as a card, by area', () => {
    const html = render('docs-guides', { guide: null, guides: GUIDES, areas: AREAS, guideImage, inline });
    assert.ok(/<h1>Guides<\/h1>/.test(html), '<h1>Guides<\/h1> on the page');
    for (const g of GUIDES) assert.ok(html.includes(`href="/docs/guides/${g.slug}"`), `card for ${g.slug}`);
    for (const img of html.match(/<img\b[^>]*>/g).filter((t) => t.includes('/img/guides/'))) {
        assert.match(img, /\swidth="\d+"/); assert.match(img, /\sheight="\d+"/); assert.match(img, /loading="lazy"/);
        assert.match(img, /\.thumb\.webp"/, 'cards use the thumbnail');
    }
});

test('a guide page renders its result, steps, commands, notes and related guides', () => {
    for (const g of GUIDES) {
        const html = render('docs-guides', { guide: g, guides: GUIDES, areas: AREAS, guideImage, inline });
        assert.ok(html.includes(`<h1>${g.title.replace(/&/g, '&amp;')}</h1>`), `${g.slug}: title`);
        assert.ok(/What you'll get/.test(html), 'What youll get on the page');
        assert.equal((html.match(/<li>\s*<h3 id="step-/g) || []).length, g.steps.length, `${g.slug}: every step`);
        for (const s of g.steps.filter((x) => x.command)) assert.ok(html.includes('data-copy="'), `${g.slug}: command block`);
        assert.ok(/Good to know/.test(html), 'Good to know on the page');
        for (const r of g.related) assert.ok(html.includes(`href="/docs/guides/${r}"`), `${g.slug}: related ${r}`);
        // Heading order: one h1, then h2s, h3 only inside the steps.
        assert.equal((html.match(/<h1\b/g) || []).length, 1);
        const imgs = (html.match(/<img\b[^>]*>/g) || []).filter((t) => t.includes('/img/guides/'));
        assert.ok(imgs.length >= 1, `${g.slug}: images`);
        imgs.forEach((t, i) => {
            assert.match(t, /\salt="[^"]{20,}"/, `${g.slug}: alt text`);
            assert.match(t, /\swidth="\d+" height="\d+"/, `${g.slug}: explicit size`);
            if (i > 0) assert.match(t, /loading="lazy"/, `${g.slug}: images below the first are lazy`);
        });
    }
});

test('docs and the home page render with and without the guides', () => {
    const docs = render('docs-tailwind', {});
    assert.ok(/id="guides"/.test(docs), 'id="guides" on the page');
    assert.ok(docs.includes('href="/docs/guides/levels"'));
    assert.ok(docs.includes('/img/guides/moderation-discord.thumb.webp'), 'feature areas show a small screenshot');
    const bare = render('docs-tailwind', { siteGuides: null });
    assert.equal(bare.includes('id="guides"'), false, 'no Guides section without the guides');
    assert.equal(bare.includes('/img/guides/'), false, 'no screenshots without the guides');
    const landingLocals = { discordHref: '/dashboard', kickHref: '/kick', discordServers: 10, discordUsers: 100, kickChannels: 2, kickEnrolled: 1, phishingBlocked: 5 };
    const home = render('landing-chooser', landingLocals);
    assert.ok(home.includes('<h2 id="show-h">See it in action</h2>'), 'showcase heading');
    const shots = home.match(/<section class="show"[\s\S]*?<\/section>/)[0];
    const n = (shots.match(/<img\b/g) || []).length;
    assert.ok(n >= 3 && n <= 6, `3 to 6 showcase pictures (${n})`);
    // (A failing doesNotMatch on a whole page makes node's assertion diff run for minutes: test booleans.)
    assert.equal(render('landing-chooser', { ...landingLocals, siteGuides: null }).includes('<section class="show"'), false, 'no showcase without the guides');
});

// ── links ──
const routeSource = [path.join(root, 'dashboard/server.js'), ...fs.readdirSync(path.join(root, 'dashboard/routes'), { recursive: true })
    .filter((f) => String(f).endsWith('.js')).map((f) => path.join(root, 'dashboard/routes', String(f)))]
    .map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const commandNames = new Set();
for (const dir of fs.readdirSync(path.join(root, 'commands'))) {
    const d = path.join(root, 'commands', dir);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.js'))) {
        const m = fs.readFileSync(path.join(d, f), 'utf8').match(/new SlashCommandBuilder\(\)\s*\.setName\(\s*['"]([\w-]+)['"]/);
        if (m) commandNames.add(m[1]);
    }
}

function resolves(href) {
    const [p, hash] = href.split('#');
    const pathname = p.split('?')[0];
    if (pathname === '/commands' && hash) return commandNames.has(decodeURIComponent(hash));
    if (/^\/docs\/guides\/[^/]+$/.test(pathname)) return !!getGuide(pathname.split('/').pop());
    if (fs.existsSync(path.join(pub, pathname)) && fs.statSync(path.join(pub, pathname)).isFile()) return true;
    const q = (s) => `['"\`]${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`;
    return new RegExp(q(pathname)).test(routeSource);
}

function checkLinks(html, where) {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const hrefs = [...html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    for (const h of hrefs) {
        if (/^https:\/\//.test(h)) continue;
        if (h === 'mailto:support@certifriedmultitool.com') continue;   // the support address (site footer)
        if (h.startsWith('#')) { assert.ok(ids.has(h.slice(1)), `${where}: ${h} is on the page`); continue; }
        assert.ok(h.startsWith('/'), `${where}: ${h} is a site path`);
        assert.ok(resolves(h), `${where}: ${h} resolves`);
    }
}

test('every link on /docs, the guides and the showcase resolves', () => {
    assert.ok(commandNames.size > 30, 'command names were read');
    checkLinks(render('docs-tailwind', {}), '/docs');
    checkLinks(render('docs-guides', { guide: null, guides: GUIDES, areas: AREAS, guideImage, inline }), '/docs/guides');
    for (const g of GUIDES) {
        checkLinks(render('docs-guides', { guide: g, guides: GUIDES, areas: AREAS, guideImage, inline }), `/docs/guides/${g.slug}`);
        for (const l of linksIn(g)) assert.ok(l.startsWith('/') && resolves(l), `${g.slug}: text link ${l}`);
    }
    const home = render('landing-chooser', { discordHref: '/dashboard', kickHref: '/kick' });
    checkLinks(home.match(/<section class="show"[\s\S]*?<\/section>/)[0], 'home showcase');
});

test('the guides route validates the slug against the data', () => {
    const src = fs.readFileSync(path.join(root, 'dashboard/server.js'), 'utf8');
    const block = src.slice(src.indexOf("app.get(['/docs/guides', '/docs/guides/:slug']"));
    assert.ok(block.length > 0, 'one route for the index and the guides');
    assert.match(block.slice(0, 600), /getGuide\(req\.params\.slug\)/);
    assert.match(block.slice(0, 600), /return next\(\)/);
});
