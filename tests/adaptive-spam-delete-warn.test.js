import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * H-716: six servers have adaptive_spam_config.action = 'delete+warn' (written by the setup scripts). The detector
 * now handles it: the spam message is deleted, the member gets the server's warning DM, and the detection is
 * recorded like every other action (logInfractionForSpam). Every place the action is chosen offers it.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const { default: AdaptiveSpamManager } = await import('../core/adaptive-spam-manager.js');

function setup() {
    const manager = new AdaptiveSpamManager({ user: { id: 'BOT716', tag: 'Bot#0001', username: 'Bot', bot: true } });
    for (const t of manager.intervals) clearInterval(t);
    const calls = { logged: [], alerts: 0, deleted: 0, dms: [] };
    manager.logInfractionForSpam = async (guild, user, action) => { calls.logged.push(action); };
    manager.sendSpamAlert = async () => { calls.alerts++; };
    const guild = { id: 'fa-test-716', name: 'Test server', ownerId: 'OWNER716', members: { me: null }, channels: { cache: new Map() } };
    const author = { id: 'U716', tag: 'spammer#0001', username: 'spammer', bot: false, send: async (p) => { calls.dms.push(p); } };
    const member = {
        id: 'U716', user: author, guild, roles: { cache: new Map() }, permissions: { has: () => false },
        moderatable: true, kickable: true, bannable: true,
        timeout: async () => { calls.timedOut = true; }, kick: async () => { calls.kicked = true; }, ban: async () => { calls.banned = true; },
    };
    const message = { guild, author, member, channelId: 'C716', delete: async () => { calls.deleted++; } };
    return { manager, calls, message };
}

test("'delete+warn' deletes the message, warns the member and records it like the other actions", async () => {
    const { manager, calls, message } = setup();
    await manager.triggerSpamAction(message, { action: 'delete+warn' }, 90);
    assert.equal(calls.deleted, 1, 'the spam message is deleted');
    assert.deepEqual(calls.logged, ['delete+warn'], 'recorded through logInfractionForSpam, as mute/kick/ban are');
    assert.equal(calls.dms.length, 1, 'the member is sent the warning DM');
    assert.equal(calls.alerts, 1, 'the alert still goes out');
    assert.ok(!calls.timedOut && !calls.kicked && !calls.banned, 'no other action');
});

test('a failed delete still warns the member', async () => {
    const { manager, calls, message } = setup();
    message.delete = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); };
    const out = await manager.deleteAndWarn(message);
    assert.equal(out.deleted, false);
    assert.equal(calls.dms.length, 1);
});

test("'alert' and 'mute' do not delete the message", async () => {
    for (const action of ['alert', 'mute']) {
        const { manager, calls, message } = setup();
        await manager.triggerSpamAction(message, { action }, 90);
        assert.equal(calls.deleted, 0, action);
    }
});

test('every place the action is chosen offers delete+warn', async () => {
    assert.ok(/\['mute', 'kick', 'ban', 'delete\+warn', 'alert'\]\.includes\(action\)/.test(read('dashboard/server.js')), 'Raid lockdown page save route');
    assert.ok(/const ACTIONS = \['alert', 'mute', 'kick', 'ban', 'delete\+warn'\];/.test(read('dashboard/routes/audit-bot.js')), 'audit bot save route');
    assert.ok(/\['delete\+warn','Delete and warn'\]/.test(read('dashboard/views/audit-bot.ejs')), 'audit bot page');

    const protection = (await import('../commands/admin/protection.js')).default.data.toJSON();
    const spam = protection.options.find(o => o.name === 'spam');
    const config = spam.options.find(o => o.name === 'config');
    const action = config.options.find(o => o.name === 'action');
    assert.ok(action.choices.some(c => c.value === 'delete+warn'), '/protection spam config action');

    // The Raid lockdown page shows the saved value instead of "Alert only".
    const { createViewEngine } = await import('../dashboard/services/view-engine.js');
    const { stubs } = await import('./fixtures/kit-rollout-a-stubs.js');
    const views = path.join(root, 'dashboard/views');
    const engine = createViewEngine({ viewsDir: views, cache: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fina-ap-'));
    try {
        const file = path.join(dir, 'p.ejs');
        fs.writeFileSync(file, `<%- include(${JSON.stringify(path.join(views, 'partials/manage/advanced-protection'))}) %>`);
        const locals = stubs()['advanced-protection'];
        const html = await engine.renderFile(file, { ...locals, adaptiveSpamConfig: { ...(locals.adaptiveSpamConfig || {}), enabled: 1, action: 'delete+warn' } });
        const select = html.slice(html.indexOf('id="f-advanced-protection-action-3"'));
        assert.ok(/<option value="delete\+warn" selected>/.test(select.slice(0, 2000)), 'delete+warn is shown as the saved action');
        // The raid detector does not take it.
        assert.ok(!/id="f-advanced-protection-action"[^>]*>[\s\S]{0,800}delete\+warn/.test(html), 'raid detection does not offer it');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
