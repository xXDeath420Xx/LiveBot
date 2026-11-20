import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

/*
 * The public CertiFried Studio pages, the legal hub and "Data we collect" (dashboard/routes/legal-pages.js,
 * dashboard/content/legal/data-inventory.js), and the legal documents they sit beside (2026-11-19).
 *
 *   - The Studio facts the pages state still hold in desktop/studio/src: defaults (microphone off, start with Windows
 *     off, update checks on, OBS port), log rotation, update interval, the default device name.
 *   - "No telemetry" stays true: Studio's dependencies are the four the privacy page names, its source has no
 *     analytics or crash-reporting code, its window may not load remote content, and the OBS report it sends has
 *     exactly the fields /studio/privacy lists. A change here means /studio/privacy must change first.
 *   - The stream bot retention shown on /legal/data and /privacy equals the migrations' data_retention_policy rows.
 *   - The pages render, carry the source code link (AGPL section 13), and the legal documents say AGPL, not MIT.
 * Link checking for these pages is in tests/public-site-links.test.js.
 * Assertions on rendered pages are booleans: a failing assert.match on a whole page makes node's diff spin for minutes.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const studio = path.join(root, 'desktop/studio');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const require = createRequire(import.meta.url);

const inv = await import('../dashboard/content/legal/data-inventory.js');
const { CATEGORIES, LEGAL_DOCS, STUDIO_FACTS, retentionText } = inv;
const render = (view, locals) => ejs.render(fs.readFileSync(path.join(views, view + '.ejs'), 'utf8'), locals, { filename: path.join(views, view + '.ejs') });

// ── Studio facts ──────────────────────────────────────────────────────────────────────────────

test('Studio facts on the pages match the app', () => {
    const { DEFAULTS } = require(path.join(studio, 'src/main/config.js'));
    assert.equal(DEFAULTS.voice.enabled, false, 'microphone off by default');
    assert.equal(DEFAULTS.app.startWithWindows, false);
    assert.equal(DEFAULTS.app.checkUpdates, true, 'update checks on by default, can be turned off');
    assert.equal(DEFAULTS.obs.port, STUDIO_FACTS.obsPort);
    assert.equal(DEFAULTS.obs.host, '127.0.0.1');
    const logger = fs.readFileSync(path.join(studio, 'src/main/logger.js'), 'utf8');
    assert.ok(logger.includes(`maxBytes = ${STUDIO_FACTS.logMb === 1 ? '1024 * 1024' : 'x'}`), 'log files of 1 MB');
    assert.ok(logger.includes(`keep = ${STUDIO_FACTS.logKeep}`), `${STUDIO_FACTS.logKeep} old log files`);
    for (const re of [/SECRET_KEY = \/pass\(word\)\?\|token\|secret/, /TOKEN_RE = \/sbd_/, /CODE_RE/]) assert.ok(re.test(logger), `logger redacts ${re}`);
    const updater = fs.readFileSync(path.join(studio, 'src/main/updater.js'), 'utf8');
    assert.ok(updater.includes(`everyMs = ${STUDIO_FACTS.updateHours} * 60 * 60 * 1000`), 'update interval');
    const main = fs.readFileSync(path.join(studio, 'src/main/main.js'), 'utf8');
    assert.ok(main.includes("`CertiFried Studio on ${require('node:os').hostname()}`"), 'default device name is "CertiFried Studio on <PC name>"');
    assert.ok(main.includes("path.join(app.getPath('pictures'), 'CertiFried Studio')"), 'screenshots folder');
    const pkg = JSON.parse(fs.readFileSync(path.join(studio, 'package.json'), 'utf8'));
    assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false, 'uninstalling keeps the settings folder (the pages say so)');
});

test('no telemetry: dependencies, source, window policy and the OBS report are what /studio/privacy says', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(studio, 'package.json'), 'utf8'));
    // 0.2.6 (Phase 5): multicast-dns (finding lights), node-hid (Logitech Litra over USB), koffi (Voicemeeter's Remote API).
    const allowed = ['electron-updater', 'obs-websocket-js', 'uiohook-napi', 'ws', 'multicast-dns', 'node-hid', 'koffi'];
    for (const dep of Object.keys(pkg.dependencies || {})) {
        assert.ok(allowed.includes(dep), `new Studio dependency ${dep}: review it and update /studio/privacy ("No telemetry") first`);
    }
    const files = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|html|ps1)$/.test(e.name)) files.push(p); } })(path.join(studio, 'src'));
    const banned = /crashReporter\.start|sentry|posthog|mixpanel|amplitude|segment\.io|google-analytics|googletagmanager|gtag\(|appinsights|bugsnag|datadog|telemetry\s*=\s*true/i;
    for (const f of files) assert.ok(!banned.test(fs.readFileSync(f, 'utf8')), `${path.relative(studio, f)}: analytics or crash reporting found; /studio/privacy says there is none`);
    const html = fs.readFileSync(path.join(studio, 'src/renderer/index.html'), 'utf8');
    assert.ok(/Content-Security-Policy" content="default-src 'none'/.test(html), 'the window loads nothing remote');
    const site = require(path.join(studio, 'src/main/site.js'));
    assert.equal(site.SITE, 'https://certifriedmultitool.com');
    // The OBS report (main.js fitState): exactly the fields the privacy page lists.
    const main = fs.readFileSync(path.join(studio, 'src/main/main.js'), 'utf8');
    const fit = main.slice(main.indexOf('function fitState('), main.indexOf('let stateTimer'));
    const obsKeys = (fit.match(/obs: \{([^}]*)\}/) || [])[1].split(',').map((s) => s.split(':')[0].trim()).sort();
    assert.deepEqual(obsKeys, ['connected', 'currentScene', 'filters', 'inputs', 'scenes', 'sources', 'studioMode', 'version'].sort(), 'OBS report fields changed: update /studio/privacy');
    const musicKeys = (fit.match(/state\.music = \{([^}]*)\}/) || [])[1].split(',').map((s) => s.split(':')[0].trim()).sort();
    assert.deepEqual(musicKeys, ['checkedAt', 'live', 'liveTrack', 'reason', 'sourceReady', 'vodSafe', 'vodTrack'].sort(), 'VOD status fields changed: update /studio/privacy');
    assert.ok(/sounds: sounds\.slice\(0, 500\)/.test(fit), 'only sound names are reported');
    // Phase 5 device report (main.js devicesReport): exactly the fields /studio/privacy lists, never an address or a token.
    assert.ok(fit.includes('state.devices = devicesReport();'), 'the device report goes with the OBS report');
    const dev = main.slice(main.indexOf('function devicesReport('), main.indexOf('function lightsView('));
    const lightKeys = (dev.match(/map\(\(d\) => \(\{ ([^}]*?),\s*caps:/) || [])[1].split(',').map((x) => x.split(':')[0].trim()).sort();
    assert.deepEqual(lightKeys, ['driver', 'id', 'kind', 'model', 'name', 'needsPairing', 'online'].sort(), 'light fields changed: update /studio/privacy');
    assert.ok(!/address|serial|token|secret/i.test(dev.replace(/\/\*\*[^]*?\*\//, '')), 'no address, token or secret in the device report');
    assert.ok(/voicemeeter: \{ enabled:[^]*?profiles: vmInfo\?\.profiles/.test(dev) && /streamdeck: \{ enabled: [^,]*, clients:/.test(dev), 'Voicemeeter and Stream Deck parts as listed');
    // The Stream Deck connection listens on this PC only and refuses web pages.
    const bridge = fs.readFileSync(path.join(studio, 'src/main/bridge-server.js'), 'utf8');
    assert.ok(bridge.includes("const HOST = '127.0.0.1';") && /origin/i.test(bridge), 'Stream Deck bridge: 127.0.0.1, Origin refused');
    // Lights are only searched for after Find lights; Voicemeeter and the Stream Deck are off by default.
    const { DEFAULTS: D } = require(path.join(studio, 'src/main/config.js'));
    assert.equal(D.lights.enabled, false);
    assert.equal(D.voicemeeter.enabled, false);
    assert.equal(D.streamdeck.enabled, false);
    // VOD-safe music only while song requests are on (H-771): unknown means not enforced; the minute timer waits for it.
    assert.ok(main.includes("enforced: config.get().music.songRequests === true") && main.includes('if (obs.connected && vodSafe.enforced())'), 'VOD protection waits for song requests');
    const vodSrc = fs.readFileSync(path.join(studio, 'src/main/vod-safe.js'), 'utf8');
    assert.ok(vodSrc.includes('if (!enforcing) return inform();') && vodSrc.includes('async removeSource()'), 'off: read only; the source is removed only on a click');
    // Voice: only the phrase and its confidence leave the PC.
    assert.ok(main.includes("sendEvent({ type: 'voice.phrase', metadata: { phrase: text, confidence } })"), 'voice sends the phrase and confidence only');
    const obs = fs.readFileSync(path.join(studio, 'src/main/obs.js'), 'utf8');
    assert.ok(obs.includes('path.basename(String(d.savedReplayPath))'), 'a saved replay is reported by file name only');
});

// ── retention ─────────────────────────────────────────────────────────────────────────────────

test('stream bot retention on /legal/data equals the migrations, and every table row has a fallback', async () => {
    const rows = new Map();
    for (const m of ['454_stream_bot.js', '455_stream_bot_imports.js', '457_stream_bot_music.js', '462_stream_bot_device_retention.js', '464_stream_bot_viewers.js', '470_stream_bot_youtube.js']) {
        for (const [table, , days] of (await import(`../migrations/${m}`)).RETENTION_ROWS) rows.set(table, days);
    }
    let checked = 0;
    for (const c of CATEGORIES) {
        for (const r of c.rows) {
            assert.ok(r.data && r.purpose && r.where && r.who && r.remove, `${c.id}: every column is filled (${r.data})`);
            const t = r.retention || {};
            assert.ok(t.table || t.feature || t.none, `${c.id}: ${r.data} says how long`);
            if (t.table) assert.ok(Number.isInteger(t.days) && t.days > 0, `${t.table}: written fallback`);
            if (t.table && rows.has(t.table)) { assert.equal(t.days, rows.get(t.table), `${t.table} retention`); checked++; }
        }
    }
    assert.ok(checked >= 8, `${checked} stream bot rows checked`);
    const privacy = read('dashboard/views/privacy-tailwind.ejs');
    for (const [label, table] of [['Stream bot event log', 'stream_bot_events'], ['Stream bot run history', 'stream_bot_runs'], ['Stream bot actions sent to CertiFried Studio', 'stream_bot_dispatch_queue'], ['Stream bot pairing codes', 'stream_bot_pairing_codes'], ['Song requests (who asked', 'stream_bot_music_requests'], ['Song likes', 'stream_bot_music_likes'], ['Firebot and Streamer.bot import reports', 'stream_bot_imports'], ['Revoked stream bot devices', 'stream_bot_devices'], ['Stream bot viewer records', 'stream_bot_viewers'], ['Stream bot viewer point history', 'stream_bot_viewer_history'], ['Stream bot YouTube quota use', 'stream_bot_youtube_quota']]) {
        const i = privacy.indexOf(label);
        assert.ok(i > 0, `/privacy lists ${label}`);
        const days = rows.get(table);
        assert.ok(privacy.slice(i, i + 400).includes(`${days === 1 ? '1 day' : `${days} days`}`), `/privacy: ${label} is ${days} days`);
    }
});

test('retentionText: the live table wins, the written value is the fallback, no limit is said plainly', () => {
    const row = { retention: { table: 'stream_bot_events', days: 90, after: '' } };
    assert.deepEqual(retentionText(row, new Map([['stream_bot_events', { days: 60, enabled: true }]])), { text: '60 days', kind: 'policy' });
    assert.deepEqual(retentionText(row, null), { text: '90 days', kind: 'written' });
    assert.deepEqual(retentionText(row, new Map()), { text: '90 days', kind: 'written' });
    assert.deepEqual(retentionText({ retention: { table: 'x', days: 1, after: '(24 hours)' } }, null), { text: '1 day (24 hours)', kind: 'written' });
    assert.equal(retentionText({ retention: { none: true, text: 'Kept until you delete it' } }, null).kind, 'none');
    assert.equal(retentionText({ retention: { feature: true, text: '30 days' } }, null).kind, 'feature');
});

test('retentionPolicies reads data_retention_policy once per 10 minutes and survives a database error', async () => {
    const { retentionPolicies } = await import('../dashboard/routes/legal-pages.js');
    let calls = 0;
    const load = async () => { calls++; return [{ table_name: 'stream_bot_runs', retain_days: 30, enabled: 1 }]; };
    const failing = async () => { throw new Error('down'); };
    const t0 = 5_000_000_000_000;
    assert.equal(await retentionPolicies({ now: t0 - 3_600_000, load: failing }), null, 'an error gives null (the page shows the written values)');
    const m = await retentionPolicies({ now: t0, load });
    assert.deepEqual(m.get('stream_bot_runs'), { days: 30, enabled: true });
    await retentionPolicies({ now: t0 + 60_000, load });
    assert.equal(calls, 1, 'cached');
});

// ── routes and pages ──────────────────────────────────────────────────────────────────────────

test('the routes exist and server.js mounts them', () => {
    const src = read('dashboard/routes/legal-pages.js');
    for (const p of ['/studio', '/studio/how-it-works', '/studio/privacy', '/studio/faq', '/studio/eula', '/legal', '/legal/data']) {
        assert.ok(src.includes(`router.get('${p}',`), `GET ${p}`);
    }
    assert.ok(/import\('\.\/routes\/legal-pages\.js'\)\.then\(\(\{ default: legalPagesRouter \}\) => \{\s*app\.use\('\/', legalPagesRouter\);/.test(read('dashboard/server.js')), 'mounted in server.js');
});

test('the pages render with the source code link, AGPL wording and their key statements', () => {
    const f = { facts: STUDIO_FACTS, user: null };
    const pages = {
        overview: render('studio-overview', f), how: render('studio-how-it-works', f), privacy: render('studio-privacy', f), faq: render('studio-faq', f),
        hub: render('legal-hub', { user: null, docs: LEGAL_DOCS }),
        data: render('legal-data', { user: null, categories: CATEGORIES, retention: (r) => retentionText(r, null), liveRetention: false }),
    };
    const repo = 'href="https://github.com/xXDeath420Xx/LiveBot"';
    for (const [k, html] of Object.entries(pages)) {
        assert.ok(html.includes(repo), `${k}: links the source code`);
        assert.ok(!/\bMIT\b/.test(html), `${k}: no MIT wording (the licence is AGPL-3.0-or-later)`);
    }
    assert.ok(pages.overview.includes('AGPL-3.0-or-later') && pages.overview.includes(STUDIO_FACTS.dbad), 'overview: AGPL and the DBAD note');
    assert.ok(pages.privacy.includes('no analytics, telemetry, crash reporting or advertising code'), 'privacy: no telemetry');
    assert.ok(pages.privacy.includes('x-user-staging-id') === false && pages.privacy.includes('.updaterId'), 'privacy: the updater ID is disclosed in plain words');
    // H-767 (Studio 0.2.5): no per-install ID any more; the page says the file is removed and the same all-zero ID is sent.
    assert.ok(pages.privacy.includes('0.2.5 and later delete that file') && pages.privacy.includes('same all-zero ID from every PC'), 'privacy: no install ID from 0.2.5');
    const upd = fs.readFileSync(path.join(root, 'desktop/studio/src/main/updater.js'), 'utf8');
    assert.ok(upd.includes("const NIL_UUID = '00000000-0000-0000-0000-000000000000';") && upd.includes('blankStagingId(au, userData)'), 'the app does what the page says');
    assert.ok(pages.how.includes('id="changes-to-obs"') && pages.how.includes('id="smartscreen"'), 'how it works: OBS changes and SmartScreen');
    // H-771: the pages say the OBS changes happen only for streamers who use song requests.
    assert.ok(pages.how.includes('only while a song request command is switched on') && pages.how.includes('Streamers who do not use song requests get no change at all'), 'how it works: song requests only');
    assert.ok(pages.faq.includes('Only if you use song requests'), 'faq: song requests only');
    for (const id of ['lights', 'voicemeeter', 'stream-deck']) assert.ok(pages.how.includes(`id="${id}"`), `how it works: #${id}`);
    assert.ok(pages.privacy.includes('Device report') && pages.privacy.includes('multicast-dns') && pages.privacy.includes('node-hid') && pages.privacy.includes('koffi'), 'privacy: Phase 5 report and dependencies');
    assert.ok(pages.privacy.includes('Never a network address, a token'), 'privacy: no addresses or tokens in the report');
    assert.ok(pages.faq.includes('id="kick-vods"') && pages.faq.includes('id="clips"') && pages.faq.includes('id="antivirus"'), 'faq: Kick VODs, clips, antivirus');
    for (const c of CATEGORIES) assert.ok(pages.data.includes(`id="${c.id}"`), `data: section ${c.id}`);
    assert.ok(pages.data.includes('No automatic deletion'), 'data: undefined retention is said honestly');
    for (const d of LEGAL_DOCS) assert.ok(pages.hub.includes(`href="${d.href}"`), `hub: ${d.title}`);
});

test('the legal documents cover the stream bot, Studio and song requests, keep the cap and Disputes, and say AGPL', () => {
    const terms = render('terms-tailwind', { user: null });
    const privacy = render('privacy-tailwind', { user: null });
    const eula = render('eula-tailwind', { user: null });
    for (const [name, html] of [['terms', terms], ['privacy', privacy], ['eula', eula]]) {
        assert.match(html, /Last updated November (19|20), 2026/, `${name}: last updated`);   // privacy and terms: November 20 (YouTube, H-741)
        assert.ok(html.includes('id="changelog"'), `${name}: changelog`);
        assert.ok(!/\bMIT\b/.test(html), `${name}: no MIT wording`);
    }
    for (const id of ['stream-bot-studio-and-song-requests', 'copyright-complaints', 'age-requirements', 'disputes', 'limitation-of-liability']) assert.ok(terms.includes(`id="${id}"`), `terms: #${id}`);
    assert.ok(terms.includes('$100 USD') && eula.includes('$100 USD'), 'the $100 cap stays');
    assert.ok(terms.includes('best effort'), 'terms: VOD protection is best effort');
    for (const id of ['open-source-and-this-agreement', 'certifried-studio', 'streaming-content-and-copyright', 'third-party-services', 'age']) assert.ok(eula.includes(`id="${id}"`), `eula: #${id}`);
    assert.ok(eula.includes('GNU AGPL-3.0-or-later') && eula.includes('/terms#disputes'), 'eula: AGPL and Disputes');
    assert.ok(!/reverse engineer, decompile/.test(eula), 'eula: no restriction the AGPL does not allow');
    for (const id of ['stream-bot-data', 'viewer-data', 'song-requests', 'certifried-studio']) assert.ok(privacy.includes(`id="${id}"`), `privacy: #${id}`);
    assert.ok(privacy.includes('Cloudflare'), 'privacy: Cloudflare named');
});
