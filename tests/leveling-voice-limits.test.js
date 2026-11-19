import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * H-672: one XP cooldown range for /level setup, the dashboard page, the dashboard API and the save;
 * voice-XP sessions kept in level_voice_sessions so a restart does not lose them, and a channel move
 * ends one session and starts another.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const settings = await import('../core/leveling-settings.js');
const sessions = await import('../core/leveling-voice-sessions.js');
const { default: pool } = await import('../utils/db.js');

test('cooldown: the command, the page and the API use the same range', async () => {
    const { XP_COOLDOWN_MIN: min, XP_COOLDOWN_MAX: max } = settings;
    assert.equal(min, 10);
    assert.equal(max, 300);

    const { default: level } = await import('../commands/community/level.js');
    const setup = level.data.toJSON().options.find(o => o.name === 'setup');
    const opt = setup.options.find(o => o.name === 'cooldown');
    assert.equal(opt.min_value, min, '/level setup cooldown min');
    assert.equal(opt.max_value, max, '/level setup cooldown max');

    const view = read('dashboard/views/partials/manage/leveling.ejs');
    const input = view.match(/<input id="f-leveling-leveling_xp_cooldown"[\s\S]*?aria-describedby/)[0];
    assert.match(input, new RegExp(`min="${min}"`));
    assert.match(input, new RegExp(`max="${max}"`));
    assert.match(view, new RegExp(`from ${min} to ${max} seconds`));

    const api = read('dashboard/routes/features/leveling.js');
    assert.doesNotMatch(api, /xp_cooldown_seconds > 600/);
    assert.match(api, /xp_cooldown_seconds < XP_COOLDOWN_MIN \|\| xp_cooldown_seconds > XP_COOLDOWN_MAX/);

    const save = read('core/leveling-settings.js');
    assert.match(save, /clampInt\(body\.leveling_xp_cooldown, XP_COOLDOWN_MIN, XP_COOLDOWN_MAX, XP_COOLDOWN_DEFAULT\)/);
});

test('voice transitions: join, leave, move, and changes that keep the channel', () => {
    const { voiceTransition: t } = sessions;
    assert.deepEqual(t(null, 'A'), { end: false, start: true });
    assert.deepEqual(t('A', null), { end: true, start: false });
    assert.deepEqual(t('A', 'B'), { end: true, start: true });
    assert.deepEqual(t('A', 'A'), { end: false, start: false });
    assert.deepEqual(t(undefined, null), { end: false, start: false });
});

test('a stored session after a restart: carry on, credit to the last beat, or restart elsewhere', () => {
    const now = Date.UTC(2026, 10, 19, 12, 0);
    const row = { channel_id: 'A', started_at: new Date(now - 30 * 60000), last_seen_at: new Date(now - 20 * 60000) };
    assert.deepEqual(sessions.reconcileSession(row, 'A', now), { keep: true, creditUntil: null, restartIn: null });
    const gone = sessions.reconcileSession(row, null, now);
    assert.equal(gone.keep, false);
    assert.equal(sessions.sessionMinutes(row.started_at.getTime(), gone.creditUntil), 10);
    assert.equal(sessions.reconcileSession(row, 'B', now).restartIn, 'B');
    assert.equal(sessions.sessionMinutes(5, 1), 0);
});

// ── Against the database (level_voice_sessions, migration 440) ─────────────────────────────────
const GUILD = '100000000000000672';
const USER = '200000000000000672';
const voiceOn = { enabled: 1, voice_xp_enabled: 1, xp_per_voice_minute: 5, ignored_channels: '[]', ignored_roles: '[]' };

async function managerWith(guilds = new Map()) {
    const { default: LevelingManager } = await import('../core/leveling-manager.js');
    const client = { isReady: () => false, once() {}, isDefaultBot: false, guilds: { cache: guilds } };
    const m = new LevelingManager(client);
    m.getConfig = async () => voiceOn;
    m.credits = [];
    m.addVoiceXP = async (guildId, userId, minutes) => { m.credits.push({ guildId, userId, minutes }); };
    return m;
}

