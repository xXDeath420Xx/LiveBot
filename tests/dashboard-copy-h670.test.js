import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * H-670: dashboard copy and options that said something untrue. The invite buttons ask for the minimum
 * permissions first (as /invite does); the streamer command path is the real one; the nav describes what the
 * Twitch and event schedule pages do; /systems live-style offers every style the dashboard offers; the
 * Canva-style poster says it needs a backdrop.
 */
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'h670-'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('the server list invites with the minimum permissions; Administrator is the secondary choice', () => {
    const html = read('dashboard/views/servers-tailwind.ejs');
    const links = [...html.matchAll(/<a href="https:\/\/discord\.com\/api\/oauth2\/authorize\?[^"]*permissions=(\d+)[^"]*"[^>]*>\s*(?:<svg[\s\S]*?<\/svg>\s*)?([^<]+?)\s*<\/a>/g)]
        .map(m => ({ perms: m[1], label: m[2].trim() }));
    const primary = links.filter(l => /^Add to a server$/.test(l.label));
    assert.equal(primary.length, 2, 'both "Add to a server" buttons');
    for (const l of primary) assert.equal(l.perms, '1643797540086');
    for (const l of links.filter(l => l.perms === '8')) assert.match(l.label, /Administrator/);
    const invite = read('dashboard/server.js');
    assert.match(invite, /req\.query\.admin === '1' \? '8' : '1643797540086'/, '/invite uses the same minimum set');
});

test('the streaming page names the real command and the poster layout says it needs a backdrop', () => {
    const s = read('dashboard/views/partials/manage/streaming.ejs');
    assert.doesNotMatch(s, /<code>\/streamer add<\/code>/);
    assert.match(s, /<code>\/socials streamer add<\/code>/);
    assert.doesNotMatch(s, /one of three layouts/);
    assert.match(s, /Canva-style poster needs a backdrop/);
});

test('the nav describes the schedule pages as they are', async () => {
    const { PAGES } = await import('../core/manage-nav.js');
    const list = Array.isArray(PAGES) ? PAGES : Object.values(PAGES || {});
    const byPage = Object.fromEntries(list.map(p => [p.page, p]));
    assert.doesNotMatch(byPage['twitch-schedules'].desc, /Discord events/);
    assert.match(byPage['twitch-schedules'].desc, /image/);
    assert.doesNotMatch(byPage['event-schedule'].desc, /Marathon|Twitch sync/);
    assert.match(byPage['event-schedule'].desc, /timetable/);
    assert.doesNotMatch(byPage.feeds.desc, /Reddit/);
});

test('/systems live-style offers every style the dashboard offers', async () => {
    const { STYLES } = await import('../core/stream-render-style.js');
    const systems = (await import('../commands/admin/systems.js')).default;
    const group = systems.data.toJSON().options.find(o => o.name === 'live-style');
    for (const sub of group.options.filter(o => o.name !== 'status')) {
        const style = sub.options.find(o => o.name === 'style');
        const values = style.choices.map(c => c.value);
        for (const s of STYLES) assert.ok(values.includes(s), `${sub.name}: ${s}`);
        assert.ok(values.includes('inherit'));
        for (const c of style.choices) assert.ok(c.name.length <= 100);
    }
});
