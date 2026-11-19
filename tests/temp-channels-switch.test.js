import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * H-681: temporary voice channels can be turned off from the Utilities page. The page's switch posts to
 * POST /manage/:guildId/update-tempchannels; off removes the server's temp_channel_config rows through
 * core/temp-channel-config.js, the same function /admin temp-channel disable now uses.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const { wantsTempChannelsOff, disableTempChannels } = await import('../core/temp-channel-config.js');

test('the switch: off only when the page says it sent the switch and it is unticked', () => {
    assert.equal(wantsTempChannelsOff({ enabled_sent: '1' }), true);
    assert.equal(wantsTempChannelsOff({ enabled_sent: '1', enabled: 'on' }), false);
    assert.equal(wantsTempChannelsOff({ enabled_sent: '1', enabled: ['0', 'on'] }), false);
    assert.equal(wantsTempChannelsOff({ enabled_sent: '1', enabled: 'off' }), true);
    // An older page (no marker) keeps the old save-only behaviour.
    assert.equal(wantsTempChannelsOff({ creator_channel_id: '1', category_id: '2' }), false);
    assert.equal(wantsTempChannelsOff(null), false);
});

test('off removes every creator channel, or one, like /admin temp-channel disable', async () => {
    const calls = [];
    const db = { execute: async (sql, params) => { calls.push([sql, params]); return [{ affectedRows: 2 }]; } };
    assert.equal(await disableTempChannels('G681', { db }), 2);
    assert.deepEqual(calls[0], ['DELETE FROM temp_channel_config WHERE guild_id = ?', ['G681']]);
    await disableTempChannels('G681', { creatorChannelId: 'V1', db });
    assert.deepEqual(calls[1], ['DELETE FROM temp_channel_config WHERE guild_id = ? AND creator_channel_id = ?', ['G681', 'V1']]);
});

test('the route and the command use the same state', () => {
    const server = read('dashboard/server.js');
    const route = server.slice(server.indexOf("app.post('/manage/:guildId/update-tempchannels'"));
    const body = route.slice(0, route.indexOf('\n    });'));
    assert.ok(/if \(wantsTempChannelsOff\(req\.body\)\) \{\s*await disableTempChannels\(guildId\);/.test(body), 'the switch is handled before the required-fields check');
    assert.ok(body.indexOf('wantsTempChannelsOff') < body.indexOf("error=missing_fields"), 'off needs no channels');
    const admin = read('commands/admin/admin.js');
    assert.ok(/disableTempChannels\(interaction\.guild\.id, \{ creatorChannelId: creatorChannel\.id \}\)/.test(admin));
    assert.ok(/await disableTempChannels\(interaction\.guild\.id\);/.test(admin));
    assert.ok(!/DELETE FROM temp_channel_config/.test(admin), 'the command no longer has its own DELETE');
});

async function renderUtilities(tempChannels) {
    const { createViewEngine } = await import('../dashboard/services/view-engine.js');
    const views = path.join(root, 'dashboard/views');
    const engine = createViewEngine({ viewsDir: views, cache: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fina-ut-'));
    try {
        const file = path.join(dir, 'p.ejs');
        fs.writeFileSync(file, `<%- include(${JSON.stringify(path.join(views, 'partials/manage/utilities'))}) %>`);
        return engine.renderFile(file, {
            guild: { id: '222222222222222222', memberCount: 10 }, roles: [], channels: [],
            voiceChannels: [{ id: 'V1', name: 'Join to create', type: 2 }], categories: [{ id: 'K1', name: 'Voice', type: 4 }],
            autoPublisherConfig: null, autorolesConfig: null, tempChannels,
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('the Utilities page has the switch, ticked when they are on', async () => {
    const on = await renderUtilities({ creator_channel_id: 'V1', category_id: 'K1', naming_template: "{username}'s Channel" });
    assert.ok(/<input type="hidden" name="enabled_sent" value="1">/.test(on));
    assert.ok(/id="tempChannelsEnabled" name="enabled"[^>]*checked/.test(on), 'ticked when a creator channel is set');
    const off = await renderUtilities(null);
    assert.ok(/id="tempChannelsEnabled" name="enabled"/.test(off));
    assert.ok(!/id="tempChannelsEnabled" name="enabled"[^>]*checked/.test(off), 'unticked when there is none');
    assert.ok(!/use <code>\/admin temp-channel disable<\/code> in Discord/.test(off), 'no longer sends people to Discord to turn it off');
});
