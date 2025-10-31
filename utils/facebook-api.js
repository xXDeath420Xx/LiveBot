"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFacebookUser = getFacebookUser;
exports.isStreamerLive = isStreamerLive;
exports.getStreamDetails = getStreamDetails;
const logger_1 = require("./logger");
const api_checks_1 = require("./api_checks");
async function getFacebookUser(username) {
    if (typeof username !== 'string' || !username)
        return null;
    logger_1.logger.info(`[Facebook API] getFacebookUser started for: ${username}`);
    try {
        const facebookData = await (0, api_checks_1.checkFacebook)(username);
        if (facebookData && facebookData.profileImageUrl) {
            logger_1.logger.info(`[Facebook API] Successfully retrieved Facebook Gaming user ${username}.`);
            return {
                username: username,
                profileImageUrl: facebookData.profileImageUrl,
                isLive: (typeof facebookData.isLive === 'boolean' ? facebookData.isLive : false)
            };
        }
        logger_1.logger.info(`[Facebook API] Could not find Facebook Gaming user ${username}.`);
        return null;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger_1.logger.error(`[Facebook API] Error getting user ${username}:`, { message: errorMessage });
        return null;
    }
}
async function isStreamerLive(username) {
    try {
        const data = await (0, api_checks_1.checkFacebook)(username);
        return (typeof data?.isLive === 'boolean' ? data.isLive : false);
    }
    catch (error) {
        logger_1.logger.error(`[Facebook API] Error checking live status for ${username}:`, { error });
        return false;
    }
}
async function getStreamDetails(username) {
    try {
        const data = await (0, api_checks_1.checkFacebook)(username);
        if (!data || !data.isLive) {
            return null;
        }
        return {
            title: data.title || 'Live on Facebook Gaming',
            game_name: data.game || 'N/A',
            viewer_count: data.viewers || 'N/A',
            thumbnail_url: data.thumbnailUrl || data.profileImageUrl || null,
        };
    }
    catch (error) {
        logger_1.logger.error(`[Facebook API] Failed to get stream details for ${username}:`, { error });
        return null;
    }
}
