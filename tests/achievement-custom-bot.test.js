import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { default: pool } = await import('../utils/db.js');
const { achievementManagerFor, awardAchievement } = await import('../core/achievement-hooks.js');
const { default: VoiceActivityManager } = await import('../core/voice-activity-manager.js');

/*
 * Fix wave 7, item 3: achievements in servers run by a custom-branded bot. H-817 recorded that custom bots have no
 * achievementManager. They do: index.js attachManagers (BotManager step 8, and the startup loop) builds one on every
 * client, and the live tables show first-message, night-owl and voice achievements in all 45 custom-bot servers
 * (2026-11-20). This locks that wiring in, and the guards that stop the main bot counting the same event in a server
 * a custom bot serves (utils/custom-bot-check.js shouldIgnoreGuild, the pattern every feature manager follows).
 * No database: the source is read and the managers are stubbed.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test.after(async () => { await pool.end().catch(() => {}); });

test('every client, custom bots included, gets its own achievement manager', () => {
    const index = src('index.js');
    const start = index.indexOf('async function attachManagers(client)');
    const end = index.indexOf("logger.info('[Core] All managers initialized')");
    assert.ok(start > 0 && end > start, 'attachManagers found');
    const body = index.slice(start, end);
    const at = body.indexOf('client.achievementManager = new AchievementManager(client);');
    assert.ok(at > 0, 'attachManagers builds the achievement manager');
    assert.match(body, /await client\.achievementManager\.initialize\(\);/);
    assert.equal(/isDefaultBot/.test(body.slice(0, at)), false, 'nothing above it limits it to the main bot');
    assert.match(index, /botManager\.setManagerInitializer\(initializeManagers\);/, 'custom bots run the same initializer');
    assert.match(src('core/bot-manager.js'), /await this\.managerInitializer\(client\);/, 'BotManager step 8 calls it for each custom bot');
});

test('the main bot skips servers a custom bot serves, before any achievement is counted', () => {
    const guard = /client\.isDefaultBot && await shouldIgnoreGuild\(/;
    const msg = src('events/messageCreate.js');
    const g = msg.indexOf('if (message.client.isDefaultBot && await shouldIgnoreGuild(message.guild.id)) return;');
    assert.ok(g > 0 && g < msg.indexOf('achievementManager.trackAchievement'), 'messages: guard before first_message / chatterbox / night_owl');
    assert.match(src('events/voiceStateUpdate.js'), guard, 'voice sessions (voice_novice / voice_expert)');
    const join = src('events/guildMemberAdd.js');
    const jg = join.indexOf('shouldIgnoreGuild(member.guild.id)');
    assert.ok(jg > 0 && jg < join.indexOf("'early_adopter'"), 'joins: guard before early_adopter / trailblazer');
    assert.match(src('events/interactionCreate.js'), /interaction\.client\.isDefaultBot && interaction\.guild && await shouldIgnoreGuild\(/, 'commands (economy, gambling, every hook) are answered by one bot only');
    assert.match(src('events/guildCreate.js'), /INSERT INTO guild_bot_mapping/, 'a custom bot joining a server maps it, so the main bot stands back there');
});

test('a feature award uses the bot that handled it; a client without managers falls back to the server\'s bot', async () => {
    const calls = [];
    const mk = (name) => ({ trackAchievement: async (u, g, k) => { calls.push([name, k]); return null; }, recordTotal: async () => null });
    const main = { achievementManager: mk('main') };
    const custom = { achievementManager: mk('custom') };
    const saved = global.botManager;
    global.botManager = { getClientForGuild: (gid) => (gid === 'g-custom' ? custom : main), clients: new Map([['default', main]]) };
    try {
        assert.equal(achievementManagerFor(custom, 'g-custom'), custom.achievementManager);
        assert.equal(achievementManagerFor({}, 'g-custom'), custom.achievementManager, 'a bare client: the server\'s bot');
        await awardAchievement({ user: { id: 'u1' }, guildId: 'g-custom', client: custom }, 'meme_lord');
        assert.deepEqual(calls, [['custom', 'meme_lord']], 'counted once, by the custom bot');
    } finally {
        global.botManager = saved;
    }
});

test('voice achievements go through the custom bot\'s own manager, recording the voice total (never adding it)', async () => {
    const seen = [];
    const client = { achievementManager: {
        trackAchievement: async () => { throw new Error('adds the total again: use recordTotal'); },
        recordTotal: async (u, g, k, n) => { seen.push([g, u, k, n]); },
    } };
    const vam = new VoiceActivityManager(client);
    vam.getVoiceActivityStats = async () => ({ total_time: 2 * 3600 });
    await vam.trackVoiceAchievements('g-custom', 'u1', 600);
    assert.deepEqual(seen, [['g-custom', 'u1', 'voice_novice', 120], ['g-custom', 'u1', 'voice_expert', 120]]);
});
