/*
 * Where a feed posts (shared by every feed poster: YouTube, Twitter / X, Bluesky, Reddit, RSS, Twitch
 * clips and Fortnite news) and what the dashboard's "Post to" picker offers.
 *
 * A feed's channel id can be a text or announcement channel, or a thread in one of them (also a post in a
 * forum channel, which is a thread too). Threads need three things a plain channel lookup gets wrong:
 *   - they are only in guild.channels.cache while active and seen by the gateway, so the posters resolve
 *     through client.channels.fetch, which asks the API when the cache does not have it;
 *   - a thread archives itself after its auto-archive time with no messages, so an archived thread is
 *     reopened before the post is sent (a locked one only when the bot may manage threads);
 *   - a forum channel cannot take a message itself; the feed has to point at one of its posts.
 *
 * No database import, so the tests can load it.
 */
import { PermissionFlagsBits } from 'discord.js';

/** Discord channel types, by number (discord.js ChannelType). */
const TEXT = 0, ANNOUNCEMENT = 5, ANNOUNCEMENT_THREAD = 10, PUBLIC_THREAD = 11, PRIVATE_THREAD = 12, FORUM = 15, MEDIA = 16;

export const FEED_PARENT_TYPES = Object.freeze([TEXT, ANNOUNCEMENT]);
const THREAD_TYPES = [ANNOUNCEMENT_THREAD, PUBLIC_THREAD, PRIVATE_THREAD];
const FORUM_TYPES = [FORUM, MEDIA];

/** A week, the longest auto-archive Discord offers; threads made for feeds use it. */
export const FEED_THREAD_ARCHIVE_MINUTES = 10080;
export const THREAD_NAME_MAX = 100;

export const isThread = (ch) => !!ch && THREAD_TYPES.includes(ch.type);
const isForum = (ch) => !!ch && FORUM_TYPES.includes(ch.type);

/**
 * True when a feed may post into this channel: a text or announcement channel, or a public / announcement
 * thread whose parent is one of those or a forum. Private threads are left out (the feed would post where
 * most members cannot read it, and the picker would list threads the admin may not be in).
 */
export function isFeedTarget(ch) {
    if (!ch) return false;
    if (FEED_PARENT_TYPES.includes(ch.type)) return true;
    if (ch.type === PUBLIC_THREAD || ch.type === ANNOUNCEMENT_THREAD) {
        const parentType = ch.parent?.type;
        return parentType === undefined || FEED_PARENT_TYPES.includes(parentType) || FORUM_TYPES.includes(parentType);
    }
    return false;
}

/** "#channel" or "#channel › thread". */
export function targetLabel(ch, parent = ch?.parent) {
    if (isThread(ch)) return `#${parent?.name || 'unknown-channel'} › ${ch.name}`;
    return `#${ch?.name || 'unknown-channel'}`;
}

/**
 * The picker list: every text / announcement channel, each followed by its active threads, then the posts
 * of forum channels (a forum itself is not selectable). Sorted by name within each group.
 *
 * @param {Iterable<object>} channels  the guild's channels (discord.js GuildChannel-like: id, name, type, rawPosition)
 * @param {Iterable<object>} threads   active threads (id, name, type, parentId, archived)
 * @returns {{ id: string, name: string, label: string, type: number, parentId: string|null, thread: boolean }[]}
 */
export function listFeedTargets(channels, threads = []) {
    const all = [...(channels || [])];
    const byId = new Map(all.map((c) => [String(c.id), c]));
    const order = (a, b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0) || String(a.name).localeCompare(String(b.name));
    const kids = new Map();
    for (const t of threads || []) {
        if (!(t.type === PUBLIC_THREAD || t.type === ANNOUNCEMENT_THREAD)) continue;
        const pid = String(t.parentId ?? t.parent_id ?? '');
        if (!byId.has(pid)) continue;
        if (!kids.has(pid)) kids.set(pid, []);
        kids.get(pid).push(t);
    }
    const row = (ch, parent = null) => ({
        id: String(ch.id),
        name: parent ? `#${parent.name} › ${ch.name}` : `#${ch.name}`,
        label: parent ? `#${parent.name} › ${ch.name}` : `#${ch.name}`,
        type: ch.type,
        parentId: parent ? String(parent.id) : null,
        thread: !!parent,
    });
    const out = [];
    const byName = (a, b) => String(a.name).localeCompare(String(b.name));
    for (const ch of all.filter((c) => FEED_PARENT_TYPES.includes(c.type)).sort(byName)) {
        out.push(row(ch));
        for (const t of (kids.get(String(ch.id)) || []).sort(byName)) out.push(row(t, ch));
    }
    for (const forum of all.filter(isForum).sort(order)) {
        for (const t of (kids.get(String(forum.id)) || []).sort(byName)) out.push(row(t, forum));
    }
    return out;
}

