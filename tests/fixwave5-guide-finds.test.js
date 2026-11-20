import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _internals } from '../core/universal-commands.js';
import { TEMPLATES } from '../core/custom-command-templates.js';
import AchievementManager from '../core/achievement-manager.js';
import qotd from '../commands/community/qotd.js';
import { PermissionFlagsBits } from 'discord.js';

/*
 * Register H-803 to H-811 (fix wave 5, 2026-11-20): wrong labels and smaller faults the guide writers found.
 * Behaviour where it is cheap to run, the source where the fault was a single line.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('H-809: a typed command\'s last required text option takes the rest of the words', () => {
    const defs = [
        { name: 'time', type: 3, required: true },
        { name: 'message', type: 3, required: true },
        { name: 'dm', type: 5 },
        { name: 'repeat', type: 3, choices: [{ name: 'Daily', value: 'daily' }, { name: 'Weekly', value: 'weekly' }] },
    ];
    assert.deepEqual(_internals.parseOptions(defs, ['2h', 'Stretch', 'your', 'legs']), { time: '2h', message: 'Stretch your legs' });
    // a trailing word that clearly fits a later option still goes there
    assert.deepEqual(_internals.parseOptions(defs, ['2h', 'Stretch', 'your', 'legs', 'yes']), { time: '2h', message: 'Stretch your legs', dm: 'true' });
    assert.deepEqual(_internals.parseOptions(defs, ['1d', 'Water', 'plants', 'weekly']), { time: '1d', message: 'Water plants', repeat: 'weekly' });
    // name:value still wins, and the old greedy-last case is unchanged
    assert.deepEqual(_internals.parseOptions(defs, ['2h', 'Stretch', 'dm:true']), { time: '2h', message: 'Stretch', dm: 'true' });
    const ban = [{ name: 'user', type: 6, required: true }, { name: 'reason', type: 3 }];
    assert.deepEqual(_internals.parseOptions(ban, ['<@123456789012345678>', 'being', 'annoying']), { user: '<@123456789012345678>', reason: 'being annoying' });
});

test('H-805: no custom command template uses a name that a built-in command answers', () => {
    const taken = ['welcome', 'rules', 'socials', 'support', 'shoutout', 'serverinfo'];
    for (const t of TEMPLATES) assert.ok(!taken.includes(t.command_name), `${t.id} uses ${t.command_name}`);
    assert.equal(new Set(TEMPLATES.map(t => t.command_name)).size, TEMPLATES.length);
    const vars = src('core/custom-command-vars.js');
    assert.ok(!/deathdealer|311298654338383873/.test(vars), 'sample values are placeholders');
    assert.match(src('commands/admin/cc.js'), /category: 'tools'/);
    assert.ok(!/\/tools cc/.test(src('commands/admin/cc.js').replace(/^ \*.*$/gm, '')), 'replies name /cc');
    assert.match(src('dashboard/routes/api/features/custom-commands.js'), /resolveChatPath\(\[name\]\)/);
    assert.match(src('core/prefix-command-manager.js'), /handleCustomPrefixCommand\(message, tokens\[0\]\.toLowerCase\(\), tokens\.slice\(1\)\)/);
    assert.match(src('events/messageCreate.js'), /message\.client\.autoResponseManager = autoResponseManager/);
});

test('H-808: Lucky Streak, Night Owl, Millionaire and Daily Dedication can be earned as described', () => {
    const am = new AchievementManager({});
    assert.equal(am.checkAchievementComplete({ requirement_type: 'event', requirement_value: 1000 }, 1, { value: 1500 }), true);
    assert.equal(!!am.checkAchievementComplete({ requirement_type: 'event', requirement_value: 1000 }, 1, { completed: true }), false, 'the old call never completed');
    assert.equal(am.checkAchievementComplete({ requirement_type: 'event', requirement_value: 1 }, 1, { value: 1, completed: true }), true);
    assert.equal(am.checkAchievementComplete({ requirement_type: 'count', requirement_value: 1000000 }, 1250000, {}), true);
    const gamble = src('commands/economy/economy-gamble-handler.js');
    assert.match(gamble, /winAmount >= 1000\)/);
    assert.match(gamble, /\{ value: result\.winAmount \}/);
    assert.match(src('commands/economy/economy-earn-handler.js'), /result\.streak >= 30/);
    assert.match(src('core/achievement-manager.js'), /completionist\?\.requirement_value/);
    assert.match(src('dashboard/routes/features/achievements.js'), /HAVING completed_achievements > 0/);
    assert.ok(!/id="enabled" name="enabled" data-feature-switch/.test(src('dashboard/views/partials/manage/achievements.ejs')));
    assert.match(src('migrations/468_achievement_fixes.js'), /requirement_value = 10/);
});

test('H-807: /qotd suggest is open to members; the rest still needs Manage Server', async () => {
    assert.equal(qotd.data.toJSON().default_member_permissions ?? null, null);
    const replies = [];
    const member = { permissions: { has: (p) => p !== PermissionFlagsBits.ManageGuild } };
    const mk = (group, sub) => ({
        member, guildId: '1', options: { getSubcommandGroup: () => group, getSubcommand: () => sub, getString: () => null },
        reply: async (o) => { replies.push(o); return o; }, deferReply: async () => {}, editReply: async (o) => { replies.push(o); },
    });
    await qotd.execute(mk('setup', 'channel'));
    assert.match(replies[0].content, /Manage Server/);
    assert.match(src('commands/context/reroll-giveaway.js'), /reactions\.cache\.get\('🎉'\)/);
    assert.match(src('commands/community/manage-giveaway-handler.js'), /still running\. End it first/);
    assert.match(src('core/word-game-manager.js'), /getFeatureConfig\('wordgames', session\.guildId\)/);
    for (const f of ['core/counting-manager.js', 'core/trivia-manager.js', 'core/hangman-manager.js']) {
        assert.match(src(f), /INSERT IGNORE INTO user_economy/, f);
    }
    assert.ok(!/arcade tree/.test(src('commands/games/tree.js')));
});

test('H-803, H-806, H-809, H-810, H-811: labels say what the code does', () => {
    const an = src('commands/admin/protection/antinuke.js');
    assert.ok(!/Bans\/Kicks/.test(an));
    assert.match(an, /invalidateConfigCache\?\.\(guildId\)/);
    assert.match(src('commands/admin/admin.js'), /setName\('reason'\)\.setDescription\('Why \(saved with the quarantine/);
    assert.match(src('dashboard/routes/features/content-management.js'), /configCache\.invalidate\('sticky_messages'/);
    assert.ok(!/last_message_id = NULL/.test(src('dashboard/routes/features/content-management.js')));
    assert.match(src('dashboard/server.js'), /saved_but_not_posted/);
    assert.match(src('commands/admin/takeover.js'), /getBoolean\('waive-soak'\) \?\? false/);
    assert.ok(!/channels named `weather`/.test(src('commands/info/weather.js')));
    assert.match(src('events/voiceStateUpdate.js'), /category\.permissionOverwrites/);
    assert.match(src('events/voiceStateUpdate.js'), /\\\{username\\\}\/g/);
    assert.match(src('dashboard/routes/features/auto-track.js'), /min_level = VALUES\(min_level\)/);
    assert.match(src('commands/info/media.js'), /steamReadOnly/);
    assert.ok(!/invite-filter`/.test(src('commands/tools/link-filter.js')));
    assert.match(src('dashboard/routes/api/features/phishing.js'), /scan_images = COALESCE\(\?, scan_images\)/);
    assert.match(src('events/messageCreate.js'), /isLivePromotion && livePromoFilterOn/);
    assert.match(src('migrations/469_live_promo_filter_switch.js'), /ADD COLUMN live_promo_filter/);
    const server = src('dashboard/server.js');
    assert.match(server, /ON DUPLICATE KEY UPDATE category_id = VALUES\(category_id\), naming_template = VALUES\(naming_template\)/);
    assert.ok(!/SET creator_channel_id = \?, category_id = \?, naming_template = \?\s+WHERE guild_id = \?`/.test(server), 'no update of every row');
});
