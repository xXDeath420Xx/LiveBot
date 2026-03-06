import axios from 'axios';
import logger from '../logger.js';
import pool from '../db.js';

// Official Kick API - No more CycleTLS needed!
const KICK_API_BASE = 'https://api.kick.com/public/v1';
const KICK_AUTH_URL = 'https://id.kick.com/oauth/token';

// Token cache
let accessToken = null;
let tokenExpiresAt = null;

/**
 * Get or refresh the Kick API access token using Client Credentials flow
 * @returns {Promise<string|null>} Access token or null on error
 */
async function getAccessToken() {
    // Return cached token if still valid (with 5 minute buffer)
    if (accessToken && tokenExpiresAt && Date.now() < tokenExpiresAt - 300000) {
        return accessToken;
    }

    const clientId = process.env.KICK_CLIENT_ID;
    const clientSecret = process.env.KICK_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        logger.error('[Kick API] Missing KICK_CLIENT_ID or KICK_CLIENT_SECRET in environment');
        return null;
    }

    try {
        logger.info('[Kick API] Requesting new access token via Client Credentials flow');

        const response = await axios.post(KICK_AUTH_URL,
            new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: clientId,
                client_secret: clientSecret
            }).toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 10000
            }
        );

        if (response.data && response.data.access_token) {
            accessToken = response.data.access_token;
            // expires_in is in seconds, convert to milliseconds
            tokenExpiresAt = Date.now() + (response.data.expires_in * 1000);
            logger.info(`[Kick API] Successfully obtained access token, expires in ${response.data.expires_in} seconds`);
            return accessToken;
        }

        logger.error('[Kick API] Token response missing access_token');
        return null;

    } catch (error) {
        logger.error('[Kick API] Failed to get access token:', {
            error: error.response?.data || error.message
        });
        return null;
    }
}

/**
 * Get Kick channel data by username (slug)
 * @param {string} username - Kick username/slug
 * @returns {Promise<Object|null>} Channel data or null if not found/error
 */
