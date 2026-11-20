import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import { GUIDES, AREAS, getGuide, guideImage, inline } from '../dashboard/content/guides/index.js';
import { normalize, stem, queryTerms, prepare, search } from '../dashboard/public/js/cf-docs-search-core.js';
import { plain, guideEntries, commandEntries, docEntries, buildIndex, toClientJson, groupedResults, createDocsSearch } from '../dashboard/services/docs-search.js';

/*
 * Docs search (2026-11-20): one index of the guides, the /docs and /docs/rpg sections and the command list,
 * searched in the browser by the box on /docs and /docs/guides and on the server by /docs/search?q= (no JS).
 *   - the shared matcher: normalising, stems, filler words, every word must match, title matches rank first
 *   - the index: an entry for every guide and step, every docs section, every command and command path,
 *     and every entry's link resolves (guide pages and step anchors, /docs#ids, /commands#name)
 *   - real queries find the right page first
 *   - the results page and the box: a GET form that works without JavaScript, escaped output, the box on
 *     /docs and /docs/guides, the routes in server.js
 * (Boolean asserts on whole pages: a failing match on a page makes node's diff spin for minutes.)
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const engine = createViewEngine({ viewsDir: views, cache: false });
const siteGuides = { GUIDES, AREAS, getGuide, guideImage, inline };
const render = (template, locals = {}) => engine.renderFile(path.join(views, `${template}.ejs`), {
    user: null, clientId: '100900000000000001', uiTheme: 'dark', uiStyle: 'cards', uiDensity: 'comfortable', csrfToken: 't', siteGuides, ...locals,
});

// A small catalog in the shape core/command-catalog.js builds (the live one needs the bot's command collection).
const catalog = {
    commands: [
        { name: 'level', slash: 'level', type: 'slash', category: 'Leveling', description: 'See your rank and XP in this server', builtinAliases: ['lvl'],
            paths: [
                { path: 'level rank', slash: 'level rank', text: null, description: 'Show your rank card', shortcuts: ['rank'], options: [{ name: 'user' }] },
                { path: 'level setup', slash: 'level setup', text: null, description: 'Set up leveling for this server', shortcuts: [], options: [{ name: 'channel' }] },
            ] },
        { name: 'economy', slash: null, text: '/economy', type: 'text', category: 'Economy', description: 'Balance, daily rewards, shop and gambling', builtinAliases: [],
            paths: [{ path: 'economy bank balance', slash: null, text: '/economy bank balance', description: 'Check your balance', shortcuts: ['bal'], options: [] }] },
        { name: 'Report Message', slash: 'Report Message', type: 'slash', menu: true, category: 'Moderation', description: '', builtinAliases: [], paths: [{ path: 'Report Message', slash: 'Report Message', description: '', options: [] }] },
    ],
};

let docsHtml, rpgHtml, entries, prepared;
test('setup: render the docs pages and build the index', async () => {
    docsHtml = await render('docs-tailwind');
    rpgHtml = await render('docs-rpg');
    entries = buildIndex({ guides: GUIDES, areas: AREAS, catalog, pages: [
        { url: '/docs', page: 'Documentation', html: docsHtml, skip: ['guides', 'features'] },
        { url: '/docs/rpg', page: 'RPG guide', html: rpgHtml },
    ] });
    prepared = prepare(entries);
    assert.ok(entries.length > GUIDES.length * 3);
});

// ── the matcher ──
test('normalising, stems and filler words', () => {
    assert.equal(normalize('  Ánti-Nuke  & Raids! '), 'anti-nuke raids');
    assert.equal(stem('filters'), 'filter');
    assert.equal(stem('logging'), 'logg');
    assert.equal(stem('stories'), 'story');
    assert.equal(stem('class'), 'class', 'a double s is not a plural');
    assert.deepEqual(queryTerms('How do I set up the welcome card?'), ['set', 'up', 'welcome', 'card']);
    assert.deepEqual(queryTerms('how do I'), ['how', 'do', 'i'], 'a query of only filler keeps its words');
    assert.deepEqual(queryTerms(''), []);
});

test('every word must match; titles rank first; prefixes match', () => {
    const idx = prepare([
        { k: 'guide', t: 'Welcome messages and cards', u: '/a', s: 'Greet new members', p: '', x: '' },
        { k: 'step', t: 'Pick a channel', u: '/b', s: 'The welcome channel', p: 'Welcome messages and cards', x: 'card' },
        { k: 'command', t: '/level rank', u: '/c', s: 'Show your rank card', p: '/level', x: 'level rank' },
    ]);
    assert.equal(search(idx, 'welcome')[0].entry.u, '/a');
    assert.deepEqual(search(idx, 'welcome zebra'), [], 'all words must match');
    assert.equal(search(idx, 'welc')[0].entry.u, '/a', 'a prefix matches');
    assert.equal(search(idx, '/level rank')[0].entry.u, '/c', 'a command path, typed with its slash');
    assert.equal(search(idx, 'level rank')[0].entry.u, '/c', 'and without');
    assert.equal(search(idx, 'cards').length, 3, 'plural finds singular');
    assert.deepEqual(search(idx, '   '), []);
    assert.equal(search(idx, 'card', { kinds: new Set(['command']) }).length, 1);
});

// ── the index ──
test('the index has every guide and step, the docs sections and the commands', () => {
    for (const g of GUIDES) {
        assert.ok(entries.some((e) => e.k === 'guide' && e.u === `/docs/guides/${g.slug}`), `guide ${g.slug}`);
        g.steps.forEach((s, i) => assert.ok(entries.some((e) => e.k === 'step' && e.u === `/docs/guides/${g.slug}#step-${i + 1}`), `${g.slug} step ${i + 1}`));
    }
    for (const id of ['getting-started', 'using-commands', 'moderation', 'streams', 'music', 'help']) {
        assert.ok(entries.some((e) => e.k === 'doc' && e.u === `/docs#${id}`), `/docs#${id}`);
    }
    assert.ok(!entries.some((e) => e.u === '/docs#guides'), 'the guide list on /docs is not indexed twice');
    assert.ok(entries.some((e) => e.k === 'doc' && e.u.startsWith('/docs/rpg#')), '/docs/rpg sections');
    assert.ok(entries.some((e) => e.k === 'command' && e.t === '/level rank' && e.u === '/commands#level'));
    assert.ok(entries.some((e) => e.k === 'command' && e.t === '/economy bank balance'), 'text commands as typed');
    const menu = entries.find((e) => e.t === 'Report Message');
    assert.ok(menu && /Right-click menu/.test(menu.p), 'a context menu says how to reach it');
    for (const e of entries) {
        assert.ok(['guide', 'step', 'doc', 'command'].includes(e.k), `kind ${e.k}`);
        assert.ok(e.t && e.u.startsWith('/'), `${e.t}: title and a site link`);
        assert.ok(!/[`*]|\]\(/.test(e.t + e.s), `${e.t}: no inline marks left`);
    }
});

test('every link in the index resolves', () => {
    const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const docIds = ids(docsHtml), rpgIds = ids(rpgHtml);
    for (const e of entries) {
        const [p, hash] = e.u.split('#');
        if (p.startsWith('/docs/guides/')) {
            const g = getGuide(p.split('/').pop());
            assert.ok(g, `${e.u}: guide exists`);
            if (hash) assert.ok(/^step-\d+$/.test(hash) && Number(hash.slice(5)) <= g.steps.length, `${e.u}: step exists`);
        } else if (p === '/docs') assert.ok(docIds.has(hash), `${e.u}: id on /docs`);
        else if (p === '/docs/rpg') assert.ok(rpgIds.has(hash), `${e.u}: id on /docs/rpg`);
        else if (p === '/commands') assert.ok(catalog.commands.some((c) => encodeURIComponent(c.name) === hash), `${e.u}: command`);
        else assert.fail(`${e.u}: unexpected link`);
    }
});

test('real questions find the right page first', () => {
    const top = (q) => search(prepared, q, { limit: 3 }).map((r) => r.entry.u);
    assert.equal(top('welcome card')[0], '/docs/guides/welcome');
    assert.equal(top('raid lockdown')[0], '/docs/guides/raid-protection');
    assert.equal(top('support tickets')[0], '/docs/guides/support-tickets');
    assert.equal(top('/level rank')[0], '/commands#level');
    assert.ok(top('add the bot').some((u) => u.startsWith('/docs/guides/getting-started') || u === '/docs#getting-started'), 'adding the bot');
    assert.deepEqual(search(prepared, 'qqqzzzxx'), []);
});

test('the index the box loads: compact, versioned, small enough', () => {
    const { body, etag } = toClientJson(entries);
    const data = JSON.parse(body);
    assert.equal(data.n, entries.length);
    assert.deepEqual(data.e[0], [entries[0].k, entries[0].t, entries[0].u, entries[0].s, entries[0].p, entries[0].x]);
    assert.match(etag, /^"ds-[0-9a-f]{16}"$/);
    assert.equal(toClientJson(entries).etag, etag, 'same index, same version');
    // Guides and docs only here; the live index adds ~2,300 command paths (about 0.4 MB, gzipped on the wire).
    assert.ok(body.length < 400 * 1024, `${(body.length / 1024).toFixed(0)} KB`);
});

test('plain() drops the guide marks, guideEntries() and commandEntries() handle empty input', () => {
    assert.equal(plain('Use `/level setup` on **Leveling**, see [Levels](/docs/guides/levels).'), 'Use /level setup on Leveling, see Levels.');
    assert.deepEqual(guideEntries([], []), []);
    assert.deepEqual(commandEntries(null), []);
    assert.deepEqual(docEntries('<p>no main</p>', { url: '/x', page: 'X' }), []);
});

test('the live search waits for the command list before it keeps an index', async () => {
    let renders = 0;
    let cat = { commands: [] };
    const ds = createDocsSearch({ getGuides: () => ({ GUIDES, AREAS }), getCatalog: () => cat, renderPages: async () => { renders++; return [{ url: '/docs', page: 'Documentation', html: docsHtml, skip: ['guides'] }]; } });
    const first = await ds.get();
    assert.ok(!first.entries.some((e) => e.k === 'command'), 'no commands before the bot has loaded them');
    cat = catalog;
    const second = await ds.get();
    assert.ok(second.entries.some((e) => e.k === 'command'));
    assert.equal(await ds.get(), second, 'kept once the command list is there');
    assert.equal(renders, 1, 'the docs pages are rendered once');
    const res = await ds.search('level rank');
    assert.equal(res.groups[0].id, 'guides');
    assert.ok(res.groups.find((g) => g.id === 'commands').results.some((r) => r.u === '/commands#level'));
});

// ── the pages ──
test('/docs/search works without JavaScript and escapes the query', async () => {
    const html = await render('docs-search', { q: 'welcome', results: groupedResults(prepared, 'welcome') });
    assert.ok(/<title>Search the docs · CertiFried<\/title>/.test(html), 'title');
    assert.ok(/<form class="cf-dsearch" action="\/docs\/search" method="get" role="search"/.test(html), 'a plain GET form');
    assert.ok(/name="q" value="welcome"/.test(html), 'the query is kept in the box');
    assert.ok(html.includes('href="/docs/guides/welcome"'), 'the welcome guide is a result');
    assert.ok(/<meta name="robots" content="noindex/.test(html), 'results pages are not indexed');
    const evil = '"><script>alert(1)</script>';
    const bad = await render('docs-search', { q: evil, results: groupedResults(prepared, evil) });
    assert.equal(bad.includes('<script>alert(1)</script>'), false, 'the query is escaped');
    const none = await render('docs-search', { q: 'qqqzzzxx', results: groupedResults(prepared, 'qqqzzzxx') });
    assert.ok(/Nothing matches/.test(none));
    const empty = await render('docs-search', { q: '', results: null });
    assert.ok(/all guides/.test(empty) && /\sautofocus/.test(empty), 'no query: tips, and the box has focus');
    const down = await render('docs-search', { q: 'x', results: null, unavailable: true });
    assert.ok(/not available right now/.test(down));
});

test('the search box is on /docs and /docs/guides, and the routes exist', async () => {
    const docs = docsHtml;
    const guides = await render('docs-guides', { guide: null, guides: GUIDES, areas: AREAS, guideImage, inline });
    for (const [where, html] of [['/docs', docs], ['/docs/guides', guides]]) {
        assert.ok(html.includes('data-docs-search') && html.includes('action="/docs/search"'), `${where}: the box`);
        assert.ok(html.includes('<script type="module" src="/js/cf-docs-search.js">'), `${where}: the script`);
        assert.ok(/<label class="cf-dsearch-label" for="cfDocsQ">/.test(html), `${where}: a label for the input`);
    }
    for (const f of ['dashboard/public/js/cf-docs-search.js', 'dashboard/public/js/cf-docs-search-core.js']) assert.ok(fs.existsSync(path.join(root, f)), f);
    const server = fs.readFileSync(path.join(root, 'dashboard/server.js'), 'utf8');
    assert.ok(server.includes("app.get('/docs/search.json'") && server.includes("app.get('/docs/search'"), 'routes in server.js');
    const client = fs.readFileSync(path.join(root, 'dashboard/public/js/cf-docs-search.js'), 'utf8');
    for (const key of ['ArrowDown', 'ArrowUp', 'Escape', 'Enter', "'/'", 'aria-activedescendant', 'aria-expanded']) {
        assert.ok(client.includes(key), `the box handles ${key}`);
    }
    assert.equal(/https?:\/\//.test(client), false, 'no outside service');
});
