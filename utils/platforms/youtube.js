import logger from '../logger.js';
import { getBrowser, closeBrowser } from '../browserManager.js';

/**
 * Check if a YouTube channel is currently live using Playwright browser automation
 * @param {string} channelId - The YouTube channel ID (e.g., "UC1234567890")
 * @returns {Promise<boolean>} - True if the channel is live, false otherwise
 */
async function isStreamerLive(channelId) {
    try {
        logger.info(`[YouTube API] Checking if channel ${channelId} is live`);
        const result = await checkYouTube(channelId);
        return result.isLive === true;
    } catch (error) {
        logger.error(`[YouTube API] Error checking live status for ${channelId}:`, { error });
        return false;
    }
}

/**
 * Get stream details for a live YouTube channel
 * @param {string} channelId - The YouTube channel ID
 * @returns {Promise<object|null>} - Stream details or null if not live
 */
async function getStreamDetails(channelId) {
    try {
        logger.info(`[YouTube API] Getting stream details for channel ${channelId}`);
        const result = await checkYouTube(channelId);

        if (result.isLive !== true) {
            return null;
        }

        return {
            title: result.title || 'Unknown',
            game_name: result.game || result.title || 'No Category',
            viewer_count: result.viewers || 'N/A',
            thumbnail_url: result.thumbnailUrl || null,
            started_at: null, // YouTube doesn't provide start time easily
            url: result.url || null,
        };
    } catch (error) {
        logger.error(`[YouTube API] Failed to get stream details for ${channelId}:`, { error });
        return null;
    }
}

/**
 * Check YouTube channel for live stream using Playwright browser automation
 * @param {string} channelId - The YouTube channel ID
 * @returns {Promise<object>} - Object with isLive status and stream details
 */
async function checkYouTube(channelId) {
    logger.info(`[YouTube Check] Starting for channel ID/username: ${channelId}`);
    const defaultResponse = { isLive: false, profileImageUrl: null };
    let browser = null;

    try {
        browser = await getBrowser();
        if (!browser) {
            logger.error('[YouTube Check] Browser not available.');
            return defaultResponse;
        }

        const page = await browser.newPage();
        page.on('crash', () => logger.error(`[YouTube Check] Page crashed for ${channelId}`));

        // Try @ handle format first (most reliable for modern channels)
        let url = `https://www.youtube.com/@${channelId}/live`;

        logger.info(`[YouTube Check] Trying @ handle format: ${url}`);
        await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});

        // Check if we were redirected away - might need channel ID format instead
        if (!page.url().includes(channelId) && !page.url().includes('/watch')) {
            logger.info(`[YouTube Check] @ format didn't work for ${channelId}, trying channel ID format...`);
            url = `https://www.youtube.com/channel/${channelId}/live`;
            await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
        }

        // If still redirected away after both attempts, channel/user doesn't exist
        if (!page.url().includes(channelId) && !page.url().includes('/watch')) {
            logger.info(`[YouTube Check] Both formats failed for ${channelId}. Final URL: ${page.url()}`);
            return { ...defaultResponse, profileImageUrl: null };
        }

        // Try to get profile image
        const profileImageUrl = await page.locator('#avatar #img').getAttribute('src').catch(() => null);

        // If the page redirected to /watch, the user is live
        const currentUrl = page.url();
        logger.info(`[YouTube Check] Final page URL: ${currentUrl}`);

        if (currentUrl.includes('/watch?v=')) {
            // Extract video ID from URL
            const videoIdMatch = currentUrl.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
            if (videoIdMatch) {
                const handleUrl = `https://www.youtube.com/@${channelId}`;
                const title = await page.title().then(t => t.replace(' - YouTube', '').trim());
                const thumbnailUrl = await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null);

                logger.info(`[YouTube Check] Channel ${channelId} is LIVE (detected via URL redirect): ${title}`);
                logger.info(`[YouTube Check] Returning URL (redirect path): ${handleUrl}`);
                return {
                    isLive: true,
                    platform: 'youtube',
                    username: channelId,
                    url: handleUrl,  // Use @ handle URL for consistency
                    title: title,
                    thumbnailUrl: thumbnailUrl,
                    game: null,
                    viewers: 'N/A',
                    profileImageUrl: profileImageUrl
                };
            }
        }

        // Fallback: Check HTML for live stream data with additional validation
        const html = await page.content();
        const hasIsLive = html.includes('"isLive":true') || html.includes('"isLiveContent":true');
        const watchUrlMatch = html.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);

        logger.info(`[YouTube Check] HTML detection - hasIsLive: ${hasIsLive}, hasWatchUrl: ${!!watchUrlMatch}`);

        // Additional validation: Check for actual active live stream indicators
        if (hasIsLive && watchUrlMatch) {
            // Check for specific indicators that the stream is CURRENTLY live (not just a video of ended stream)
            const hasWatchingNow = html.includes('watching now') || html.includes('viewers watching');
            const hasStartedStreaming = html.includes('Started streaming');
            const hasBadgeLive = html.includes('BADGE_STYLE_TYPE_LIVE_NOW');

            logger.info(`[YouTube Check] Additional validation - hasWatchingNow: ${hasWatchingNow}, hasStartedStreaming: ${hasStartedStreaming}, hasBadgeLive: ${hasBadgeLive}`);

            // Only consider it live if there are active stream indicators (not just cached HTML)
            if (hasWatchingNow || hasStartedStreaming || hasBadgeLive) {
                const watchUrl = `https://www.youtube.com${watchUrlMatch[0]}`;
                const handleUrl = `https://www.youtube.com/@${channelId}`;
                const title = await page.title().then(t => t.replace(' - YouTube', '').trim());
                const thumbnailUrl = await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null);

                logger.info(`[YouTube Check] Channel ${channelId} is LIVE: ${title}`);
                logger.info(`[YouTube Check] Returning URL: ${handleUrl}`);
                return {
                    isLive: true,
                    platform: 'youtube',
                    username: channelId,
                    url: handleUrl,  // Use @ handle URL instead of watch URL
                    title: title,
                    thumbnailUrl: thumbnailUrl,
                    game: null,
                    viewers: 'N/A',
                    profileImageUrl: profileImageUrl
                };
            } else {
                logger.info(`[YouTube Check] HTML markers found but no active stream indicators (cached/ended stream)`);
            }
        }

        logger.info(`[YouTube Check] Channel ${channelId} is not live`);
        return { ...defaultResponse, profileImageUrl: profileImageUrl };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[Check YouTube Error] for channel ID "${channelId}": ${errorMessage}`);
        return { isLive: 'unknown', profileImageUrl: null };
    } finally {
        if (browser) {
            await closeBrowser(browser);
        }
        logger.info(`[YouTube Check] Finished for channel ID: ${channelId}`);
    }
}

export { isStreamerLive, getStreamDetails };