async function getKickUser(username) {
    if (typeof username !== 'string' || !username) return null;

    logger.info(`[Kick API] getKickUser started for: ${username}`);

    const token = await getAccessToken();
    if (!token) {
        logger.error('[Kick API] Cannot get channel data - no access token');
        return null;
    }

    try {
        const response = await axios.get(`${KICK_API_BASE}/channels`, {
            params: { slug: username },
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        if (response.data && response.data.data && response.data.data.length > 0) {
            const channelData = response.data.data[0];
            logger.info(`[Kick API] Successfully retrieved channel data for ${username}`, {
                is_live: channelData.stream?.is_live,
                viewer_count: channelData.stream?.viewer_count
            });

            // Transform to match our expected format for compatibility
            return {
                user: {
                    id: channelData.broadcaster_user_id,
                    username: channelData.slug,
                    profile_pic: channelData.banner_picture // Use banner as fallback
                },
                livestream: channelData.stream?.is_live ? {
                    is_live: true,
                    session_title: channelData.stream_title,
                    viewer_count: channelData.stream?.viewer_count || 0,
                    created_at: channelData.stream?.start_time,
                    thumbnail: {
                        url: channelData.stream?.thumbnail
                    },
                    categories: channelData.category ? [{
                        id: channelData.category.id,
                        name: channelData.category.name,
                        thumbnail: channelData.category.thumbnail
                    }] : []
                } : null,
                // Store raw data for any edge cases
                _raw: channelData
            };
        }

        logger.info(`[Kick API] No channel found for ${username}`);
        return null;

    } catch (error) {
        if (error.response?.status === 404) {
            logger.warn(`[Kick API] Channel not found: ${username}`);
            return null;
        }

        logger.error(`[Kick API] Error fetching channel ${username}:`, {
            status: error.response?.status,
            error: error.response?.data || error.message
        });
        return null;
    }
}

/**
 * Check if a Kick streamer is currently live
 * @param {string} username - Kick username
 * @returns {Promise<boolean>} True if live, false otherwise
 */
async function isStreamerLive(username) {
    try {
        const user = await getKickUser(username);
        const isLive = user?.livestream?.is_live || false;
        logger.info(`[Kick API] isStreamerLive for ${username}: ${isLive}`, {
            hasLivestream: !!user?.livestream
        });
        return isLive;
    } catch (error) {
        logger.error(`[Kick API] Error checking live status for ${username}:`, { error: error.message });
        return false;
    }
}

/**
 * Get stream details for a Kick streamer
 * @param {string} username - Kick username
 * @returns {Promise<Object|null>} Stream details or null if offline/error
 */
async function getStreamDetails(username) {
    try {
        const user = await getKickUser(username);
        if (!user || !user.livestream || !user.livestream.is_live) {
            return null;
        }

        // Get thumbnail - official API provides direct URL
        let thumbnailUrl = user.livestream.thumbnail?.url || null;

        // Use profile pic as fallback for Discord embed compatibility
        const userAvatarUrl = user.user?.profile_pic || null;

        return {
            title: user.livestream.session_title,
            game_name: user.livestream.categories?.[0]?.name || 'Not Set',
            viewer_count: user.livestream.viewer_count || 0,
            thumbnail_url: thumbnailUrl || userAvatarUrl,
            started_at: user.livestream.created_at || null,
        };
    } catch (error) {
        logger.error(`[Kick API] Failed to get stream details for ${username}:`, { error: error.message });
        return null;
    }
}

/**
 * Batch check multiple Kick streamers at once (up to 50)
 * Uses the /livestreams endpoint for efficiency
 * @param {Array<{username: string, broadcaster_user_id: number}>} streamers - Array of streamers with their IDs
 * @returns {Promise<Map<number, Object>>} Map of broadcaster_user_id to livestream data
 */
async function batchCheckLiveStreamers(broadcasterIds) {
    if (!Array.isArray(broadcasterIds) || broadcasterIds.length === 0) {
        return new Map();
    }

    // API supports up to 50 at a time
    const ids = broadcasterIds.slice(0, 50);

    const token = await getAccessToken();
    if (!token) {
        logger.error('[Kick API] Cannot batch check - no access token');
        return new Map();
    }

    try {
        // Build query string with multiple broadcaster_user_id params
        const params = new URLSearchParams();
        ids.forEach(id => params.append('broadcaster_user_id', id.toString()));

        const response = await axios.get(`${KICK_API_BASE}/livestreams?${params.toString()}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        const result = new Map();
        if (response.data && response.data.data) {
            for (const stream of response.data.data) {
                result.set(stream.broadcaster_user_id, {
                    is_live: true,
                    title: stream.stream_title,
                    viewer_count: stream.viewer_count || 0,
                    thumbnail_url: stream.thumbnail,
                    started_at: stream.started_at,
                    game_name: stream.category?.name || 'Not Set',
                    slug: stream.slug
                });
            }
            logger.info(`[Kick API] Batch check found ${result.size} live streamers out of ${ids.length} checked`);
        }

        return result;

    } catch (error) {
        logger.error('[Kick API] Batch check failed:', {
            error: error.response?.data || error.message
        });
        return new Map();
    }
}

/**
 * Fetch chatroom_id from Kick's internal API and update database
 * This is needed for Pusher subscriptions in the chat bot
 * @param {string} username - Kick username/slug
 * @returns {Promise<string|null>} Chatroom ID or null if not found
 */
async function fetchAndUpdateChatroomId(username) {
    if (typeof username !== 'string' || !username) return null;

    try {
        // Try internal API - may be blocked but worth trying
        const response = await axios.get(`https://kick.com/api/v1/channels/${username}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://kick.com/'
            },
            timeout: 10000
        });

        if (response.data?.chatroom?.id) {
            const chatroomId = response.data.chatroom.id.toString();

            // Update database
            const [result] = await pool.execute(
                `UPDATE tokes_channels SET chatroom_id = ? WHERE platform = 'kick' AND LOWER(channel_name) = LOWER(?) AND chatroom_id IS NULL`,
                [chatroomId, username]
            );

            if (result.affectedRows > 0) {
                logger.info(`[Kick API] Updated chatroom_id for ${username}: ${chatroomId}`);
            }

            return chatroomId;
        }

        return null;

    } catch (error) {
        // Silently fail - internal API is often blocked
        return null;
    }
}

export { getKickUser, isStreamerLive, getStreamDetails, batchCheckLiveStreamers, getAccessToken, fetchAndUpdateChatroomId };
