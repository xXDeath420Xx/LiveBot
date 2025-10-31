"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getInstagramUser = getInstagramUser;
exports.isStreamerLive = isStreamerLive;
exports.getStreamDetails = getStreamDetails;
const logger_1 = require("./logger");
const api_checks_1 = require("./api_checks");
async function getInstagramUser(username) {
    if (typeof username !== 'string' || !username)
        return null;
    logger_1.logger.info(`[Instagram API] getInstagramUser started for: ${username}`);
    try {
        const instagramData = await (0, api_checks_1.checkInstagram)(username);
        if (instagramData && instagramData.profileImageUrl) {
            logger_1.logger.info(`[Instagram API] Successfully retrieved Instagram user ${username}.`);
            return {
                username: username,
                profileImageUrl: instagramData.profileImageUrl,
                isLive: (typeof instagramData.isLive === 'boolean' ? instagramData.isLive : false)
            };
        }
        logger_1.logger.info(`[Instagram API] Could not find Instagram user ${username}.`);
        return null;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger_1.logger.error(`[Instagram API] Error getting user ${username}:`, { message: errorMessage });
        return null;
    }
}
async function isStreamerLive(username) {
    try {
        const data = await (0, api_checks_1.checkInstagram)(username);
        return (typeof data?.isLive === 'boolean' ? data.isLive : false);
    }
    catch (error) {
        logger_1.logger.error(`[Instagram API] Error checking live status for ${username}:`, { error });
        return false;
    }
}
async function getStreamDetails(username) {
    try {
        const data = await (0, api_checks_1.checkInstagram)(username);
        if (!data || !data.isLive) {
            return null;
        }
        return {
            title: data.title || `${username} is live on Instagram`,
            game_name: data.game || 'N/A',
            viewer_count: data.viewers || 'N/A',
            thumbnail_url: data.thumbnailUrl || data.profileImageUrl || null,
        };
    }
    catch (error) {
        logger_1.logger.error(`[Instagram API] Failed to get stream details for ${username}:`, { error });
        return null;
    }
}
