import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceCommand, SOURCE_URL } from '../services/certifried-bot/commands/source.js';
import { KICK_EVENT_TYPES } from '../services/certifried-bot/kick-event-subscriptions.js';
import { makeHandleKickEvent } from '../services/certifried-bot/kick-events.js';

/*
 * AGPL-3.0 section 13 source offer: the Discord /help main page has a "Source code" field right after Quick Links,
 * and the Twitch/Kick channel bot has a built-in !source (handler + its tokes_global_command_config row, migration
 * 460). Kick bans (H-773): moderation.banned is one of the webhook events every Kick channel is subscribed to, and a
 * ban event is passed to the stream bot and stored with the banned viewer as its actor.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('/help: a Source code field with the AGPL link, right after Quick Links', () => {
    const src = read('commands/tools/help.js');
    const quick = src.indexOf("name: '🔗 Quick Links'");
    const source = src.indexOf("name: '📜 Source code'");
    assert.ok(quick > 0 && source > quick, 'after Quick Links');
    assert.equal(src.slice(quick, source).match(/embed\.addFields\(/g).length, 1, 'only its own addFields: nothing between them');
    assert.ok(src.includes("value: 'CertiFried is free software (AGPL-3.0-or-later): [github.com/xXDeath420Xx/LiveBot](https://github.com/xXDeath420Xx/LiveBot)', inline: false"));
});

test('!source: replies with the source link, is a registered built-in next to !so, and has its row', async () => {
    const said = [];
    await sourceCommand({ reply: (t) => said.push(t), args: [], platform: 'kick' });
    assert.deepEqual(said, [`CertiFried is free software (AGPL-3.0-or-later). Source code: ${SOURCE_URL}`]);
    assert.equal(SOURCE_URL, 'https://github.com/xXDeath420Xx/LiveBot');
    const reg = read('services/certifried-bot/command-registry.js');
    assert.match(reg, /'so': shoutoutCommand,\n\s+'source': sourceCommand,/);
    const { up } = await import('../migrations/460_channel_bot_source_command.js');
    const sql = [];
    await up({ query: async (s) => { sql.push(s); return [[]]; } });
    assert.equal(sql.length, 1);
    assert.match(sql[0], /INSERT IGNORE INTO tokes_global_command_config/);
    assert.match(sql[0], /'source', 1, '\["sourcecode"\]', NULL, 'utility'/);
    assert.match(sql[0], /, 30, 0, 0\)/, 'everyone may use it, 30 s cooldown');
});

test('Kick: moderation.banned v1 is subscribed with the other events, and the manual script uses the same list', () => {
    assert.ok(KICK_EVENT_TYPES.some((e) => e.name === 'moderation.banned' && e.version === 1));
    assert.equal(new Set(KICK_EVENT_TYPES.map((e) => e.name)).size, KICK_EVENT_TYPES.length);
    assert.match(read('scripts/kick-subscribe-events.mjs'), /import \{ KICK_EVENT_TYPES \} from '\.\.\/services\/certifried-bot\/kick-event-subscriptions\.js'/);
});

test('Kick: a ban event reaches the stream bot and is stored with the banned viewer; no thank-you is sent', async () => {
    const stored = [];
    const seen = [];
    const sent = [];
    const pool = { async execute(sql, params) { if (/INSERT INTO tokes_kick_events/.test(sql)) stored.push(params); return [[{ features_enabled: JSON.stringify({ thank_follow: 'hi {{username}}' }) }]]; } };
    const handle = makeHandleKickEvent({ pool, send: async (...a) => { sent.push(a); return true; }, allow: () => true, onEvent: (t, e) => seen.push(t) });
    const event = {
        broadcaster: { user_id: 800000001, username: 'maplehollow', channel_slug: 'maplehollow' },
        moderator: { user_id: 800000002, username: 'juniper_mod' },
        banned_user: { user_id: 800000003, username: 'spammer_88' },
        metadata: { reason: 'spam', created_at: '2026-11-19T17:00:00Z', expires_at: null },
    };
    assert.equal(await handle('moderation.banned', event), 'stored');
    assert.deepEqual(seen, ['moderation.banned']);
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0].slice(0, 3), ['800000001', 'moderation.banned', 'spammer_88']);
    assert.equal(sent.length, 0);
});
