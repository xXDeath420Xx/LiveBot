import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
    resolveFeedTarget, listFeedTargets, isFeedTarget, pingProblem, threadPingNote, createFeedThread, cleanThreadName,
    FeedTargetError, FEED_THREAD_ARCHIVE_MINUTES,
} from '../core/feed-target.js';

/*
 * Where feeds post (core/feed-target.js): every feed poster (YouTube, X, Bluesky, Reddit, RSS, Twitch clips,
 * Fortnite) resolves its channel here, so a thread works as a target. 2026-11-20, after AceSquall's feeds were
 * consolidated into one channel with a thread per platform.
 */

const G = '100000000000000001';
const OTHER = '100000000000000009';
const TEXT_ID = '100000000000000010';
const THREAD_ID = '100000000000000011';
const FORUM_ID = '100000000000000012';
const POST_ID = '100000000000000013';

const perms = (...flags) => ({ has: (f) => flags.includes(f) });

function fakeThread(over = {}) {
    const t = {
        id: THREAD_ID, name: 'YouTube', type: 11, guildId: G, parentId: TEXT_ID, archived: false, locked: false,
        isTextBased: () => true,
        guild: { members: { me: {} } },
        permissionsFor: () => perms(),
        unarchived: 0,
        async setArchived(v) { if (v === false) { this.archived = false; this.unarchived++; } },
        ...over,
    };
    return t;
}

/** A client whose cache is empty, like a thread the gateway never sent: only fetch finds it. */
function fetchOnlyClient(channels) {
    const map = new Map(channels.map((c) => [c.id, c]));
    return { channels: { cache: new Map(), fetch: async (id) => { if (!map.has(id)) throw new Error('Unknown Channel'); return map.get(id); } } };
}

test('a thread missing from the cache is fetched and used', async () => {
    const thread = fakeThread();
    const { channel, problem } = await resolveFeedTarget(fetchOnlyClient([thread]), THREAD_ID, { guildId: G });
    assert.equal(channel, thread);
    assert.equal(problem, null);
});

test('an archived thread is reopened before posting', async () => {
    const thread = fakeThread({ archived: true });
    const { channel } = await resolveFeedTarget(fetchOnlyClient([thread]), THREAD_ID, { guildId: G });
    assert.equal(channel, thread);
    assert.equal(thread.unarchived, 1);
    assert.equal(thread.archived, false);
});

test('an archived, locked thread needs Manage Threads', async () => {
    const locked = fakeThread({ archived: true, locked: true });
    const r1 = await resolveFeedTarget(fetchOnlyClient([locked]), THREAD_ID, { guildId: G });
    assert.equal(r1.channel, null);
    assert.match(r1.problem, /locked/);
    const manageable = fakeThread({ archived: true, locked: true, permissionsFor: () => perms(PermissionFlagsBits.ManageThreads) });
    const r2 = await resolveFeedTarget(fetchOnlyClient([manageable]), THREAD_ID, { guildId: G });
    assert.equal(r2.channel, manageable);
    assert.equal(manageable.unarchived, 1);
});

test('a thread that cannot be reopened is reported, not posted to', async () => {
    const thread = fakeThread({ archived: true, async setArchived() { throw new Error('Missing Permissions'); } });
    const r = await resolveFeedTarget(fetchOnlyClient([thread]), THREAD_ID, { guildId: G });
    assert.equal(r.channel, null);
    assert.match(r.problem, /could not be reopened/);
});

test('a forum channel itself is refused; one of its posts works', async () => {
    const forum = { id: FORUM_ID, name: 'clips', type: 15, guildId: G, isTextBased: () => false };
    const post = fakeThread({ id: POST_ID, parentId: FORUM_ID, name: 'Clip of the week' });
    const client = fetchOnlyClient([forum, post]);
    const r1 = await resolveFeedTarget(client, FORUM_ID, { guildId: G });
    assert.equal(r1.channel, null);
    assert.match(r1.problem, /forum/);
    assert.equal((await resolveFeedTarget(client, POST_ID, { guildId: G })).channel, post);
});

test('another server, an unknown id or a bad id resolve to nothing', async () => {
    const foreign = fakeThread({ guildId: OTHER });
    const client = fetchOnlyClient([foreign]);
    assert.match((await resolveFeedTarget(client, THREAD_ID, { guildId: G })).problem, /another server/);
    assert.match((await resolveFeedTarget(client, '100000000000000099', { guildId: G })).problem, /cannot be fetched/);
    assert.equal((await resolveFeedTarget(client, 'nope', { guildId: G })).channel, null);
});

test('a plain text channel from the cache is used as is', async () => {
    const text = { id: TEXT_ID, name: 'feeds', type: 0, guildId: G, isTextBased: () => true };
    const client = { channels: { cache: new Map([[TEXT_ID, text]]), fetch: async () => { throw new Error('should not fetch'); } } };
    assert.equal((await resolveFeedTarget(client, TEXT_ID, { guildId: G })).channel, text);
});

test('picker: channels with their threads under them, forum posts, no private threads, no voice', () => {
    const channels = [
        { id: '2', name: 'zeta', type: 0 },
        { id: '1', name: 'alpha', type: 5 },
        { id: '3', name: 'voice', type: 2 },
        { id: '4', name: 'forum', type: 15 },
    ];
    const threads = [
        { id: '11', name: 'YouTube', type: 11, parentId: '1' },
        { id: '12', name: 'Bluesky', type: 11, parentId: '1' },
        { id: '13', name: 'secret', type: 12, parentId: '1' },
        { id: '14', name: 'post', type: 11, parentId: '4' },
        { id: '15', name: 'orphan', type: 11, parentId: '999' },
    ];
    const list = listFeedTargets(channels, threads);
    assert.deepEqual(list.map((t) => t.label), ['#alpha', '#alpha › Bluesky', '#alpha › YouTube', '#zeta', '#forum › post']);
    assert.deepEqual(list.filter((t) => t.thread).map((t) => t.parentId), ['1', '1', '4']);
    assert.equal(list[0].name, '#alpha');
});

