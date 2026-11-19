import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * H-706: a replaced bot avatar, welcome banner or schedule image is deleted when the new one is saved
 * (core/server-image-uploads.js discardReplacedUpload), and the nightly retention sweep deletes any such
 * file nothing links to (pruneServerImageFiles, jobs/retention-sweeper.js). A file anything still links to,
 * including a server backup, is kept.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h706-'));
process.env.LOG_DIR = tmp;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pool = (await import('../utils/db.js')).default;
const m = await import('../core/server-image-uploads.js');

test.after(async () => { await pool.end().catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true }); });

test('only the avatar, welcome and schedule file names are managed', () => {
    for (const name of ['avatar_123456789012345678_1774621134316.png', 'avatar_123456789012345678_1774621134316_orig.gif',
        'welcome_123456789012345678_1774274047703.png', 'welcome_123456789012345678_1774274047703.jpg',
        'schedule_123456789012345678_1792813700398_0.png', 'schedule_bg_1789298177337_yhtreu.jpg']) {
        assert.equal(m.serverImageName(`https://example.test/uploads/${name}?v=2`), name, name);
    }
    for (const url of ['https://x.test/uploads/card_5_page_1.png', 'https://x.test/uploads/audio_1_abc.webm',
        'https://x.test/uploads/ai_cover_x_1_abc.png', 'https://cdn.discordapp.com/avatars/1/2.png', null, '']) {
        assert.equal(m.serverImageName(url), null, String(url));
    }
    const json = JSON.stringify({ a: 'https://x.test/uploads/welcome_1_2.png', b: ['/uploads/avatar_3_4.png', '/uploads/card_9_page_1.png'] });
    assert.deepEqual([...m.serverImageNamesIn([json])].sort(), ['avatar_3_4.png', 'welcome_1_2.png']);
});

test('the nightly prune deletes old files nothing links to and keeps the rest', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'up-'));
    const old = Date.now() / 1000 - 3 * 86400;
    const files = {
        'avatar_1_100.png': old,            // replaced, unlinked: deleted
        'avatar_1_200.png': old,            // current: linked, kept
        'welcome_1_300.png': old,           // in a backup: linked, kept
        'schedule_bg_400_abc.jpg': Date.now() / 1000,   // just made: within the grace period, kept
        'card_5_page_1.png': old,           // not ours: kept
    };
    for (const [name, t] of Object.entries(files)) { fs.writeFileSync(path.join(dir, name), 'x'); fs.utimesSync(path.join(dir, name), t, t); }
    const out = await m.pruneServerImageFiles({ dir, refs: new Set(['avatar_1_200.png', 'welcome_1_300.png']) });
    assert.equal(out.deleted, 1);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['avatar_1_200.png', 'card_5_page_1.png', 'schedule_bg_400_abc.jpg', 'welcome_1_300.png']);
});

test('a replaced file is deleted at once unless something still links to it', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'rep-'));
    for (const n of ['avatar_1_100.png', 'avatar_1_200.png', 'welcome_1_300.png']) fs.writeFileSync(path.join(dir, n), 'x');
    const linked = new Set(['welcome_1_300.png']);
    const db = {
        async query(sql, params) {
            if (sql.includes('information_schema')) return [[{ 1: 1 }]];
            const name = String(params[0]).replace(/^%\/uploads\//, '').replace(/%$/, '').replace(/\\(.)/g, '$1');
            return [linked.has(name) ? [{ 1: 1 }] : []];
        },
    };
    assert.equal(await m.discardReplacedUpload('https://x.test/uploads/avatar_1_100.png', 'https://x.test/uploads/avatar_1_200.png', { dir, db }), true);
    assert.equal(await m.discardReplacedUpload('https://x.test/uploads/avatar_1_200.png', 'https://x.test/uploads/avatar_1_200.png', { dir, db }), false, 'same file');
    assert.equal(await m.discardReplacedUpload('https://x.test/uploads/welcome_1_300.png', null, { dir, db }), false, 'still linked');
    assert.equal(await m.discardReplacedUpload('https://cdn.discordapp.com/x.png', null, { dir, db }), false, 'not ours');
    assert.equal(await m.discardReplacedUpload('https://x.test/uploads/avatar_1_999.png', null, { dir, db }), false, 'already gone');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['avatar_1_200.png', 'welcome_1_300.png']);
});

test('on the real database every current avatar and banner counts as linked', async () => {
    const refs = await m.collectServerImageRefs();
    const [rows] = await pool.query(
        "SELECT bot_avatar_url AS u FROM guild_config WHERE bot_avatar_url LIKE '%/uploads/%' UNION ALL SELECT card_background_url FROM welcome_settings WHERE card_background_url LIKE '%/uploads/%'");
    for (const r of rows) {
        const name = m.serverImageName(r.u);
        if (name) assert.ok(refs.has(name), name);
    }
    for (const name of refs) assert.ok(await m.isServerImageReferenced(name), name);
});

test('every save that replaces one of these images discards the old file, and the sweep prunes', () => {
    const server = read('dashboard/server.js');
    const appearance = server.slice(server.indexOf("app.post('/manage/:guildId/update-bot-appearance'"), server.indexOf('// Autopublisher'));
    assert.match(appearance, /discardReplacedUpload\(prevAppearance\.bot_avatar_url/);
    const welcome = server.slice(server.indexOf("app.post('/manage/:guildId/update-welcome'"), server.indexOf('// Create Poll'));
    assert.match(welcome, /discardReplacedUpload\(prevWelcome\.card_background_url, finalBackgroundUrl\)/);
    assert.match(server, /discardReplacedUpload\(existing\.background_url, next\.background_url\)/);
    assert.match(server, /discardReplacedUpload\(sync\.side_art_url, sideArtUrl\)/);
    assert.match(server, /discardReplacedUpload\(tplBefore\.source_url, null\)/);
    assert.match(read('commands/community/manage-welcome-handler.js'), /discardReplacedUpload\(prevWelcome\.card_background_url, backgroundUrl\)/);
    assert.equal((read('core/twitch-schedule-manager.js').match(/discardReplacedUpload\(replacedCache/g) || []).length, 3);
    assert.match(read('jobs/retention-sweeper.js'), /await pruneServerImageFiles\(\)/);
});

test('the privacy policy no longer says replaced images stay', () => {
    const page = read('dashboard/views/privacy-tailwind.ejs');
    assert.doesNotMatch(page, /can stay on our server; we remove it on request/);
    const row = page.split('\n').find((l) => l.includes('<tr><td>Uploaded files (avatars, banners, images)'));
    assert.match(row, /replaced/);
    assert.match(row, /deleted/);
});
