/*
 * Managing Twitch clip feeds — shared by `/alerts clips` and the dashboard page.
 *
 * jobs/twitch-clip-checker.js does the posting; this is only the write side of
 * `twitch_clip_feeds` (migration 232). The first feed was inserted by hand, which is
 * why this exists.
 *
 * The rule both front ends must keep: `posted_from` is set to NOW() whenever a feed
 * starts (or restarts) posting. Creating a feed, resuming a paused one, or pointing it
 * at a different streamer all move the watermark, so nothing made before that moment
 * is ever announced — not the batch the streamer just uploaded, and not the week of
 * clips that piled up while the feed was paused.
 */
import { PermissionsBitField } from 'discord.js';
import pool from '../utils/db.js';
import { resolveBroadcaster, clipsSince } from '../utils/platforms/twitch-clips.js';

export const CREATOR_FILTERS = ['anyone', 'broadcaster_only'];
const MAX_MIN_VIEWS = 1000000;

export class ClipFeedError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}

function clampViews(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 0), MAX_MIN_VIEWS) : 0;
}

/**
 * Refuse a channel the posting bot cannot use. A feed that silently can't post is what
 * the checker's own header comment warns about — catch it at setup instead.
 *
 * @param {import('discord.js').Client|null} client  The bot that will post in this guild.
 */
export async function checkChannel(client, guildId, channelId) {
    if (!client) return; // dashboard without a live client: the checker logs it instead
    const guild = client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(channelId)
        || await client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.guildId !== guildId) throw new ClipFeedError('That channel is not in this server');
    if (!channel.isTextBased?.()) throw new ClipFeedError('Clips can only post to a text or announcement channel');

    const me = guild?.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (perms) {
        const missing = [];
        if (!perms.has(PermissionsBitField.Flags.ViewChannel)) missing.push('View Channel');
        if (!perms.has(PermissionsBitField.Flags.SendMessages)) missing.push('Send Messages');
        if (!perms.has(PermissionsBitField.Flags.EmbedLinks)) missing.push('Embed Links');
        if (missing.length) {
            throw new ClipFeedError(`The bot is missing ${missing.join(', ')} in #${channel.name}`);
        }
    }
}

export async function listFeeds(guildId) {
    const [rows] = await pool.execute(
        `SELECT f.*,
                (SELECT COUNT(*) FROM twitch_clip_seen s WHERE s.feed_id = f.id) AS posted_count,
                (SELECT MAX(announced_at) FROM twitch_clip_seen s WHERE s.feed_id = f.id) AS last_posted
           FROM twitch_clip_feeds f
          WHERE f.guild_id = ?
          ORDER BY f.username, f.id`,
        [guildId]
    );
    return rows;
}

export async function getFeed(guildId, id) {
    const [[row]] = await pool.execute(
        'SELECT * FROM twitch_clip_feeds WHERE id = ? AND guild_id = ?', [id, guildId]
    );
    return row || null;
}

async function lookup(streamer) {
    const user = await resolveBroadcaster(streamer);
    if (!user) throw new ClipFeedError(`No Twitch channel called "${String(streamer).slice(0, 40)}"`);
    return user;
}

/**
 * @param {object} opts
 * @param {string} opts.guildId
 * @param {string} opts.channelId
 * @param {string} opts.streamer          Twitch login or channel URL.
 * @param {string} [opts.creatorsFilter]  'anyone' | 'broadcaster_only'
 * @param {number} [opts.minViews]
 * @param {import('discord.js').Client|null} [opts.client]
 */
export async function createFeed({ guildId, channelId, streamer, creatorsFilter = 'anyone', minViews = 0, client = null }) {
    if (!channelId) throw new ClipFeedError('A channel is required');
    if (!CREATOR_FILTERS.includes(creatorsFilter)) throw new ClipFeedError('Unknown creator filter');
    await checkChannel(client, guildId, channelId);
    const user = await lookup(streamer);

    try {
        const [r] = await pool.execute(
            `INSERT INTO twitch_clip_feeds
               (guild_id, channel_id, broadcaster_id, username, enabled, posted_from, creators_filter, min_views)
             VALUES (?, ?, ?, ?, 1, NOW(), ?, ?)`,
            [guildId, channelId, user.id, user.login, creatorsFilter, clampViews(minViews)]
        );
        return { ...user, id: r.insertId, broadcaster_id: user.id };
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
            throw new ClipFeedError(`${user.display_name}'s clips already post to that channel`, 409);
        }
        throw e;
    }
}