/**
 * The picker list for a live guild. Active threads come from the API (the gateway cache misses threads
 * created while the bot was offline); if that call fails the cached threads are used.
 */
export async function loadFeedTargets(guild) {
    if (!guild?.channels) return [];
    let threads = null;
    try {
        const fetched = await guild.channels.fetchActiveThreads();
        threads = [...(fetched?.threads?.values?.() || [])];
    } catch {
        threads = null;
    }
    const cached = [...(guild.channels.cache?.values?.() || [])];
    if (!threads) threads = cached.filter(isThread);
    else {
        // Keep a cached, recently archived thread a feed already points at: it is still a valid target.
        const seen = new Set(threads.map((t) => String(t.id)));
        for (const t of cached) if (isThread(t) && !seen.has(String(t.id))) threads.push(t);
    }
    return listFeedTargets(cached.filter((c) => !isThread(c)), threads);
}

/** The permission set of the bot in a channel, or null when it cannot be worked out. */
function botPerms(guild, channel) {
    const me = guild?.members?.me;
    if (!me) return null;
    try {
        return channel?.permissionsFor ? channel.permissionsFor(me) : me.permissions || null;
    } catch {
        return me.permissions || null;
    }
}

/**
 * Resolve a feed's channel id to something the poster can send to.
 *
 * @param {object} client   the bot client that posts for this guild
 * @param {string} channelId
 * @param {object} [opts]
 * @param {string} [opts.guildId]  refuse a channel of another server (the add routes take the id from a form)
 * @returns {Promise<{ channel: object|null, problem: string|null }>}
 */
export async function resolveFeedTarget(client, channelId, { guildId = null } = {}) {
    const id = channelId == null ? '' : String(channelId).trim();
    if (!/^\d{17,20}$/.test(id)) return { channel: null, problem: 'no channel set' };
    let channel = null;
    try {
        channel = client?.channels?.cache?.get?.(id) || await client?.channels?.fetch?.(id);
    } catch (e) {
        return { channel: null, problem: `channel ${id} cannot be fetched (${e?.message || 'unknown error'})` };
    }
    if (!channel) return { channel: null, problem: `channel ${id} not found` };
    if (guildId && String(channel.guildId) !== String(guildId)) {
        return { channel: null, problem: `channel ${id} belongs to another server` };
    }
    if (isForum(channel)) {
        return { channel: null, problem: `channel ${id} is a forum; choose one of its posts to post into` };
    }
    if (!channel.isTextBased?.() && !isThread(channel)) {
        return { channel: null, problem: `channel ${id} is not a text channel` };
    }
    if (isThread(channel) && channel.archived) {
        const perms = botPerms(channel.guild, channel);
        const canManage = !!perms?.has?.(PermissionFlagsBits.ManageThreads);
        if (channel.locked && !canManage) {
            return { channel: null, problem: `thread ${id} is archived and locked, and the bot may not manage threads` };
        }
        try {
            await channel.setArchived(false, 'Reopened for a feed post');
        } catch (e) {
            return { channel: null, problem: `thread ${id} is archived and could not be reopened (${e?.message || 'unknown error'})` };
        }
    }
    return { channel, problem: null };
}

/**
 * Why a feed's ping would not notify anyone, or null when it will. A role ping goes through when the role
 * is mentionable, or the bot has Mention @everyone, @here and All Roles in the channel (Administrator
 * includes it). @everyone always needs that permission.
 *
 * @param {object} guild    discord.js Guild (roles.cache, members.me)
 * @param {object|null} channel  where the feed posts (permission overwrites apply); null = server-wide
 * @param {string|null} pingRoleId  a role id, 'everyone', or empty
 */
