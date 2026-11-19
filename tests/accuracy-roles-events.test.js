import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewEngine } from '../dashboard/services/view-engine.js';

/*
 * Dashboard accuracy pass (2026-11-19), Roles and Events pages:
 *   - Colour roles & AFK: the "Let members pick a name colour" and "Let members set an AFK status"
 *     switches were saved but nothing read them; /tools colorrole set did not record the roles it
 *     made, so "Colour roles created" stayed empty.
 *   - Suggestions: the dashboard's Mark implemented changed only the status (no message update, no
 *     DM), unlike /engage suggest implement.
 *   - Polls: a mistyped duration started a poll with no time limit; an option over 80 characters
 *     failed with a generic error. The list now shows how many members voted.
 *   - Giveaways: "Winners drawn" added up the winners each giveaway asked for, running ones included.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('colour role and AFK switches default on and turn the commands off when saved off', async () => {
    const { colorrolesSwitchOn } = await import('../commands/tools/tools-color-handler.js');
    assert.equal(colorrolesSwitchOn({}, 'colorrole_enabled'), true);
    assert.equal(colorrolesSwitchOn(null, 'afk_enabled'), true);
    assert.equal(colorrolesSwitchOn({ colorrole_enabled: true }, 'colorrole_enabled'), true);
    assert.equal(colorrolesSwitchOn({ colorrole_enabled: 1 }, 'colorrole_enabled'), true);
    for (const off of [false, 0, '0', 'false']) assert.equal(colorrolesSwitchOn({ afk_enabled: off }, 'afk_enabled'), false);

    const handler = read('commands/tools/tools-color-handler.js');
    const set = handler.slice(handler.indexOf('export async function handleColorRoleSet'), handler.indexOf('export async function handleColorRoleRemove'));
    assert.match(set, /colorrolesSwitchOn\(cfg, 'colorrole_enabled'\)/);
    assert.match(set, /INSERT INTO color_roles/);
    const tools = read('commands/tools/tools.js');
    const afk = tools.slice(tools.indexOf("case 'afk': {"), tools.indexOf("case 'afk-list': {"));
    assert.match(afk, /colorrolesSwitchOn\(afkCfg, 'afk_enabled'\)/);
    // Clearing a status is handled before the switch, so it still works while AFK is off.
    assert.ok(afk.indexOf('removeAFK') < afk.indexOf("'afk_enabled'"));
});

test('the poll create route refuses a bad duration and options over 80 characters', () => {
    const server = read('dashboard/server.js');
    const route = server.slice(server.indexOf("app.post('/manage/:guildId/create-poll'"));
    const body = route.slice(0, route.indexOf('pollsManager.createPoll'));
    assert.ok(body.length > 100);
    assert.match(body, /error=duration_must_look_like_30m_2h_or_1d/);
    assert.match(body, /length > 80/);
});

test('the dashboard implement route goes through the bot path', () => {
    const server = read('dashboard/server.js');
    const route = server.slice(server.indexOf("app.post('/manage/:guildId/suggestions/implement'"));
    const body = route.slice(0, route.indexOf('app.post(', 10));
    assert.match(body, /decision: 'implemented'/);
    assert.doesNotMatch(body, /UPDATE suggestions SET status/);
});

test('marking a suggestion implemented from the dashboard updates its message and tells the author', async (t) => {
    const review = await import('../core/suggestion-review.js');
    const { default: pool } = await import('../utils/db.js');
    const GUILD = '100000000000019119';
    const CHANNEL = '300000000000019119';
    const AUTHOR = '200000000000019119';
    const cleanup = async () => {
        await pool.execute('DELETE FROM suggestions WHERE guild_id = ?', [GUILD]);
        await pool.execute('DELETE FROM user_suggestion_stats WHERE guild_id = ?', [GUILD]);
    };
    t.after(async () => { await cleanup(); delete global.botManager; });
    await cleanup();

    const edits = [];
    const dms = [];
    const embed = { title: 'Suggestion', description: 'More game nights', fields: [{ name: 'Status', value: 'Approved' }] };
    const message = { id: '900000000000019119', embeds: [embed], edit: async (p) => { edits.push(p); } };
    const channel = { id: CHANNEL, isThread: () => false, messages: { fetch: async () => message } };
    const guild = { id: GUILD, name: 'Test server', channels: { fetch: async () => channel, cache: new Map([[CHANNEL, channel]]) } };
    const client = { guilds: { cache: new Map([[GUILD, guild]]) }, users: { fetch: async () => ({ send: async (m) => { dms.push(m); } }) } };
    global.botManager = { getClientForGuild: () => client };

    const [ins] = await pool.execute(
        `INSERT INTO suggestions (guild_id, user_id, suggestion_text, status, message_id, channel_id, is_anonymous)
         VALUES (?, ?, 'More game nights', 'approved', ?, ?, 0)`, [GUILD, AUTHOR, message.id, CHANNEL]);
    const result = await review.decideFromDashboard({ guildId: GUILD, suggestionId: ins.insertId, reviewerId: '600000000000019119', decision: 'implemented' });
    assert.equal(result.ok, true);
    const [[row]] = await pool.execute('SELECT status, reviewed_by FROM suggestions WHERE id = ?', [ins.insertId]);
    assert.equal(row.status, 'implemented');
    assert.equal(String(row.reviewed_by), '600000000000019119');
    assert.equal(edits.length, 1, 'the posted suggestion shows the new status');
    assert.equal(dms.length, 1, 'the author is told');
});

function render(page, locals) {
    const views = path.join(root, 'dashboard/views');
    const engine = createViewEngine({ viewsDir: views, cache: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-re-'));
    try {
        const file = path.join(dir, 'p.ejs');
        fs.writeFileSync(file, `<%- include(${JSON.stringify(path.join(views, `partials/manage/${page}`))}) %>`);
        return engine.renderFile(file, locals);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('giveaways count the winners actually drawn; polls show who voted', () => {
    const guild = { id: '100000000000019119' };
    const channels = [{ id: '300000000000019119', name: 'general', type: 0 }];
    const now = Date.now();
    const gw = render('giveaways', { guild, channels, roles: [], giveaways: [
        { id: 1, prize: 'Running', channel_id: channels[0].id, ends_at: new Date(now + 3600e3), winner_count: 5, is_active: 1, winners: null },
        { id: 2, prize: 'Ended', channel_id: channels[0].id, ends_at: new Date(now - 3600e3), winner_count: 3, is_active: 0, winners: '["1","2"]' },
        { id: 3, prize: 'Nobody entered', channel_id: channels[0].id, ends_at: new Date(now - 7200e3), winner_count: 1, is_active: 0, winners: null },
    ] });
    const kpi = gw.match(/Winners drawn[\s\S]{0,300}?>\s*(\d+)\s*</);
    assert.ok(kpi, 'winners KPI rendered');
    assert.equal(kpi[1], '2');

    const pl = render('polls', { guild, channels, polls: [
        { id: 1, question: 'Friday?', channel_id: channels[0].id, ends_at: new Date(now + 3600e3), is_active: 1, options: '["A","B"]', votes: '{"1":[0],"2":[1],"3":[0]}' },
        { id: 2, question: 'Old', channel_id: channels[0].id, ends_at: null, is_active: 0, options: '["A","B"]', votes: '{}' },
    ] });
    assert.match(pl, /data-label="Voted">3 members</);
    assert.match(pl, /data-label="Voted">0 members</);
    assert.match(pl, /<time datetime="[^"]+" data-pl-time>/);
    assert.match(pl, /30m, 2h or 1d/);
});
