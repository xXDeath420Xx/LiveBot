import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Stream alerts pages, accuracy pass (2026-11-19):
 *   - an auto-track mapping stored as edit-on-end only (delete_on_end 0, edit_on_end 1; 8 live rows) showed
 *     "Delete the announcement", so pressing Save turned it into delete; it now shows edit, as the bot reads it
 *   - POST /manage/:id/delete-team removed subscriptions by team id alone, so another server's team members
 *     could be removed; it now checks the team belongs to the server and scopes both queries by guild
 *   - copy: Twitch schedules post an image (no Discord events), event schedules are filled by /engage events
 *     add and twitch-sync (no "Connect Twitch"), role sync covers VIPs and moderators only, stream signup has
 *     no panel the dashboard can post, raids are never anomalies, the analytics thresholds keep the page's
 *     minimums
 */
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-acc-'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

async function renderStreaming(autoTrackConfigs) {
    const { createViewEngine } = await import('../dashboard/services/view-engine.js');
    const engine = createViewEngine({ viewsDir: views, cache: false });
    const guild = { id: '222222222222222222', name: 'Acme Gaming', icon: null, memberCount: 10 };
    const roles = ['Admin', 'Live now'].map((name, i) => ({ id: `30000000000000000${i}`, name, color: 0 }));
    const channels = ['general', 'streams'].map((name, i) => ({ id: `40000000000000000${i}`, name, type: 0 }));
    const locals = {
        guild, roles, channels, voiceChannels: [],
        consolidatedStreamers: [], teamSubscriptions: [], twitchScheduleSyncs: [], scheduleTemplates: [],
        autoTrackConfigs, streamEndedSubs: [], settings: { default_edit_on_end: 0, default_delete_on_end: 1 },
        twitchRoleSyncConfig: null, twitchRoleSyncMembers: [], twitchAnalyticsData: null,
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-acc-'));
    try {
        const file = path.join(dir, 'p.ejs');
        fs.writeFileSync(file, `<%- include(${JSON.stringify(path.join(views, 'partials/manage/streaming'))}) %>`);
        return engine.renderFile(file, locals);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function selectedEnd(html, autoId) {
    const m = html.match(new RegExp(`<select id="at-streamend-${autoId}"[^>]*>([\\s\\S]*?)</select>`));
    assert.ok(m, `stream-end select for mapping ${autoId}`);
    const sel = m[1].match(/<option value="(\w+)"\s+selected/);
    return sel ? sel[1] : null;
}

test('auto-track mappings show the stream-end behaviour the bot applies (edit wins over delete)', async () => {
    const base = { role_id: null, announcement_channel_id: '400000000000000001', live_role_id: null, enabled: 1 };
    const html = await renderStreaming([
        { ...base, auto_id: 1, delete_on_end: 0, edit_on_end: 1 },
        { ...base, auto_id: 2, delete_on_end: 1, edit_on_end: 1 },
        { ...base, auto_id: 3, delete_on_end: 1, edit_on_end: 0 },
        { ...base, auto_id: 4, delete_on_end: 0, edit_on_end: 0 },
    ]);
    assert.equal(selectedEnd(html, 1), 'edit', 'edit-only is shown as edit, not delete');
    assert.equal(selectedEnd(html, 2), 'edit');
    assert.equal(selectedEnd(html, 3), 'delete');
    assert.equal(selectedEnd(html, 4), 'keep');
});

test('delete-team only touches this server\'s team and subscriptions', () => {
    const src = read('dashboard/server.js');
    const start = src.indexOf("app.post('/manage/:guildId/delete-team'");
    assert.ok(start > 0);
    const body = src.slice(start, src.indexOf('app.post(', start + 10));
    const guard = body.indexOf('SELECT id FROM twitch_teams WHERE id = ? AND guild_id = ?');
    assert.ok(guard > 0, 'the team is checked against the server first');
    assert.ok(guard < body.indexOf('DELETE FROM subscriptions'), 'before anything is deleted');
    assert.match(body, /SELECT streamer_id FROM subscriptions WHERE team_subscription_id = \? AND guild_id = \?/);
    assert.match(body, /DELETE FROM subscriptions WHERE team_subscription_id = \? AND guild_id = \?/);
});

test('the analytics thresholds keep the page minimums', () => {
    const src = read('dashboard/server.js');
    for (const f of ['viewbot_min_viewers', 'followbot_threshold', 'mod_spike_threshold', 'harassment_threshold']) {
        assert.match(src, new RegExp(`Math\\.max\\(1, parseInt\\(${f}, 10\\)`), f);
    }
    assert.match(src, /Math\.max\(0\.001, Number\(viewbot_threshold\)\)/);
    assert.match(read('dashboard/views/partials/manage/streaming.ejs'), /name="viewbot_threshold" type="number" step="0\.001" min="0\.001"/);
});

test('stream alert pages describe what the bot does', async () => {
    const { PAGE_HELP } = await import('../core/page-help.js');
    assert.doesNotMatch(PAGE_HELP['twitch-schedules'].help, /server events/i);
    assert.match(PAGE_HELP['twitch-schedules'].help, /image/);
    assert.doesNotMatch(PAGE_HELP['event-schedule'].help, /synced to Twitch|marathon/i);
    assert.match(PAGE_HELP['event-schedule'].help, /\/engage events add/);
    assert.doesNotMatch(PAGE_HELP['role-sync'].help, /subscribe to/);
    assert.doesNotMatch(PAGE_HELP['auto-track'].help, /when they get a role/);
    assert.doesNotMatch(PAGE_HELP['stream-signup'].help, /panel/);
    assert.match(PAGE_HELP.streamers.help, /Rumble/);

    const { PAGES } = await import('../core/manage-nav.js');
    const list = Array.isArray(PAGES) ? PAGES : Object.values(PAGES || {});
    const nav = (p) => list.find((x) => x.page === p);
    assert.doesNotMatch(nav('role-sync').desc, /subs/);
    assert.match(nav('auto-track').desc, /Twitch/);

    const { FEATURE_SPECS } = await import('../core/feature-config-spec.js');
    assert.doesNotMatch(FEATURE_SPECS['stream-signup'].blurb, /panel/i);
    assert.doesNotMatch(FEATURE_SPECS['stream-signup'].note, /panel|\.js/);

    const es = read('dashboard/views/partials/manage/event-schedule.ejs');
    assert.doesNotMatch(es, /\/auth\/twitch\/link/, 'linking a Twitch account does not import a schedule');
    assert.match(es, /<code>\/engage events twitch-sync<\/code>/);

    const st = read('dashboard/views/partials/manage/streaming.ejs');
    assert.doesNotMatch(st, /inbound raids, moderation/);
    assert.match(read('dashboard/views/partials/manage/live-style.ejs'), /Components V2/);
    assert.doesNotMatch(read('dashboard/views/partials/manage/schedule-calendar.ejs'), /use the layout chosen on the Twitch Schedules page/);
});
