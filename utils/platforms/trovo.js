import logger from '../logger.js';
import { getBrowser, closeBrowser } from '../browserManager.js';

/**
 * Check if a Trovo user is currently live using Playwright browser automation
 * @param {string} username - The Trovo username
 * @returns {Promise<boolean>} - True if the user is live, false otherwise
 */
async function isStreamerLive(username) {
    try {
        logger.info(`[Trovo API] Checking if ${username} is live`);
        const result = await checkTrovo(username);
        return result.isLive === true;
    } catch (error) {
        logger.error(`[Trovo API] Error checking live status for ${username}:`, { error });
        return false;
    }
}

/**
 * Get stream details for a live Trovo user
 * @param {string} username - The Trovo username
 * @returns {Promise<object|null>} - Stream details or null if not live
 */
async function getStreamDetails(username) {
    try {
        logger.info(`[Trovo API] Fetching stream details for ${username}`);
        const result = await checkTrovo(username);

        if (result.isLive !== true) {
            return null;
        }

        return {
            title: result.title || 'Untitled Stream',
            game_name: result.game || result.title || 'No Category',
            viewer_count: result.viewers || 0,
            thumbnail_url: result.thumbnailUrl || null,
            started_at: null, // Trovo doesn't provide start time easily
            url: result.url || null,
        };
    } catch (error) {
        logger.error(`[Trovo API] Failed to get stream details for ${username}:`, { error });
        return null;
    }
}

/**
 * Check Trovo user for live stream using Playwright browser automation
 * @param {string} username - The Trovo username
 * @returns {Promise<object>} - Object with isLive status and stream details
 */
async function checkTrovo(username) {
    logger.info(`[Trovo Check] Starting for username: ${username}`);
    const defaultResponse = { isLive: false, profileImageUrl: null };
    let browser = null;

    try {
        browser = await getBrowser();
        if (!browser) {
            logger.error('[Trovo Check] Browser not available.');
            return defaultResponse;
        }

        const page = await browser.newPage();
        page.on('crash', () => logger.error(`[Trovo Check] Page crashed for ${username}`));

        const url = `https://trovo.live/s/${username}`;
        await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});

        // Wait a bit more for dynamic content
        await page.waitForTimeout(3000);

        // Check if we were redirected away (user doesn't exist or is banned)
        if (!page.url().includes(`/s/${username}`)) {
            logger.info(`[Trovo Check] Redirect detected for ${username}. Final URL: ${page.url()}`);
            return { ...defaultResponse, profileImageUrl: null };
        }

        // Try to get profile image
        const profileImageUrl = await page.locator('.caster-avatar img').getAttribute('src').catch(() => null);

        // Check for OFFLINE status element first (most reliable)
        const isOffline = await page.locator('.status.offline').isVisible({ timeout: 3000 }).catch(() => false);
        logger.info(`[Trovo Check] Offline status element check: ${isOffline}`);

        let isLive = false;

        // Only check for live indicators if not explicitly offline
        if (!isOffline) {
            // Check for live indicator using multiple methods
            isLive = await page.locator('.live-indicator-ctn').isVisible({ timeout: 5000 }).catch(() => false);
            logger.info(`[Trovo Check] Live indicator element check: ${isLive}`);

            if (!isLive) {
                // Try checking for video player (indicates live stream)
                isLive = await page.locator('video').isVisible({ timeout: 3000 }).catch(() => false);
                logger.info(`[Trovo Check] Video player check: ${isLive}`);
            }
            if (!isLive) {
                // Check page HTML for "is_live" or similar indicators
                const content = await page.content();
                isLive = content.includes('"is_live":true') || content.includes('"isLive":true');
                logger.info(`[Trovo Check] Page source check for JSON: ${isLive}`);
            }
        }

        if (isLive) {
            // Try to get the stream title from the h3.title element
            let title = await page.locator('h3.title').textContent({ timeout: 2000 }).catch(() => null);
            if (!title) {
                // Fallback to page title
                title = await page.title().then(t => t.split('|')[0]?.trim() ?? '');
            }

            // Clean up and trim the title
            if (title) {
                title = title.trim();
            }

            // If title equals username (space name), treat as no title
            if (title === username) {
                title = '';
            }

            const game = await page.locator('div.category-name > a').textContent({ timeout: 2000 }).catch(() => null) ?? null;
            const thumbnailUrl = await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null) ?? null;
            const viewersText = await page.locator('.viewer-count span').textContent({ timeout: 2000 }).catch(() => '0') ?? '0';
            const viewers = parseInt(viewersText, 10) || 0;

            logger.info(`[Trovo Check] User ${username} is LIVE: ${title || 'Untitled Stream'}`);
            return {
                isLive: true,
                platform: 'trovo',
                username: username,
                url: url,
                title: title || 'Untitled Stream',
                game: game,
                thumbnailUrl: thumbnailUrl,
                viewers: viewers,
                profileImageUrl: profileImageUrl
            };
        }

        logger.info(`[Trovo Check] User ${username} is not live`);
        return { ...defaultResponse, profileImageUrl: profileImageUrl };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[Check Trovo Error] for "${username}": ${errorMessage}`);
        return { ...defaultResponse, profileImageUrl: null };
    } finally {
        if (browser) {
            await closeBrowser(browser);
        }
        logger.info(`[Trovo Check] Finished for username: ${username}`);
    }
}

export { isStreamerLive, getStreamDetails };