const fakeGuild = (voice = new Map()) => ({
    id: GUILD,
    channels: { cache: new Map() },
    members: { cache: new Map(), fetch: async () => null },
    voiceStates: { cache: voice },
});
const state = (channelId, guild) => ({
    channelId, channel: channelId ? { id: channelId } : null, guild,
    member: { id: USER, user: { bot: false, tag: 'tester' }, roles: { cache: new Map() } },
});

test('moving channels credits the old channel and stores the new session; leaving ends it', async (t) => {
    t.after(() => pool.execute('DELETE FROM level_voice_sessions WHERE guild_id = ?', [GUILD]));
    const guild = fakeGuild();
    const m = await managerWith(new Map([[GUILD, guild]]));
    const key = `${GUILD}_${USER}`;

    await m.handleVoiceStateUpdate(state(null, guild), state('A', guild));
    let [rows] = await pool.execute('SELECT channel_id FROM level_voice_sessions WHERE guild_id = ? AND user_id = ?', [GUILD, USER]);
    assert.equal(rows[0]?.channel_id, 'A', 'join is stored');

    m.voiceSessions.get(key).startedAt -= 12 * 60000; // twelve minutes in A
    await m.handleVoiceStateUpdate(state('A', guild), state('B', guild));
    assert.deepEqual(m.credits, [{ guildId: GUILD, userId: USER, minutes: 12 }]);
    [rows] = await pool.execute('SELECT channel_id FROM level_voice_sessions WHERE guild_id = ? AND user_id = ?', [GUILD, USER]);
    assert.equal(rows[0]?.channel_id, 'B', 'the move starts a session in B');

    await m.handleVoiceStateUpdate(state('B', guild), state(null, guild));
    [rows] = await pool.execute('SELECT 1 FROM level_voice_sessions WHERE guild_id = ? AND user_id = ?', [GUILD, USER]);
    assert.equal(rows.length, 0, 'leaving deletes the row');
    assert.equal(m.voiceSessions.has(key), false);
});

test('after a restart, a session whose member left is credited up to the last heartbeat', async (t) => {
    t.after(() => pool.execute('DELETE FROM level_voice_sessions WHERE guild_id = ?', [GUILD]));
    const now = Date.now();
    await pool.execute(
        'INSERT INTO level_voice_sessions (guild_id, user_id, channel_id, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
        [GUILD, USER, 'A', new Date(now - 45 * 60000), new Date(now - 15 * 60000)]);

    const m = await managerWith(new Map([[GUILD, fakeGuild()]]));
    await m.reconcileVoiceSessions();
    assert.deepEqual(m.credits, [{ guildId: GUILD, userId: USER, minutes: 30 }]);
    const [rows] = await pool.execute('SELECT 1 FROM level_voice_sessions WHERE guild_id = ?', [GUILD]);
    assert.equal(rows.length, 0);
});

test('after a restart, a member still in the same channel keeps the session and its start time', async (t) => {
    t.after(() => pool.execute('DELETE FROM level_voice_sessions WHERE guild_id = ?', [GUILD]));
    const started = new Date(Math.floor((Date.now() - 40 * 60000) / 1000) * 1000);
    await pool.execute(
        'INSERT INTO level_voice_sessions (guild_id, user_id, channel_id, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
        [GUILD, USER, 'A', started, new Date()]);

    const voice = new Map([[USER, { id: USER, channelId: 'A', member: { user: { bot: false } } }]]);
    const m = await managerWith(new Map([[GUILD, fakeGuild(voice)]]));
    await m.reconcileVoiceSessions();
    assert.deepEqual(m.credits, []);
    assert.equal(m.voiceSessions.get(`${GUILD}_${USER}`)?.startedAt, started.getTime());
});
