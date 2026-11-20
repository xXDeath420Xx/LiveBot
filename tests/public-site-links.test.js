import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { CATEGORIES, LEGAL_DOCS, STUDIO_FACTS, retentionText } from '../dashboard/content/legal/data-inventory.js';
import * as spritePages from '../dashboard/services/sprites-pages.js';
import { scheduleSharePage } from '../dashboard/services/schedule-share-page.js';

/*
 * Public site pass (2026-11-19): every logged-out page outside the home page and the docs.
 *   - renders each template with the locals its route passes;
 *   - every internal link, button and form action on it resolves to a route the dashboard
 *     really mounts (a route table read from dashboard/server.js and dashboard/routes/), or to
 *     a file in dashboard/public, and in-page anchors on other pages exist;
 *   - no links to retired pages (/tokes-bot, /cfx, /game, Reddit) and no plain-http links;
 *   - page titles read "<Page> · CertiFried", and the shared head carries a description.
 * No server is started: the route table is built from the source, so the test also catches a
 * route that was renamed or removed while a page still links to it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const pub = path.join(root, 'dashboard/public');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// ── Route table ─────────────────────────────────────────────────────────────

function routeFiles() {
    const out = [];
    (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) out.push(p);
        }
    })(path.join(root, 'dashboard/routes'));
    return out;
}

/** Where each routes/ file is mounted: rel path -> [prefix, ...]. */
function mountPrefixes(server) {
    const mounts = new Map();
    const add = (file, prefix) => {
        const rel = path.normalize(path.join('dashboard', file));
        if (!mounts.has(rel)) mounts.set(rel, new Set());
        mounts.get(rel).add(prefix);
    };
    const identFile = new Map();
    for (const m of server.matchAll(/^import\s+(\w+)\s+from\s+'\.\/(routes\/[^']+\.js)';/gm)) identFile.set(m[1], m[2]);
    // Dynamic imports: import('./routes/x.js').then(({ default: name }) => { ... app.use(..., name) })
    for (const m of server.matchAll(/import\('\.\/(routes\/[^']+\.js)'\)\.then\(\(\{\s*default:\s*(\w+)\s*\}\)\s*=>\s*\{([\s\S]{0,400}?)\}\)/g)) {
        const use = m[3].match(new RegExp(`app\\.use\\((?:'([^']*)',\\s*)?(?:[^)]*?,\\s*)?${m[2]}\\)`));
        if (use) add(m[1], use[1] && !use[1].includes(':') ? use[1].replace(/\/$/, '') : '');
    }
    for (const m of server.matchAll(/app\.use\((?:'([^']*)',\s*)?(?:[\w\s,]*?,\s*)?(\w+)(\(\))?\)/g)) {
        const file = identFile.get(m[2]);
        if (file) add(file, m[1] && !m[1].includes(':') ? m[1].replace(/\/$/, '') : '');
    }
    // Lazily loaded routers: app.use('/api...', async (req, res, next) => { ... import('./routes/x.js') ... })
    for (const m of server.matchAll(/app\.use\('([^']+)',\s*async[\s\S]{0,300}?import\('\.\/(routes\/[^']+\.js)'\)/g)) add(m[2], m[1]);
    return mounts;
}

function expressToRegex(p) {
    // Strip inline param patterns like :id([0-9]+) and template-literal groups, then map params.
    let s = p.replace(/\$\{[^}]*\}/g, '[^/]+').replace(/\(([^()]*(\([^()]*\))?[^()]*)\)/g, '');
    s = s.split('*').map((part) => part.split(/(:\w+\??)/).map((seg) => {
        if (/^:\w+\?$/.test(seg)) return '([^/]+)?';
        if (/^:\w+$/.test(seg)) return '[^/]+';
        return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }).join('')).join('.*');
    return s;
}

