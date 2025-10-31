"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStreamerLive = isStreamerLive;
exports.getStreamDetails = getStreamDetails;
exports.validateUser = validateUser;
const logger_1 = require("./logger");
const api_checks_1 = require("./api_checks");
/**
 * Check if a TikTok user is currently live
 * Uses browser automation via api_checks.ts
 */
async function isStreamerLive(username) {
    try {
        logger_1.logger.info(`[TikTok API] Checking if user @${username} is live`);
        const result = await (0, api_checks_1.checkTikTok)(username);
        if (result.isLive === true) {
            logger_1.logger.info(`[TikTok API] User @${username} is LIVE`);
            return true;
        }
        logger_1.logger.info(`[TikTok API] User @${username} is NOT live`);
        return false;
    }
    catch (error) {
        logger_1.logger.error(`[TikTok API] Error checking live status for @${username}:`, { error });
        return false;
    }
}
/**
 * Get stream details for a live TikTok user
 * Uses browser automation via api_checks.ts
 */
async function getStreamDetails(username) {
    try {
        logger_1.logger.info(`[TikTok API] Fetching stream details for user @${username}`);
        const result = await (0, api_checks_1.checkTikTok)(username);
        if (result.isLive !== true) {
            logger_1.logger.info(`[TikTok API] User @${username} is not live, no details available`);
            return null;
        }
        return {
            title: result.title || `${username} is live on TikTok`,
            game_name: result.game || 'N/A',
            viewer_count: result.viewers || 'N/A',
            thumbnail_url: result.thumbnailUrl || null,
            started_at: null, // TikTok doesn't provide exact start time via browser scraping
        };
    }
    catch (error) {
        logger_1.logger.error(`[TikTok API] Failed to get stream details for @${username}:`, { error });
        return null;
    }
}
/**
 * Validate that a TikTok user exists
 * Uses browser automation via api_checks.ts
 */
async function validateUser(username) {
    try {
        logger_1.logger.info(`[TikTok API] Validating user @${username}`);
        const user = await (0, api_checks_1.getTikTokUser)(username);
        if (user) {
            logger_1.logger.info(`[TikTok API] User @${username} validated successfully`);
            return true;
        }
        logger_1.logger.info(`[TikTok API] User @${username} does not exist`);
        return false;
    }
    catch (error) {
        logger_1.logger.error(`[TikTok API] Error validating user @${username}:`, { error });
        return false;
    }
}
