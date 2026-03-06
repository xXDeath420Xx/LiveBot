import axios from 'axios';
import logger from '../logger.js';

let accessToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiresAt) {
        return accessToken;
    }

    try {
        const response = await axios.post(
            `https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`
        );
        accessToken = response.data.access_token;
        tokenExpiresAt = Date.now() + (response.data.expires_in * 1000) - (5 * 60 * 1000); // Refresh 5 mins before expiry
        logger.info('Successfully refreshed Twitch API token.', { category: 'twitch' });
        return accessToken;
    } catch (error) {
        const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger.error('Failed to get Twitch API token:', { error: errorData, category: 'twitch' });
        throw new Error('Could not get Twitch API token.');
    }
}

/**
 * Validate Twitch username format
 * @param {string} username - Username to validate
 * @returns {boolean} True if valid
 */
function isValidTwitchUsername(username) {
    if (!username || typeof username !== 'string') return false;
    // Trim and check: Twitch usernames are 4-25 chars, alphanumeric + underscore only
    const trimmed = username.trim();
    if (trimmed.length < 4 || trimmed.length > 25) return false;
    return /^[a-zA-Z0-9_]+$/.test(trimmed);
}

async function isStreamerLive(twitchUsername) {
    // Validate username before making API call
    if (!isValidTwitchUsername(twitchUsername)) {
        logger.warn(`Invalid Twitch username format: "${twitchUsername}" - skipping API call`, { category: 'twitch' });
        return false;
    }

    try {
        const token = await getAccessToken();
        const response = await axios.get(
            `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(twitchUsername.trim().toLowerCase())}`,
            {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        return response.data.data.length > 0;
    } catch (error) {
        const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger.error(`Error checking if streamer ${twitchUsername} is live:`, { error: errorData, category: 'twitch' });
        return false;
    }
}

async function getStreamDetails(twitchUsername) {
    // Validate username before making API call
    if (!isValidTwitchUsername(twitchUsername)) {
        logger.warn(`Invalid Twitch username format for stream details: "${twitchUsername}" - skipping API call`, { category: 'twitch' });
        return null;
    }

    try {
        const token = await getAccessToken();
        const response = await axios.get(
            `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(twitchUsername.trim().toLowerCase())}`,
            {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        const stream = response.data.data[0];
        if (!stream) return null;

        // Format thumbnail URL by replacing template variables
        let thumbnailUrl = stream.thumbnail_url;
        if (thumbnailUrl) {
            thumbnailUrl = thumbnailUrl.replace('{width}', '1920').replace('{height}', '1080');
        }

        return {
            title: stream.title,
            game_name: stream.game_name,
            viewer_count: stream.viewer_count,
            thumbnail_url: thumbnailUrl,
            started_at: stream.started_at
        };
    } catch (error) {
        const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger.error(`Error getting stream details for ${twitchUsername}:`, { error: errorData, category: 'twitch' });
        return null;
    }
}

async function getTwitchUser(identifier) {
    if (!identifier || typeof identifier !== 'string' || identifier.trim().length === 0) {
        logger.warn(`Invalid Twitch identifier: "${identifier}" - skipping API call`, { category: 'twitch' });
        return null;
    }

    const token = await getAccessToken();
    if (!token) return null;

    const trimmed = identifier.trim();
    const isUserId = /^[0-9]+$/.test(trimmed);
    const param = isUserId ? 'id' : 'login';

    // Validate username format if not a user ID
    if (!isUserId && !isValidTwitchUsername(trimmed)) {
        logger.warn(`Invalid Twitch username format: "${trimmed}" - skipping API call`, { category: 'twitch' });
        return null;
    }

    try {
        const response = await axios.get(
            `https://api.twitch.tv/helix/users?${param}=${encodeURIComponent(trimmed.toLowerCase())}`,
            {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        return response.data.data?.[0] || null;
    } catch (error) {
        const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger.error(`[Twitch User Check Error] for "${identifier}":`, { error: errorData, category: 'twitch' });
        return null;
    }
}

async function getTwitchTeamMembers(teamName) {
    const token = await getAccessToken();
    if (!token) return null;

    try {
        const response = await axios.get(
            `https://api.twitch.tv/helix/teams?name=${teamName.toLowerCase()}`,
            {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        return response.data.data?.[0]?.users || null;
    } catch (error) {
        const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger.error(`[Twitch Team Check Error] for "${teamName}":`, { error: errorData, category: 'twitch' });
        return null;
    }
}

async function getTwitchUsers(usernames) {
    const token = await getAccessToken();
    if (!token || usernames.length === 0) return [];

    // Twitch API allows up to 100 users per request
    const maxPerRequest = 100;
    const chunks = [];
    for (let i = 0; i < usernames.length; i += maxPerRequest) {
        chunks.push(usernames.slice(i, i + maxPerRequest));
    }

    const allUsers = [];
    for (const chunk of chunks) {
        const loginParams = chunk.map(u => `login=${encodeURIComponent(u.toLowerCase())}`).join('&');
        try {
            const response = await axios.get(
                `https://api.twitch.tv/helix/users?${loginParams}`,
                {
                    headers: {
                        'Client-ID': process.env.TWITCH_CLIENT_ID,
                        'Authorization': `Bearer ${token}`
                    }
                }
            );
            if (response.data.data) {
                allUsers.push(...response.data.data);
            }
        } catch (error) {
            const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
            logger.error(`[Twitch Batch User Check Error]:`, { error: errorData, category: 'twitch' });
        }
    }
    return allUsers;
}

/**
 * Get the most recent archive VOD for a Twitch user.
 * @param {string} twitchUsername - Twitch username
 * @returns {Promise<{ url: string, title: string } | null>}
 */
async function getLatestVod(twitchUsername) {
    if (!twitchUsername || typeof twitchUsername !== 'string') return null;

    try {
        const user = await getTwitchUser(twitchUsername);
        if (!user) return null;

        const token = await getAccessToken();
        const response = await axios.get(
            `https://api.twitch.tv/helix/videos?user_id=${user.id}&first=1&type=archive`,
            {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        const vod = response.data.data?.[0];
        if (!vod) return null;

        return { url: vod.url, title: vod.title };
    } catch (error) {
        const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger.error(`[Twitch VOD] Error fetching latest VOD for ${twitchUsername}:`, { error: errorData, category: 'twitch' });
        return null;
    }
}

async function getApiStatus() {
    try {
        await getAccessToken();
        return true;
    } catch (error) {
        return false;
    }
}

export {
    isStreamerLive,
    getStreamDetails,
    getAccessToken,
    getTwitchUser,
    getTwitchUsers,
    getTwitchTeamMembers,
    getLatestVod,
    getApiStatus
};
