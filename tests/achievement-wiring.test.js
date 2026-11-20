import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { default: pool } = await import('../utils/db.js');
const { default: AchievementManager } = await import('../core/achievement-manager.js');
const { awardAchievement, withAchievement, achievementManagerFor } = await import('../core/achievement-hooks.js');
const { default: knowledge } = await import('../commands/info/info.js');

/*
 * Register H-817 (fix wave 6, 2026-11-20): the 13 achievements nothing awarded are wired to their features through
 * core/achievement-hooks.js. Against the real achievements table with an invented server (cleaned up after):
 * counts add, totals raise and never add, a completion happens once even when two events race, bots and DMs never
 * count; every achievement in the table has a call site; a fortune reading counts only after its reply went out.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUILD = '100000000000000817';
const USER = '100000000000000818';
const OTHER = '100000000000000819';

const announced = [];
const client = {
    guilds: { cache: { get: () => undefined } }, // the invented server is not cached: no announcement is posted
    levelingManager: { isEnabledForGuild: async () => false, addXP: async () => {} },
};
const am = new AchievementManager(client);
await am.initialize();
client.achievementManager = am;
const sendNote = am.sendAchievementNotification.bind(am);
am.sendAchievementNotification = async (u, g, a, r) => { announced.push(a.achievement_key); return sendNote(u, g, a, r); };

async function row(key, user = USER) {
    const [[r]] = await pool.execute(
        'SELECT ua.progress, ua.completed, ua.times_completed FROM user_achievements ua JOIN achievements a ON a.id = ua.achievement_id WHERE ua.user_id = ? AND ua.guild_id = ? AND a.achievement_key = ?',
        [user, GUILD, key]);
    return r ? { progress: Number(r.progress), completed: !!r.completed, times: Number(r.times_completed) } : null;
}

test.after(async () => {
    await pool.execute('DELETE FROM user_achievements WHERE guild_id = ?', [GUILD]);
    await pool.execute('DELETE FROM achievement_stats WHERE guild_id = ?', [GUILD]);
    await new Promise((r) => setTimeout(r, 300)); // background awards from the last test
    await pool.end().catch(() => {});
});

const ix = (user = { id: USER }) => ({ user, guildId: GUILD, client });

test('a count adds; first one completes a milestone once, even when two events race', async () => {
    const [a, b] = await Promise.all([awardAchievement(ix(), 'pokemon_trainer'), awardAchievement(ix(), 'pokemon_trainer')]);
    const r = await row('pokemon_trainer');
    assert.equal(r.completed, true);
    assert.equal(r.times, 1, 'completed (and paid) once');
    assert.equal([a, b].filter(Boolean).length <= 1, true);
    assert.equal(await awardAchievement(ix(), 'pokemon_trainer'), null, 'earned once; it does not pay again');
    assert.equal(announced.filter((k) => k === 'pokemon_trainer').length, 1);
    for (let i = 0; i < 3; i++) await awardAchievement(ix(), 'quest_master');
    assert.deepEqual(await row('quest_master'), { progress: 3, completed: false, times: 0 });
});

test('a total raises the count to what the feature already has, never adds to it', async () => {
    await awardAchievement(ix(), 'pokemon_master', { total: 40 });
    await awardAchievement(ix(), 'pokemon_master', { total: () => Promise.resolve(40) });
    await awardAchievement(ix(), 'pokemon_master', { total: 12 });
    assert.deepEqual(await row('pokemon_master'), { progress: 40, completed: false, times: 0 });
    await awardAchievement(ix(), 'pokemon_master', { total: 101 });
    const r = await row('pokemon_master');
    assert.equal(r.completed, true);
    assert.equal(r.progress, 101);
    // An event achievement completes on its value (Birthday Star), with the ids given directly (no interaction)
    await awardAchievement(null, 'birthday_celebration', { userId: OTHER, guildId: GUILD, client, eventData: { value: 1 } });
    assert.equal((await row('birthday_celebration', OTHER)).completed, true);
});

test('bots, DMs and a bot with no manager never count; custom bots fall back to the main bot\'s manager', async () => {
    assert.equal(await awardAchievement({ user: { id: OTHER, bot: true }, guildId: GUILD, client }, 'meme_lord'), null);
    assert.equal(await awardAchievement({ user: { id: OTHER }, guildId: null, client }, 'meme_lord'), null);
    assert.equal(await awardAchievement({ user: { id: OTHER }, guildId: GUILD, client: {} }, 'meme_lord'), null);
    assert.equal(await row('meme_lord', OTHER), null);
    const custom = {};
    global.botManager = { getClientForGuild: () => custom, clients: new Map([['default', client]]) };
    try {
        assert.equal(achievementManagerFor(custom, GUILD), am);
        await awardAchievement({ user: { id: OTHER }, guildId: GUILD, client: custom }, 'meme_lord');
        assert.equal((await row('meme_lord', OTHER)).progress, 1);
    } finally { delete global.botManager; }
    assert.equal(withAchievement(null, 'meme_lord', 'reply'), 'reply', 'hands the reply back');
});

test('a fortune reading counts once its reply went out', async () => {
    const sent = [];
    const fake = {
        ...ix(), guild: { id: GUILD }, options: { getString: () => null },
        deferReply: async () => {}, editReply: async (p) => { sent.push(p); return { id: 'm1' }; },
    };
    const before = (await row('fortune_seeker'))?.progress || 0;
    await knowledge.handleFortune(fake, 'daily');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sent.length, 1);
    assert.equal((await row('fortune_seeker')).progress, before + 1);
});

test('every achievement in the table is awarded somewhere, at the action, through the existing manager', async () => {
    const [rows] = await pool.execute('SELECT achievement_key FROM achievements');
    const files = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (p.endsWith('.js')) files.push(fs.readFileSync(path.join(root, p), 'utf8'));
        }
    };
    for (const d of ['commands', 'core', 'events', 'handlers']) walk(d);
    const code = files.join('\n');
    for (const { achievement_key: key } of rows) {
        const awarded = code.includes(`'${key}'`) && new RegExp(`(trackAchievement|recordTotal|awardAchievement|withAchievement|awardQuests|awardPokemonCatch)\\([^;]*'${key}'`).test(code);
        assert.ok(awarded, `${key} is awarded somewhere`);
    }
    const src = (p) => fs.readFileSync(path.join(root, p), 'utf8');
    // The calls sit after the action has succeeded
    assert.match(src('commands/games/pokemon.js'), /reply\(\{ embeds: \[embed\] \}\);\n\s+awardPokemonCatch\(interaction, userId, guildId\);/);
    assert.match(src('handlers/music/lastfm.js'), /ON DUPLICATE KEY UPDATE lastfm_username[\s\S]{0,120}\);\s+awardAchievement\(interaction, 'music_lover'\)/);
    assert.match(src('core/birthday-manager.js'), /UPDATE user_birthdays SET last_announced[\s\S]{0,800}awardAchievement\(null, 'birthday_celebration'/);
    assert.match(src('core/rpg-pvp-manager.js'), /SET status = 'completed'[\s\S]{0,1000}awardAchievement\(null, 'duel_winner'/);
    assert.match(src('handlers/critters-actions.js'), /claimQuest\(ix\.guildId, ix\.user\.id, slot\);\s+awardQuests\(ix, 1\);/);
    // The guide lists them all and no longer says some are never awarded
    const guide = src('dashboard/content/guides/achievements.js');
    assert.ok(!/nothing awards them/.test(guide));
    for (const name of ['Adventurer', 'Pokemon Master', 'Duel Winner', 'Music Lover', 'Dedicated Scrobbler', 'Meme Lord', 'Fortune Seeker', 'Animal Lover', 'Game Researcher', 'Movie Buff', 'Birthday Star']) {
        assert.ok(guide.includes(`**${name}**`), `guide: ${name}`);
    }
});
