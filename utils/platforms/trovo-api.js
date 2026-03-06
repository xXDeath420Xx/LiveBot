import axios from 'axios';
import logger from '../logger.js';
import dotenv from 'dotenv';

dotenv.config();

const TROVO_API_BASE = 'https://open-api.trovo.live/openplatform';
const TROVO_CLIENT_ID = process.env.TROVO_CLIENT_ID;

/**
 * Check if a Trovo user is currently live
 * @param {string} username - Trovo username
 * @returns {Promise<boolean>} Whether the user is currently live
 */
async function isStreamerLive(username) {
    try {
        logger.info(`[Trovo API] Checking if user ${username} is live`);

        // Get user info by username (POST request)
        const response = await axios.post(`${TROVO_API_BASE}/channels/id`, {
            username: username
        }, {
            headers: {
                'Client-ID': TROVO_CLIENT_ID,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        if (response.data && response.data.is_live !== undefined) {
            const isLive = response.data.is_live === true || response.data.is_live === 1 || response.data.is_live === '1';
            logger.info(`[Trovo API] User ${username} live status: ${isLive}`);
            return isLive;
        }

        logger.warn(`[Trovo API] Unexpected response format for ${username}:`, response.data);
        return false;
    } catch (error) {
        if (error.response?.status === 404) {
            logger.warn(`[Trovo API] User ${username} not found`);
            return false;
        }
        logger.error(`[Trovo API] Error checking live status for ${username}:`, {
            error: error.message,
            status: error.response?.status,
            data: error.response?.data
        });
        return false;
    }
}

/**
 * Get stream details for a live Trovo user
 * @param {string} username - Trovo username
 * @returns {Promise<Object|null>} Stream details or null
 */
async function getStreamDetails(username) {
    try {
        logger.info(`[Trovo API] Fetching stream details for user ${username}`);

        // Get channel info (POST request)
        const channelResponse = await axios.post(`${TROVO_API_BASE}/channels/id`, {
            username: username
        }, {
            headers: {
                'Client-ID': TROVO_CLIENT_ID,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        if (!channelResponse.data) {
            logger.warn(`[Trovo API] No channel data for ${username}`);
            return null;
        }

        const channelData = channelResponse.data;
        const isLive = channelData.is_live === true || channelData.is_live === 1 || channelData.is_live === '1';

        if (!isLive) {
            logger.info(`[Trovo API] User ${username} is not live`);
            return null;
        }

        // Return stream details
        const streamDetails = {
            title: channelData.live_title || channelData.title || 'Untitled Stream',
            game_name: channelData.category_name || channelData.category || 'No Category',
            viewer_count: parseInt(channelData.current_viewers || channelData.viewers || 0),
            thumbnail_url: channelData.thumbnail || channelData.thumbnail_url || null,
            started_at: channelData.started_at ? new Date(channelData.started_at) : null,
            url: `https://trovo.live/s/${username}`,
            profile_image_url: channelData.profile_pic || null,
            channel_id: channelData.channel_id || null
        };

        logger.info(`[Trovo API] Successfully fetched stream details for ${username}`);
        return streamDetails;
    } catch (error) {
        if (error.response?.status === 404) {
            logger.warn(`[Trovo API] User ${username} not found`);
            return null;
        }
        logger.error(`[Trovo API] Failed to get stream details for ${username}:`, {
            error: error.message,
            status: error.response?.status,
            data: error.response?.data
        });
        return null;
    }
}

/**
 * Validate that a Trovo user exists
 * @param {string} username - Trovo username
 * @returns {Promise<boolean>} Whether the user exists
 */
async function validateUser(username) {
    try {
        logger.info(`[Trovo API] Validating user ${username}`);

        const response = await axios.post(`${TROVO_API_BASE}/channels/id`, {
            username: username
        }, {
            headers: {
                'Client-ID': TROVO_CLIENT_ID,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        const exists = !!response.data;
        logger.info(`[Trovo API] User ${username} exists: ${exists}`);
        return exists;
    } catch (error) {
        if (error.response?.status === 404) {
            logger.info(`[Trovo API] User ${username} does not exist`);
            return false;
        }
        logger.error(`[Trovo API] Error validating user ${username}:`, {
            error: error.message,
            status: error.response?.status,
            data: error.response?.data
        });
        return false;
    }
}

export { isStreamerLive, getStreamDetails, validateUser };
