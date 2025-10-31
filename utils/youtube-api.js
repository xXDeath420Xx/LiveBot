"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStreamerLive = isStreamerLive;
exports.getStreamDetails = getStreamDetails;
exports.getLatestVideo = getLatestVideo;
const logger_1 = require("./logger");
const api_checks_1 = require("./api_checks");
/**
 * Check if a YouTube channel is currently live
 * Uses browser automation via api_checks.ts
 */
async function isStreamerLive(channelId) {
    try {
        logger_1.logger.info(`[YouTube API] Checking if channel ${channelId} is live`);
        const result = await (0, api_checks_1.checkYouTube)(channelId);
        if (result.isLive === true) {
            logger_1.logger.info(`[YouTube API] Channel ${channelId} is LIVE`);
            return true;
        }
        logger_1.logger.info(`[YouTube API] Channel ${channelId} is NOT live`);
        return false;
    }
    catch (error) {
        logger_1.logger.error(`[YouTube API] Error checking live status for ${channelId}:`, { error });
        return false;
    }
}
/**
 * Get stream details for a live YouTube channel
 * Uses browser automation via api_checks.ts
 */
async function getStreamDetails(channelId) {
    try {
        logger_1.logger.info(`[YouTube API] Fetching stream details for channel ${channelId}`);
        const result = await (0, api_checks_1.checkYouTube)(channelId);
        if (result.isLive !== true) {
            logger_1.logger.info(`[YouTube API] Channel ${channelId} is not live, no details available`);
            return null;
        }
        return {
            title: result.title || 'Untitled Stream',
            game_name: result.game || 'N/A',
            viewer_count: result.viewers || 'N/A',
            thumbnail_url: result.thumbnailUrl || null,
            started_at: null, // YouTube doesn't provide exact start time via browser scraping
        };
    }
    catch (error) {
        logger_1.logger.error(`[YouTube API] Failed to get stream details for ${channelId}:`, { error });
        return null;
    }
}
/**
 * Get the latest video from a YouTube channel
 * Uses YouTube Data API v3 via api_checks.ts
 */
async function getLatestVideo(channelId) {
    try {
        logger_1.logger.info(`[YouTube API] Fetching latest video for channel ${channelId}`);
        const video = await (0, api_checks_1.getLatestYouTubeVideo)(channelId);
        if (!video) {
            logger_1.logger.info(`[YouTube API] No videos found for channel ${channelId}`);
            return null;
        }
        logger_1.logger.info(`[YouTube API] Found latest video for channel ${channelId}: ${video.title}`);
        return video;
    }
    catch (error) {
        logger_1.logger.error(`[YouTube API] Error fetching latest video for ${channelId}:`, { error });
        return null;
    }
}
