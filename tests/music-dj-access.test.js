import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * H-667: the AI DJ obeys the Music switch, the music channels and the DJ role; there is one AI DJ switch
 * (ai_dj_config.enabled); any listener may start a vote to skip; the playlist limits show what is stored;
 * the DJ voice list offers only real voices. Uses throwaway guild rows (removed in after()).
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdj-'));
process.env.LOG_DIR = tmp;
process.env.MUSIC_HEALTH_DATA_DIR = tmp;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pool = (await import('../utils/db.js')).default;
const helpers = await import('../utils/music_helpers.js');

const OFF = '999000000000006671';   // music off, AI DJ on
const ON = '999000000000006672';    // music on, DJ role set, AI DJ off
const ROLE = '999000000000006679';

async function cleanup() {
    for (const g of [OFF, ON]) {
        await pool.execute('DELETE FROM music_config WHERE guild_id = ?', [g]);
        await pool.execute('DELETE FROM ai_dj_config WHERE guild_id = ?', [g]);
        helpers.invalidateMusicConfigCache?.(g);
    }
}
before(async () => {
    await cleanup();
    await pool.execute("INSERT INTO music_config (guild_id, enabled) VALUES (?, 0)", [OFF]);
    await pool.execute('INSERT INTO ai_dj_config (guild_id, enabled) VALUES (?, 1)', [OFF]);
    await pool.execute("INSERT INTO music_config (guild_id, enabled, dj_role_id, vote_skip_enabled, dj_enabled) VALUES (?, 1, ?, 1, 1)", [ON, ROLE]);
});
after(async () => { await cleanup(); });

/** A member without the DJ role, not alone in voice, no admin. */
function interaction(guildId, opts = {}) {
    const replies = [];
    const others = new Map([['1', { user: { bot: false } }], ['2', { user: { bot: false } }]]);
    others.filter = (fn) => { const m = new Map([...others].filter(([, v]) => fn(v))); return m; };
    const voice = { id: 'vc', members: others, isVoiceBased: () => true, guild: { id: guildId } };
    return {
        replies,
        guild: { id: guildId, channels: { cache: new Map() } },
        guildId,
        channelId: 'c1',
        user: { id: '999000000000006670' },
        member: {
            id: '999000000000006670',
            user: { id: '999000000000006670' },
            roles: { cache: new Map() },
            permissions: { has: () => false },
            voice: { channel: opts.noVoice ? null : voice },
        },
        options: { getString: () => null },
        client: { player: { nodes: { get: () => null } } },
        deferred: false, replied: false,
        reply: async (m) => { replies.push(m); },
        editReply: async (m) => { replies.push(m); },
        deferReply: async () => {},
    };
}

test('/music dj is refused when Music is off, even with the AI DJ switched on', async () => {
    const { handleDJ } = await import('../handlers/music/features.js');
    const i = interaction(OFF);
    await handleDJ(i);
    assert.equal(i.replies.length, 1);
    assert.match(i.replies[0].content, /music system is disabled/i);
});

test('/music dj is refused without the DJ role when one is set', async () => {
    const { handleDJ } = await import('../handlers/music/features.js');
    const i = interaction(ON);
    await handleDJ(i);
    assert.match(i.replies[0].content, new RegExp(`<@&${ROLE}>`));
});

test('the panel AI DJ form uses the same gate, then the AI DJ switch', async () => {
    const denied = await helpers.checkAIDJAccess(interaction(OFF));
    assert.equal(denied.permitted, false);
    assert.match(denied.message, /music system is disabled/i);
    // A DJ (role member) on a server whose AI DJ is off.
    const dj = interaction(ON);
    dj.member.roles.cache.set(ROLE, {});
    const off = await helpers.checkAIDJAccess(dj);
    assert.equal(off.permitted, false);
    assert.match(off.message, /AI DJ is not enabled/);
    assert.equal(await helpers.isAIDJEnabled(OFF), true);
    assert.equal(await helpers.isAIDJEnabled(ON), false, 'music_config.dj_enabled is not the switch');
});

test('any listener may start a vote to skip when a DJ role is set', async () => {
    const { handleVoteSkip } = await import('../handlers/music/controls.js');
    const i = interaction(ON);
    await handleVoteSkip(i);
    // Got past the permission check: the next answer is about the (empty) queue, not the DJ role.
    assert.match(i.replies[0].content, /nothing playing/i);
    // Controlling playback still needs the role.
    assert.equal((await helpers.checkMusicPermissions(interaction(ON))).permitted, false);
});

test('one switch in the data: no server has the Music page DJ switch on and the AI DJ off', async () => {
    const [rows] = await pool.query(
        `SELECT COUNT(*) AS n FROM music_config m LEFT JOIN ai_dj_config a ON a.guild_id = m.guild_id
          WHERE m.dj_enabled = 1 AND COALESCE(a.enabled, 0) = 0 AND m.guild_id NOT IN (?, ?)`, [OFF, ON]);
    assert.equal(Number(rows[0].n), 0);
    const [cols] = await pool.query(`SELECT COLUMN_NAME, COLUMN_DEFAULT FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND ((TABLE_NAME = 'ai_dj_config' AND COLUMN_NAME = 'randomness_level')
           OR (TABLE_NAME = 'music_config' AND COLUMN_NAME = 'dj_voice'))`);
    const def = Object.fromEntries(cols.map(c => [c.COLUMN_NAME, String(c.COLUMN_DEFAULT).replace(/'/g, '')]));
    assert.equal(def.randomness_level, '5');
    assert.equal(def.dj_voice, 'amy');
    const [[bad]] = await pool.query('SELECT COUNT(*) AS n FROM ai_dj_config WHERE randomness_level > 10 OR randomness_level < 0');
    assert.equal(Number(bad.n), 0);
});

test('the Music page reads the one switch, shows unlimited playlists as empty, offers only real voices', () => {
    const ejs = read('dashboard/views/partials/manage/music.ejs');
    assert.match(ejs, /muCfg\.ai_dj_enabled/);
    assert.doesNotMatch(ejs, /musicConfig\.dj_enabled/);
    assert.doesNotMatch(ejs, /value="male"|value="female"/);
    assert.doesNotMatch(ejs, /max_playlists_per_user \|\| 10|max_songs_per_playlist \|\| 100/);
    assert.match(ejs, /placeholder="No limit"/);
    const server = read('dashboard/server.js');
    assert.match(server, /SELECT enabled FROM ai_dj_config WHERE guild_id = \?', \[guildId\]\);\s*musicConfig = \{ \.\.\.musicConfig, ai_dj_enabled/);
    assert.doesNotMatch(server, /INSERT INTO music_config \(guild_id, dj_enabled, dj_voice\)/);
    assert.doesNotMatch(read('events/interactionCreate.js'), /SELECT dj_enabled, dj_voice FROM music_config/);
});