test('isFeedTarget: text, announcement and public threads only', () => {
    assert.ok(isFeedTarget({ type: 0 }));
    assert.ok(isFeedTarget({ type: 5 }));
    assert.ok(isFeedTarget({ type: 11, parent: { type: 0 } }));
    assert.ok(isFeedTarget({ type: 11, parent: { type: 15 } }));
    assert.ok(!isFeedTarget({ type: 12, parent: { type: 0 } }));
    assert.ok(!isFeedTarget({ type: 2 }));
    assert.ok(!isFeedTarget({ type: 15 }));
});

test('ping check: mentionable role, Mention Everyone, @everyone', () => {
    const roles = new Map([
        ['200000000000000001', { id: '200000000000000001', name: 'YT Pings', mentionable: true }],
        ['200000000000000002', { id: '200000000000000002', name: 'Quiet', mentionable: false }],
    ]);
    const plain = { roles: { cache: roles }, members: { me: { permissions: perms() } } };
    const admin = { roles: { cache: roles }, members: { me: { permissions: perms(PermissionFlagsBits.MentionEveryone) } } };
    assert.equal(pingProblem(plain, null, null), null);
    assert.equal(pingProblem(plain, null, '200000000000000001'), null);
    assert.match(pingProblem(plain, null, '200000000000000002'), /not mentionable/);
    assert.equal(pingProblem(admin, null, '200000000000000002'), null);
    assert.match(pingProblem(plain, null, 'everyone'), /@everyone/);
    assert.equal(pingProblem(admin, null, 'everyone'), null);
    assert.match(pingProblem(plain, null, '200000000000000003'), /no longer exists/);
    // Channel overwrites win over the server-wide permission.
    const denied = { permissionsFor: () => perms() };
    assert.match(pingProblem(admin, denied, '200000000000000002'), /not mentionable/);
});

test('thread ping note: large roles and @everyone in a thread', () => {
    const big = { id: '200000000000000004', name: 'Everyone-ish', mentionable: true, members: { size: 150 } };
    const small = { id: '200000000000000005', name: 'Few', mentionable: true, members: { size: 12 } };
    const guild = { roles: { cache: new Map([[big.id, big], [small.id, small]]) } };
    const thread = { type: 11 };
    assert.match(threadPingNote(guild, thread, big.id), /150 members/);
    assert.equal(threadPingNote(guild, thread, small.id), null);
    assert.match(threadPingNote(guild, thread, 'everyone'), /follow the thread/);
    assert.equal(threadPingNote(guild, { type: 0 }, big.id), null);
});

function threadGuild({ active = [], archived = [], botPerms = null } = {}) {
    const created = [];
    const parent = {
        id: TEXT_ID, name: 'feeds', type: 0, guildId: G,
        permissionsFor: () => botPerms || perms(PermissionFlagsBits.ViewChannel, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads),
        threads: {
            fetchActive: async () => ({ threads: new Map(active.map((t) => [t.id, t])) }),
            fetchArchived: async () => ({ threads: new Map(archived.map((t) => [t.id, t])) }),
            create: async (opts) => { const t = { id: '100000000000000777', name: opts.name, type: 11, parentId: TEXT_ID, opts }; created.push(t); return t; },
        },
    };
    const guild = { id: G, members: { me: {} }, channels: { cache: new Map([[TEXT_ID, parent]]), fetch: async () => null } };
    return { guild, created };
}

test('thread for a feed: made public with a one-week auto-archive', async () => {
    const { guild, created } = threadGuild();
    const { thread, reused } = await createFeedThread(guild, TEXT_ID, '  YouTube  ');
    assert.equal(reused, false);
    assert.equal(thread.name, 'YouTube');
    assert.equal(created[0].opts.autoArchiveDuration, FEED_THREAD_ARCHIVE_MINUTES);
    assert.equal(FEED_THREAD_ARCHIVE_MINUTES, 10080);
});

test('thread for a feed: an active or archived thread with the same name is reused', async () => {
    const live = { id: '100000000000000020', name: 'youtube', type: 11, parentId: TEXT_ID };
    const a = threadGuild({ active: [live] });
    assert.deepEqual(await createFeedThread(a.guild, TEXT_ID, 'YouTube'), { thread: live, reused: true });
    assert.equal(a.created.length, 0);
    const old = { id: '100000000000000021', name: 'X', type: 11, parentId: TEXT_ID, archived: true, locked: false, n: 0, async setArchived() { this.n++; } };
    const b = threadGuild({ archived: [old] });
    const r = await createFeedThread(b.guild, TEXT_ID, 'x');
    assert.equal(r.thread, old);
    assert.equal(old.n, 1);
});

test('thread for a feed: bad parent, missing permissions and bad names are refused', async () => {
    const { guild } = threadGuild({ botPerms: perms(PermissionFlagsBits.ViewChannel) });
    await assert.rejects(createFeedThread(guild, TEXT_ID, 'X'), /Create Public Threads/);
    await assert.rejects(createFeedThread(threadGuild().guild, '100000000000000555', 'X'), FeedTargetError);
    assert.throws(() => cleanThreadName('   '), /name/);
    assert.throws(() => cleanThreadName('x'.repeat(101)), /100/);
});