export function pingProblem(guild, channel, pingRoleId) {
    const id = pingRoleId ? String(pingRoleId).trim() : '';
    if (!id || !guild) return null;
    const perms = botPerms(guild, channel);
    const canAll = !!perms?.has?.(PermissionFlagsBits.MentionEveryone);
    if (id === 'everyone') {
        if (canAll) return null;
        return 'The bot cannot ping @everyone here: give it Mention @everyone, @here and All Roles.';
    }
    const role = guild.roles?.cache?.get?.(id);
    if (!role) return 'The ping role no longer exists.';
    if (role.mentionable || canAll) return null;
    return `@${role.name} is not mentionable, so the ping will not notify anyone. Turn on "Allow anyone to @mention this role" for it, or give the bot Mention @everyone, @here and All Roles.`;
}

/**
 * Notes about a ping that does go through but behaves differently in a thread: Discord adds a role's
 * members to a thread (and notifies them) only when the role has fewer than 100 members; with more, only
 * members already following the thread are notified. @everyone in a thread notifies only its members.
 */
export function threadPingNote(guild, channel, pingRoleId) {
    if (!isThread(channel)) return null;
    const id = pingRoleId ? String(pingRoleId).trim() : '';
    if (!id) return null;
    if (id === 'everyone') return 'In a thread, @everyone only notifies members who follow the thread.';
    const role = guild?.roles?.cache?.get?.(id);
    const count = role?.members?.size;
    if (typeof count === 'number' && count >= 100) {
        return `@${role.name} has ${count} members; Discord only notifies members of a role this large if they follow the thread.`;
    }
    return null;
}

/**
 * Create (or reuse) a public thread for a feed under a text or announcement channel.
 * An active or archived public thread with the same name (case-insensitive) is reused.
 *
 * @returns {Promise<{ thread: object, reused: boolean }>}
 * @throws {FeedTargetError} with a message fit for the dashboard
 */
export class FeedTargetError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}

export function cleanThreadName(raw) {
    const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!name) throw new FeedTargetError('Give the thread a name.');
    if (name.length > THREAD_NAME_MAX) throw new FeedTargetError(`Thread names can be at most ${THREAD_NAME_MAX} characters.`);
    return name;
}

export async function createFeedThread(guild, parentId, rawName, { reason = 'Thread for a feed (CertiFried dashboard)' } = {}) {
    const name = cleanThreadName(rawName);
    const pid = String(parentId ?? '').trim();
    const parent = /^\d{17,20}$/.test(pid)
        ? (guild?.channels?.cache?.get(pid) || await guild?.channels?.fetch(pid).catch(() => null))
        : null;
    if (!parent || String(parent.guildId ?? guild?.id) !== String(guild?.id) || !FEED_PARENT_TYPES.includes(parent.type)) {
        throw new FeedTargetError('Choose a text or announcement channel in this server for the thread.');
    }
    const perms = botPerms(guild, parent);
    if (perms) {
        const missing = [];
        if (!perms.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
        if (!perms.has(PermissionFlagsBits.CreatePublicThreads)) missing.push('Create Public Threads');
        if (!perms.has(PermissionFlagsBits.SendMessagesInThreads)) missing.push('Send Messages in Threads');
        if (missing.length) throw new FeedTargetError(`The bot is missing ${missing.join(', ')} in #${parent.name}.`);
    }
    const lower = name.toLowerCase();
    const same = (t) => String(t?.name || '').toLowerCase() === lower && (t.type === PUBLIC_THREAD || t.type === ANNOUNCEMENT_THREAD);
    try {
        const active = await parent.threads.fetchActive();
        const hit = [...active.threads.values()].find((t) => String(t.parentId) === String(parent.id) && same(t));
        if (hit) return { thread: hit, reused: true };
    } catch { /* fall through to the archived list and creating */ }
    try {
        const archived = await parent.threads.fetchArchived({ type: 'public', limit: 100 });
        const hit = [...archived.threads.values()].find(same);
        if (hit) {
            if (hit.archived && !hit.locked) await hit.setArchived(false, reason).catch(() => {});
            return { thread: hit, reused: true };
        }
    } catch { /* no access to the archive: create a new one */ }
    const thread = await parent.threads.create({ name, autoArchiveDuration: FEED_THREAD_ARCHIVE_MINUTES, reason });
    return { thread, reused: false };
}