function buildRouteTable() {
    const server = read('dashboard/server.js');
    const mounts = mountPrefixes(server);
    const exact = [];
    const prefix = [];
    const collect = (src, prefixes) => {
        for (const m of src.matchAll(/\b(?:app|router)\.(get|all|use)\(\s*(['"`])(\/[^'"`]*)\2/g)) {
            for (const pre of prefixes) {
                const full = (pre + (m[3] === '/' && pre ? '' : m[3])) || '/';
                (m[1] === 'use' ? prefix : exact).push(full);
            }
        }
        for (const m of src.matchAll(/\b(?:app|router)\.(get|all)\(\s*\[([^\]]+)\]/g)) {
            for (const lit of m[2].matchAll(/'(\/[^']*)'/g)) for (const pre of prefixes) exact.push((pre + lit[1]) || '/');
        }
    };
    collect(server, ['']);
    for (const f of routeFiles()) {
        const rel = path.relative(root, f);
        const pres = mounts.get(path.normalize(rel));
        if (!pres) continue; // not mounted anywhere: its routes do not exist
        collect(fs.readFileSync(f, 'utf8'), [...pres]);
    }
    const exactRe = exact.map((p) => new RegExp('^' + expressToRegex(p) + '/?$'));
    const prefixRe = prefix.map((p) => new RegExp('^' + expressToRegex(p) + '(/|$)'));
    return {
        exact, prefix,
        has(pathname) {
            if (exactRe.some((r) => r.test(pathname))) return true;
            if (prefixRe.some((r) => r.test(pathname))) return true;
            const file = path.join(pub, decodeURIComponent(pathname));
            return file.startsWith(pub) && fs.existsSync(file) && fs.statSync(file).isFile();
        },
    };
}

const routes = buildRouteTable();

// ── The pages ───────────────────────────────────────────────────────────────

const catalog = {
    prefixes: ['!', '?'], mentionForm: '@CertiFried',
    stats: { commands: 2, topLevel: 2, textCommands: 1, paths: 3, slashOnly: 0, gated: 1, aliasable: 2, serverOnly: 0 },
    commands: [
        { name: 'music', slash: 'music', type: 'slash', category: 'music', description: 'Play music', builtinAliases: ['m'], aliasable: true, gated: false, permissions: [], adminOnly: false, opensModal: false,
          paths: [{ path: 'music play', slash: 'music play', description: 'Play a song', shortcuts: ['p'], options: [], slashOnly: false, slashOnlyReasons: [] }] },
    ],
};
const guild = { id: '123456789012345678', name: 'Test server', icon: null, memberCount: 42 };
const event = { id: 1, name: 'Test marathon', slug: 'test-marathon', description: 'A test event: two days of runs, start times in UTC.', twitch_channel: 'someone', website_url: 'https://example.com', twitter_handle: 'someone', is_active: 1 };
const sched = { id: 1, event_id: 1, name: 'Day 1', slug: 'day-1', start_time: new Date('2026-12-01T12:00:00Z'), setup_time_seconds: 300, timezone: 'UTC' };
const item = { id: 1, schedule_id: 1, position: 1, title: 'A game', runner: 'someone', category: 'Any%', estimate_seconds: 1800, status: 'pending', estimated_start: new Date('2026-12-01T12:00:00Z') };

const PAGES = [
    ['/commands', 'commands-catalog', { user: null, catalog, categories: ['music'] }],
    ['/compare', 'feature-matrix-tailwind', { user: null }],
    ['/status', 'status-tailwind', { user: null, stats: { guilds: 1, members: 2, uptime: 60, ping: 40 }, liveStreamers: [{ username: 'someone', display_name: 'someone', platform: 'twitch', allPlatforms: ['twitch'], profile_image_url: null }] }],
    ['/changelog', 'changelog-tailwind', { user: null, entries: [{ id: 1, title: 'first change', desc: 'Something', date: '2026-11-18' }] }],
    ['/donate', 'donate-tailwind', { user: null }],
    ['/privacy', 'privacy-tailwind', { user: null }],
    ['/terms', 'terms-tailwind', { user: null }],
    ['/eula', 'eula-tailwind', { user: null }],
    ['/report', 'report-tailwind', { user: null }],
    ['/appeal', 'appeal-tailwind', { user: null }],
    ['/cards', 'cards-landing', { user: null }],
    ['/stream-team', 'stream-team-tailwind', { user: null }],
    ['/docs/rpg', 'docs-rpg', { user: null }],
    ['/tools/jwt', 'tools-jwt', { user: null }],
    ['/lb/' + guild.id, 'public-leaderboard', { user: null, guild, users: [{ rank: 1, userId: '1', displayName: 'A', username: 'a', avatarURL: 'https://cdn.discordapp.com/embed/avatars/0.png', level: 2, xp: 10, xpForNext: 100, xpProgress: 10, totalXP: 110 }], pagination: { page: 1, totalPages: 2, total: 30, limit: 25 }, error: null }],
    ['/supporters/' + guild.id, 'community-support-leaderboard', { user: null, guild, isAdmin: false, scoring: {}, users: [], entriesByUser: {}, pagination: { page: 1, totalPages: 1, total: 0, limit: 25 }, monthKey: '2026-11', availableMonths: ['2026-11'], error: null }],
    ['/schedule', 'public-schedule-list', { events: [], monthEvents: [], calendar: [[{ day: null, events: [] }, { day: 1, date: new Date(2026, 10, 1), events: [] }]], year: 2026, month: 11, monthName: 'November', twitchUser: null }],
    ['/schedule/test-marathon', 'public-schedule', { error: null, event, schedules: [sched], currentSchedule: sched, items: [item], twitchUser: null }],
    ['/no-such-page', 'error-tailwind', { user: null, error: 'Not here', statusCode: 404 }],
    // CertiFried Studio download page (dashboard/routes/downloads.js): published, and not yet published.
    ['/downloads/studio', 'studio-download', { user: null, release: { version: '0.2.0', releaseDate: '2026-11-19T12:00:00.000Z', sums: true, builds: [
        { kind: 'setup', label: 'Installer', file: 'CertiFried-Studio-Setup-0.2.0.exe', size: 90000000, sha256: 'a'.repeat(64) },
        { kind: 'portable', label: 'Portable (no install)', file: 'CertiFried-Studio-Portable-0.2.0.exe', size: 89000000, sha256: 'b'.repeat(64) }] } }],
    ['/downloads/studio?empty', 'studio-download', { user: null, release: null }],
    // CertiFried Studio pages and the legal hub (dashboard/routes/legal-pages.js).
    ['/studio', 'studio-overview', { user: null, facts: STUDIO_FACTS }],
    ['/studio/how-it-works', 'studio-how-it-works', { user: null, facts: STUDIO_FACTS }],
    ['/studio/privacy', 'studio-privacy', { user: null, facts: STUDIO_FACTS }],
    ['/studio/faq', 'studio-faq', { user: null, facts: STUDIO_FACTS }],
    ['/legal', 'legal-hub', { user: null, docs: LEGAL_DOCS }],
    ['/legal/data', 'legal-data', { user: null, categories: CATEGORIES, retention: (r) => retentionText(r, null), liveRetention: false }],
    // Viewer data page (dashboard/routes/privacy-viewer.js, H-772): signed out, and signed in with counts and a result.
    ['/privacy/viewer', 'privacy-viewer', { user: null, accounts: [], providers: { twitch: true, kick: true }, counts: null, message: null, error: null, deleted: null }],
    ['/privacy/viewer?signed-in', 'privacy-viewer', { user: null, accounts: [{ platform: 'twitch', login: 'maplefan_88', name: 'MapleFan_88' }], providers: { twitch: true, kick: true },
        counts: [{ table: 'stream_bot_events_about_you', total: 3 }], message: 'Done. Your data is deleted.', error: null, deleted: [{ table: 'stream_bot_events', n: 3 }] }],
];

// Pages built as strings and rendered through the shared frame (views/site-frame.ejs).
const framed = (page, p) => spritePages.framedOptions({ baseUrl: '/sprites', path: p }, page[spritePages.FRAMED_PAGE]);
PAGES.push(
    ['/sprites', 'site-frame', { user: null, ...framed(spritePages.renderLogin(), '/') }],
    ['/sprites/account', 'site-frame', { user: null, ...framed(spritePages.renderAccount({ displayName: 'JuniperVale', currentUsername: 'juniper', hasPassword: true }), '/account') }],
    ['/schedule/rowanpike_plays', 'site-frame', { user: null, ...scheduleSharePage('rowanpike_plays') }],
    ['/420/obs', 'fourtwenty-obs-builder', { user: null }],
);

const rendered = new Map();
for (const [url, view, locals] of PAGES) {
    rendered.set(url, { view, html: ejs.render(fs.readFileSync(path.join(views, view + '.ejs'), 'utf8'), locals, { filename: path.join(views, view + '.ejs') }) });
}

function links(html) {
    const out = new Set();
    for (const m of html.matchAll(/\s(?:href|action|src)="([^"]*)"/g)) out.add(m[1].replace(/&amp;/g, '&'));
    return [...out];
}

const RETIRED = [/^\/tokes-bot(\/|$)(?!auth\/kick)/, /^\/cfx(\/|$)/, /^\/game(\/|$)/, /reddit/i, /^\/pricing(\/|$)/];

// ── Tests ───────────────────────────────────────────────────────────────────

test('route table: built from the source and sane', () => {
    for (const p of ['/', '/commands', '/status', '/privacy', '/greenhouse', '/cah', '/sprites', '/lb/1', '/schedule', '/api/status/public/overview', '/css/cf-site.css']) {
        assert.ok(routes.has(p), `${p} is in the route table`);
    }
    for (const p of ['/no-such-page', '/reddit', '/tokes']) assert.ok(!routes.has(p), `${p} is not a route`);
});

test('every internal link on the public pages resolves to a mounted route or a public file', () => {
    const broken = [];
    for (const [url, { html }] of rendered) {
        for (const l of links(html)) {
            if (!l || l.startsWith('#') || /^(mailto|tel|javascript|data):/.test(l)) continue;
            if (/^https?:\/\//.test(l) && !/^https?:\/\/(www\.)?certifriedmultitool\.com(\/|$)/.test(l)) continue;
            const u = new URL(l, 'https://certifriedmultitool.com' + url);
            if (!routes.has(u.pathname)) broken.push(`${url}: ${l}`);
        }
    }
    assert.deepEqual(broken, []);
});

test('anchors that point into another page exist on that page', () => {
    const targets = { '/terms': 'terms-tailwind', '/privacy': 'privacy-tailwind', '/eula': 'eula-tailwind', '/docs/rpg': 'docs-rpg', '/compare': 'feature-matrix-tailwind', '/docs': 'docs-tailwind',
        '/studio/how-it-works': 'studio-how-it-works', '/studio/privacy': 'studio-privacy', '/studio/faq': 'studio-faq', '/legal/data': 'legal-data' };
    const missing = [];
    for (const [url, { html }] of rendered) {
        for (const l of links(html)) {
            const m = l.match(/^(\/[^#?]*)#([\w-]+)$/);
            if (!m || !targets[m[1]]) continue;
            const src = fs.readFileSync(path.join(views, targets[m[1]] + '.ejs'), 'utf8');
            // legal-data.ejs builds its section ids from the inventory (id="<%= c.id %>").
            const dynamic = targets[m[1]] === 'legal-data' && CATEGORIES.some((c) => c.id === m[2]);
            if (!dynamic && !new RegExp(`id=["']${m[2]}["']`).test(src)) missing.push(`${url}: ${l}`);
        }
    }
    assert.deepEqual(missing, []);
});

test('no links to retired pages, and every external link is https', () => {
    const bad = [];
    for (const [url, { html }] of rendered) {
        for (const l of links(html)) {
            if (l.startsWith('http://')) bad.push(`${url}: plain http ${l}`);
            const p = l.startsWith('/') ? l.split(/[?#]/)[0] : '';
            if (p && RETIRED.some((r) => r.test(p))) bad.push(`${url}: retired ${l}`);
            if (/reddit\.com/i.test(l)) bad.push(`${url}: Reddit link ${l}`);
        }
    }
    assert.deepEqual(bad, []);
});

test('titles read "<Page> · CertiFried" and every page has a meta description', () => {
    for (const [url, { html }] of rendered) {
        const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
        assert.match(title, /^\S.* · CertiFried$/, `${url} title: ${title}`);
        assert.doesNotMatch(title, /MultiTool|\s\|\s|\s-\s/, `${url} title uses the old form: ${title}`);
        assert.match(html, /<meta name="description" content="[^"]{20,}">/, `${url} has a description`);
        assert.match(html, /<meta property="og:title" content="[^"]+">/, `${url} has Open Graph tags`);
    }
});

test('public pages sit on the shared frame and load no old one-off CSS', () => {
    for (const [url, { html, view }] of rendered) {
        assert.match(html, /<body class="cfs-body/, `${url} (${view}) uses body.cfs-body`);
        assert.match(html, /class="cfs-header"/, `${url} has the site header`);
        assert.match(html, /class="cfs-footer"/, `${url} has the site footer`);
        assert.match(html, /<main[^>]*id="main-content"/, `${url} has main#main-content for the skip link`);
        for (const old of ['bootstrap.min.css', 'jquery', 'family=Inter', 'unified-dark-theme.css', 'modern-framework.css', 'dropdowns.css']) {
            assert.ok(!html.includes(old), `${url} still loads ${old}`);
        }
    }
});

test('the footer links the legal hub, CertiFried Studio and the source code (AGPL section 13)', () => {
    const footer = fs.readFileSync(path.join(views, 'partials/site-footer.ejs'), 'utf8');
    assert.match(footer, /href="\/legal"/);
    assert.match(footer, /href="\/studio"/);
    assert.match(footer, /href="https:\/\/github\.com\/xXDeath420Xx\/LiveBot"[^>]*>Source code/);
    assert.ok(routes.has('/studio/eula'), '/studio/eula redirects to the EULA');
});

test('the footer links to Greenhouse Tycoon, not the retired game', () => {
    const footer = fs.readFileSync(path.join(views, 'partials/site-footer.ejs'), 'utf8');
    assert.match(footer, /href="\/greenhouse"/);
    assert.doesNotMatch(footer, /href="\/(game|cfx)"/);
});