/**
 * Partial update. Only the keys present in `changes` are touched.
 *
 * @param {object} changes  { enabled?, channelId?, streamer?, creatorsFilter?, minViews? }
 * @returns {Promise<{row: object, watermarkMoved: boolean}>}
 */
export async function updateFeed(guildId, id, changes, { client = null } = {}) {
    const row = await getFeed(guildId, id);
    if (!row) throw new ClipFeedError('Clip feed not found', 404);

    const sets = [];
    const args = [];
    const push = (col, val) => { sets.push(`${col} = ?`); args.push(val); };
    let restart = false;

    if (changes.channelId !== undefined && changes.channelId !== row.channel_id) {
        if (!changes.channelId) throw new ClipFeedError('A channel is required');
        await checkChannel(client, guildId, changes.channelId);
        push('channel_id', changes.channelId);
    }
    if (changes.streamer !== undefined && changes.streamer !== '') {
        const user = await lookup(changes.streamer);
        if (user.id !== String(row.broadcaster_id)) {
            push('broadcaster_id', user.id);
            restart = true; // a new streamer's back catalogue is exactly the batch to avoid
        }
        push('username', user.login);
    }
    if (changes.creatorsFilter !== undefined) {
        if (!CREATOR_FILTERS.includes(changes.creatorsFilter)) throw new ClipFeedError('Unknown creator filter');
        push('creators_filter', changes.creatorsFilter);
    }
    if (changes.minViews !== undefined) push('min_views', clampViews(changes.minViews));
    if (changes.enabled !== undefined) {
        const on = changes.enabled ? 1 : 0;
        if (on && !row.enabled) restart = true; // don't replay what piled up while paused
        push('enabled', on);
    }
    if (restart) sets.push('posted_from = NOW()');

    if (!sets.length) return { row, watermarkMoved: false };

    args.push(id, guildId);
    try {
        await pool.execute(`UPDATE twitch_clip_feeds SET ${sets.join(', ')} WHERE id = ? AND guild_id = ?`, args);
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') throw new ClipFeedError('That streamer already posts to that channel', 409);
        throw e;
    }
    return { row: await getFeed(guildId, id), watermarkMoved: restart };
}

export async function deleteFeed(guildId, id) {
    const [r] = await pool.execute('DELETE FROM twitch_clip_feeds WHERE id = ? AND guild_id = ?', [id, guildId]);
    if (!r.affectedRows) throw new ClipFeedError('Clip feed not found', 404);
    await pool.execute('DELETE FROM twitch_clip_seen WHERE feed_id = ?', [id]);
}

/**
 * What the feed would see right now, without posting anything: clips since the
 * watermark after the feed's filters, split into already-posted and waiting.
 */
export async function previewFeed(guildId, id) {
    const row = await getFeed(guildId, id);
    if (!row) throw new ClipFeedError('Clip feed not found', 404);

    let clips = await clipsSince(row.broadcaster_id, new Date(row.posted_from));
    const total = clips.length;
    if (row.creators_filter === 'broadcaster_only') {
        clips = clips.filter(c => String(c.creator_id) === String(row.broadcaster_id));
    }
    if (row.min_views > 0) clips = clips.filter(c => (c.view_count || 0) >= row.min_views);

    const [seen] = await pool.execute('SELECT clip_id FROM twitch_clip_seen WHERE feed_id = ?', [id]);
    const known = new Set(seen.map(r => r.clip_id));
    const shape = c => ({
        id: c.id, title: c.title, url: c.url, views: c.view_count,
        creator: c.creator_name, created_at: c.created_at,
    });
    return {
        feed: row,
        since: row.posted_from,
        total,
        filtered_out: total - clips.length,
        posted: clips.filter(c => known.has(c.id)).map(shape),
        waiting: clips.filter(c => !known.has(c.id)).map(shape),
    };
}
