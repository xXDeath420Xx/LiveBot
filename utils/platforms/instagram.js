import * as api from './instagram-api.js';
import logger from '../logger.js';

async function isStreamerLive(username) {
    try {
        return await api.isStreamerLive(username);
    } catch (error) {
        logger.error(`[Instagram] Error checking live status for ${username}:`, { error: error.message });
        return false;
    }
}

async function getStreamDetails(username) {
    try {
        return await api.getStreamDetails(username);
    } catch (error) {
        logger.error(`[Instagram] Failed to get stream details for ${username}:`, { error: error.message });
        return null;
    }
}

export { isStreamerLive, getStreamDetails };
