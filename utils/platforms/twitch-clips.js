/*
 * Reading a broadcaster's clips.
 *
 * Two things about Twitch's clips endpoint that shape everything here:
 *
 *   1. It sorts by VIEW COUNT, not by date. A clip drifts between pages as people
 *      watch it, so "the first page" is not "the newest" and paging until you meet
 *      a clip you have seen before does not terminate correctly. Always filter by
 *      time and always decide what is new from the clip id.
 *
 *   2. `started_at` needs `ended_at` alongside it or Twitch quietly applies a
 *      one-week window from the start date. Send both.
 */
import axios from 'axios';
import logger from '../logger.js';

const HELIX = 'https://api.twitch.tv/helix';
let cachedToken = null;
let tokenExpiry = 0;

async function appToken() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
    const { data } = await axios.post(
        `https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}` +
        `&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
        null, { timeout: 15000 }
    );
    cachedToken = data.access_token;
    // Renew a minute early rather than discovering expiry mid-cycle.
    tokenExpiry = Date.now() + Math.max(0, (data.expires_in || 3600) - 60) * 1000;
    return cachedToken;
}

/**
 * Clips created strictly after `since`.
 *
 * @param {string} broadcasterId  Numeric Twitch user id.
 * @param {Date}   since          Only clips created after this instant.
 * @param {object} [opts]
 * @param {number} [opts.maxPages=5]  Guard against a very busy channel.
 * @returns {Promise<Array>} oldest first, so a batch announces in the order it was made.
 */
export async function clipsSince(broadcasterId, since, { maxPages = 5 } = {}) {
    const token = await appToken();
    const headers = { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: 'Bearer ' + token };

    const out = [];
    let cursor = null;
    for (let page = 0; page < maxPages; page++) {
        const params = {
            broadcaster_id: broadcasterId,
            first: 100,
            started_at: since.toISOString(),
            ended_at: new Date().toISOString(),
        };
        if (cursor) params.after = cursor;

        const { data } = await axios.get(`${HELIX}/clips`, { headers, params, timeout: 20000 });
        out.push(...(data.data || []));
        cursor = data.pagination?.cursor;
        if (!cursor || !(data.data || []).length) break;
    }

    // Belt and braces: the window is Twitch's, the comparison is ours.
    const cutoff = since.getTime();
    return out
        .filter(c => new Date(c.created_at).getTime() > cutoff)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Resolve game ids to names in one call, so a post can say what she was playing. */
export async function gameNames(ids) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    if (!unique.length) return {};
    const token = await appToken();
    const headers = { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: 'Bearer ' + token };
    const names = {};
    for (let i = 0; i < unique.length; i += 100) {
        try {
            const qs = unique.slice(i, i + 100).map(id => `id=${encodeURIComponent(id)}`).join('&');
            const { data } = await axios.get(`${HELIX}/games?${qs}`, { headers, timeout: 15000 });
            (data.data || []).forEach(g => { names[g.id] = g.name; });
        } catch (e) {
            logger.warn(`[TwitchClips] game lookup failed: ${e.message}`, { category: 'twitch' });
        }
    }
    return names;
}

/** Twitch templates the thumbnail; swap the placeholders for a real size. */
export function thumbnailUrl(clip, width = 480, height = 272) {
    return String(clip.thumbnail_url || '')
        .replace('%{width}', width).replace('%{height}', height)
        .replace('{width}', width).replace('{height}', height);
}

/**
 * Look a channel up by login name. Feeds key on the numeric id (a streamer can rename,
 * the id never changes), but nobody knows their id — they know their name.
 *
 * @returns {Promise<{id: string, login: string, display_name: string}|null>}
 */
export async function resolveBroadcaster(login) {
    const name = String(login || '').trim().replace(/^@/, '')
        .replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').split(/[/?#]/)[0].toLowerCase();
    if (!/^[a-z0-9_]{3,25}$/.test(name)) return null;
    const token = await appToken();
    const headers = { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: 'Bearer ' + token };
    const { data } = await axios.get(`${HELIX}/users`, { headers, params: { login: name }, timeout: 15000 });
    const u = data.data?.[0];
    return u ? { id: u.id, login: u.login, display_name: u.display_name } : null;
}
