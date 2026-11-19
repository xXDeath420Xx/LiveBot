import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * H-650: the Reddit feed subcommands, /community automeme and the six /arcade cfx subcommands are removed from
 * the command definitions and handlers. Typed as text they answer with why (core/retired-commands.js); an old
 * slash command Discord still shows until the next deploy answers the same. /arcade greenhouse stays.
 * H-674: the Greenhouse README no longer says nothing is deployed; the old /game link went with the cfx handler.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ret-'));
process.env.LOG_DIR = tmp;
process.env.GREENHOUSE_LIVE = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const { retiredMessage, replyRetired } = await import('../core/retired-commands.js');
const { oldGameMovedMessage } = await import('../services/cfx/integrations/cutover.js');

const arcade = (await import('../commands/games/arcade.js')).default;
const socials = (await import('../commands/community/social.js')).default;
const community = (await import('../commands/admin/community.js')).default;

function leafPaths(cmd) {
    const j = cmd.data.toJSON();
    const out = [];
    for (const o of j.options || []) {
        if (o.type === 1) out.push(`${j.name} ${o.name}`);
        if (o.type === 2) for (const s of o.options || []) out.push(`${j.name} ${o.name} ${s.name}`);
    }
    return out;
}

test('the retired paths are gone from the definitions; the rest stays', () => {
    const all = [...leafPaths(arcade), ...leafPaths(socials), ...leafPaths(community)];
    for (const p of all) assert.doesNotMatch(p, /^arcade cfx |^socials feed reddit-|^community automeme /, p);
    for (const p of ['arcade greenhouse status', 'arcade greenhouse daily', 'arcade greenhouse link',
        'socials feed youtube-add', 'socials feed youtube-remove', 'socials feed youtube-list',
        'community starboard setup', 'community pokermeme test']) assert.ok(all.includes(p), `${p} stays`);
    assert.equal(fs.existsSync(path.join(root, 'commands/games/arcade-cfx-handler.js')), false);
    const feed = read('commands/community/social-feed-handler.js');
    assert.doesNotMatch(feed, /export async function handleReddit/);
    assert.doesNotMatch(read('commands/admin/community.js'), /handleAutoMeme/);
});

test('typed as text, each retired path says why; real paths are left alone', () => {
    const reddit = /Reddit feeds are not available/;
    assert.match(retiredMessage('/socials feed reddit-add subreddit:gaming'), reddit);
    assert.match(retiredMessage('!feed reddit-list'), reddit);
    assert.match(retiredMessage(['community', 'automeme', 'setup']), /Auto-memes are not available/);
    assert.match(retiredMessage('?automeme'), /Auto-memes are not available/);
    for (const sub of ['stats', 'daily', 'leaderboard', 'market', 'sell', 'play']) {
        assert.equal(retiredMessage(`/arcade cfx ${sub}`), oldGameMovedMessage());
    }
    assert.equal(retiredMessage('/cfx'), oldGameMovedMessage());
    for (const ok of ['/arcade greenhouse status', '/feed youtube-add', '/community starboard stats', '/feed', 'hello there']) {
        assert.equal(retiredMessage(ok), null, ok);
    }
});

function fakeInteraction(group, sub) {
    const calls = [];
    return {
        calls, deferred: false, replied: false,
        options: { getSubcommandGroup: () => group, getSubcommand: () => sub },
        reply: async (m) => { calls.push(m); },
        editReply: async (m) => { calls.push(m); },
    };
}

test('until the next deploy, the old slash subcommands answer with the reason', async () => {
    const r = fakeInteraction('feed', 'reddit-add');
    await socials.execute(r);
    assert.match(r.calls[0].content, /Reddit feeds are not available/);
    const a = fakeInteraction('automeme', 'setup');
    await community.execute(a);
    assert.match(a.calls[0].content, /Auto-memes are not available/);
    const d = fakeInteraction(null, null);
    d.deferred = true;
    await replyRetired(d, 'arcade cfx play');
    assert.equal(d.calls[0].content, oldGameMovedMessage());
});

test('the chat bridge answers a retired path instead of listing other subcommands', async () => {
    const { runUniversalCommand } = await import('../core/universal-commands.js');
    const replies = [];
    const commands = new Map([['arcade', arcade], ['socials', socials], ['community', community]]);
    const message = { client: { managersReady: true, commands }, guild: null, reply: async (m) => { replies.push(m); return m; } };
    assert.equal(await runUniversalCommand(message, ['arcade', 'cfx', 'stats'], '/'), true);
    assert.equal(replies[0].content, oldGameMovedMessage());
    assert.equal(await runUniversalCommand(message, ['community', 'automeme', 'setup'], '!'), true);
    assert.match(replies[1].content, /Auto-memes are not available/);
});

test('the commands catalog has no "not available" entries left; the Greenhouse README is current (H-674)', () => {
    const catalog = read('dashboard/views/commands-catalog.ejs');
    assert.match(catalog, /const RETIRED = \[\];/);
    assert.doesNotMatch(catalog, /\[\/\^(arcade cfx|community automeme|socials feed reddit)/);
    const readme = read('services/cfx/README.md');
    assert.doesNotMatch(readme, /Nothing here is deployed/);
    assert.match(readme, /Live since 2026-11-19/);
    assert.doesNotMatch(readme, /proposed; owner adds them to LiteSpeed/);
});
