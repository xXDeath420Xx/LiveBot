/*
 * AI DJ "Announce each track" (dashboard AI DJ page: announce_songs + announcement_channel_id in
 * ai_dj_config). For a queue in DJ mode, each real track that starts is announced with one short
 * line in the announcement channel — the one set on the page, else the channel the session was
 * started from (queue.metadata.channelId). The DJ's own spoken intro and skip banter are local
 * audio files injected as tracks; those are not announced.
 *
 * The settings are read when each track starts, so switching announcements off on the dashboard
 * takes effect from the next track, and a session restored after a restart behaves the same.
 * Called from the player's playerStart handler (index.js); never throws.
 */
import { escapeMarkdown } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const COMMENTARY_TITLES = new Set(['DJ Playlist Intro', 'DJ Skip Comment']);
const lastAnnounced = new Map(); // guildId -> { key, at }

/** True for the DJ's own intro / banter clips (local files), which are not songs. */
export function isDjCommentary(track) {
    if (!track) return true;
    if (track.metadata?.isDJCommentary) return true;
    if (COMMENTARY_TITLES.has(track.title)) return true;
    if (track.author === 'DJ Bot' || track.author === 'AI DJ') return true;
    const url = String(track.url || track.raw?.url || '');
    return url.includes('temp_audio');
}

/** The line posted for a track (plain text, markdown-escaped, within Discord's limit). */
export function announcementText(track) {
    const title = escapeMarkdown(String(track?.title || 'Unknown track')).slice(0, 200);
    const author = track?.author ? escapeMarkdown(String(track.author)).slice(0, 120) : '';
    return `🎧 | Now playing **${title}**${author ? ` by ${author}` : ''}`;
}

async function loadSettings(guildId) {
    const [rows] = await pool.execute(
        'SELECT announce_songs, announcement_channel_id FROM ai_dj_config WHERE guild_id = ?',
        [guildId]
    );
    return rows[0] || null;
}

/**
 * Announce `track` if the queue is an AI DJ session and the server has announcements on.
 * @returns {Promise<boolean>} whether a message was sent
 */
export async function announceDjTrack(queue, track) {
    try {
        if (!queue?.metadata?.djMode || isDjCommentary(track)) return false;
        const guild = queue.guild;
        if (!guild) return false;

        const settings = await loadSettings(guild.id);
        // No row = the DJ was never set up from the page; the column default is on.
        const announce = settings ? Number(settings.announce_songs) === 1 : true;
        if (!announce) return false;

        // One announcement per track start (playerStart can repeat for a replayed stream).
        const key = `${track.id || track.url || track.title}`;
        const prev = lastAnnounced.get(guild.id);
        if (prev && prev.key === key && Date.now() - prev.at < 15_000) return false;

        const configured = settings?.announcement_channel_id ? guild.channels.cache.get(String(settings.announcement_channel_id)) : null;
        const fallback = queue.metadata.channelId ? guild.channels.cache.get(String(queue.metadata.channelId)) : null;
        const channel = configured?.isTextBased?.() ? configured : (fallback?.isTextBased?.() ? fallback : null);
        if (!channel) return false;

        lastAnnounced.set(guild.id, { key, at: Date.now() });
        await channel.send({ content: announcementText(track), allowedMentions: { parse: [] } });
        return true;
    } catch (err) {
        logger.warn(`[DJ] Track announcement failed in guild ${queue?.guild?.id}: ${err.message}`);
        return false;
    }
}

export default { announceDjTrack, isDjCommentary, announcementText };
