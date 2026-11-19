import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * H-669: YouTube feeds added by link or @handle. Every add path stores the UC… id the checker polls; rows saved
 * as typed are repaired by the checker (core/youtube-feed.js repairFeedChannelIds). No network: the inputs used
 * here are /channel/UC… links, which resolve without a fetch, and the repair test uses a stub resolver and DB.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ytf-'));
process.env.LOG_DIR = tmp;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pool = (await import('../utils/db.js')).default;
const { repairFeedChannelIds } = await import('../core/youtube-feed.js');

const GUILD = '999000000000006691';
const UC = 'UCXZgpoSwyYLsNxisW1tHuSw';
const cleanup = () => pool.execute('DELETE FROM youtube_feeds WHERE guild_id = ?', [GUILD]);
before(cleanup);
after(cleanup);

function interaction(text) {
    const replies = [];
    return {
        replies,
        guild: { id: GUILD, name: 'test' },
        guildId: GUILD,
        options: {
            getString: (n) => (n === 'channel-id' ? text : null),
            getChannel: () => ({ id: '999000000000006699', name: 'videos' }),
        },
        deferReply: async () => {},
        editReply: async (m) => { replies.push(m); },
    };
}

test('/socials feed youtube-add stores the channel id, not the link as typed', async () => {
    const { handleYoutubeAdd } = await import('../commands/community/social-feed-handler.js');
    await handleYoutubeAdd(interaction(`https://www.youtube.com/channel/${UC}`));
    const [rows] = await pool.query('SELECT youtube_channel_id FROM youtube_feeds WHERE guild_id = ?', [GUILD]);
    assert.deepEqual(rows.map(r => r.youtube_channel_id), [UC]);
});

test('/socials feed youtube-add refuses something that is not a YouTube channel', async () => {
    const { handleYoutubeAdd } = await import('../commands/community/social-feed-handler.js');
    const i = interaction('https://example.com/@someone');
    await handleYoutubeAdd(i);
    assert.match(String(i.replies[0]), /youtube/i);
    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM youtube_feeds WHERE guild_id = ?', [GUILD]);
    assert.equal(Number(rows[0].n), 1);
});

test('/socials feed youtube-remove accepts the link too', async () => {
    const { handleYoutubeRemove } = await import('../commands/community/social-feed-handler.js');
    await handleYoutubeRemove(interaction(`https://youtube.com/channel/${UC}`));
    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM youtube_feeds WHERE guild_id = ?', [GUILD]);
    assert.equal(Number(rows[0].n), 0);
});

test('repairFeedChannelIds: fixes a handle row, removes a duplicate, parks one it cannot resolve', async () => {
    const rows = [
        { id: 1, youtube_channel_id: '@good' },
        { id: 2, youtube_channel_id: 'https://youtube.com/@dupe' },
        { id: 3, youtube_channel_id: 'not a channel' },
    ];
    const ran = [];
    const db = {
        execute: async (sql, params = []) => {
            ran.push([sql.replace(/\s+/g, ' ').trim(), params]);
            if (/^SELECT/i.test(sql.trim())) return [rows];
            if (/SET youtube_channel_id = \?/.test(sql) && params[1] === 2) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
            return [{ affectedRows: 1 }];
        },
    };
    const resolve = async (s) => {
        if (s === 'not a channel') throw new Error("Couldn't find that YouTube channel (HTTP 404).");
        return { channelId: s === '@good' ? 'UCaaaaaaaaaaaaaaaaaaaaaa' : 'UCbbbbbbbbbbbbbbbbbbbbbb' };
    };
    const out = await repairFeedChannelIds({ db, resolve });
    assert.deepEqual(out, { fixed: 1, removed: 1, failed: 1 });
    assert.ok(ran.some(([s, p]) => /SET youtube_channel_id = \?/.test(s) && p[0] === 'UCaaaaaaaaaaaaaaaaaaaaaa' && p[1] === 1));
    assert.ok(ran.some(([s, p]) => /^DELETE FROM youtube_feeds WHERE id = \?/.test(s) && p[0] === 2));
    assert.ok(ran.some(([s, p]) => /suspended_until = DATE_ADD/.test(s) && p[1] === 3 && /Could not find/.test(p[0])));
});

test('no live feed is stored as anything but a channel id; the dashboard add route resolves it first', async () => {
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM youtube_feeds WHERE youtube_channel_id NOT REGEXP '^UC[A-Za-z0-9_-]{22}$'");
    assert.equal(Number(rows[0].n), 0);
    const server = read('dashboard/server.js');
    const route = server.slice(server.indexOf("app.post('/manage/:guildId/add-youtube-feed'"), server.indexOf("app.post('/manage/:guildId/remove-youtube-feed'"));
    assert.match(route, /resolveYouTubeChannelId\(youtube_channel_id\)/);
    assert.match(route, /\[guildId, ucId, discordChannelId\]/);
    assert.doesNotMatch(JSON.stringify((await import('../dashboard/content/guides/social-feeds.js')).default), /Use the channel ID, which starts with/);
});
