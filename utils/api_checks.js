"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getYouTubeChannelId = getYouTubeChannelId;
exports.getTrovoUser = getTrovoUser;
exports.getTikTokUser = getTikTokUser;
exports.getFacebookUser = getFacebookUser;
exports.getInstagramUser = getInstagramUser;
exports.checkYouTube = checkYouTube;
exports.checkKick = checkKick;
exports.checkTikTok = checkTikTok;
exports.checkTrovo = checkTrovo;
exports.checkFacebook = checkFacebook;
exports.checkInstagram = checkInstagram;
exports.getLatestYouTubeVideo = getLatestYouTubeVideo;
const axios_1 = __importDefault(require("axios"));
const browserManager_1 = require("./browserManager");
const logger_1 = require("./logger");
const kick_api_1 = require("./kick-api");
// ==================== YOUTUBE FUNCTIONS ====================
async function getYouTubeChannelId(identifier) {
    if (!process.env.YOUTUBE_API_KEY) {
        logger_1.logger.error("[YouTube API Error] YOUTUBE_API_KEY is not set in the environment variables.");
        return null;
    }
    let searchIdentifier = identifier;
    if (identifier.startsWith('@')) {
        searchIdentifier = identifier.substring(1);
    }
    if (identifier.startsWith('UC')) {
        return { channelId: identifier, channelName: null };
    }
    try {
        const searchResponse = await axios_1.default.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                part: 'snippet',
                q: searchIdentifier,
                type: 'channel',
                maxResults: 1,
                key: process.env.YOUTUBE_API_KEY
            }
        });
        if (searchResponse.data.items?.[0]) {
            return {
                channelId: searchResponse.data.items[0].id.channelId,
                channelName: searchResponse.data.items[0].snippet.title
            };
        }
        const channelResponse = await axios_1.default.get('https://www.googleapis.com/youtube/v3/channels', {
            params: {
                part: 'snippet',
                forUsername: searchIdentifier,
                key: process.env.YOUTUBE_API_KEY
            }
        });
        if (channelResponse.data.items?.[0]) {
            return {
                channelId: channelResponse.data.items[0].id,
                channelName: channelResponse.data.items[0].snippet.title
            };
        }
        logger_1.logger.warn(`[YouTube API Check] Could not find a channel for identifier: "${identifier}"`);
        return null;
    }
    catch (error) {
        const axiosError = error;
        const errorMessage = axiosError.response?.data?.error?.message || (error instanceof Error ? error.message : 'Unknown error');
        logger_1.logger.error(`[YouTube API Check Error] for "${identifier}": ${errorMessage}`);
        return null;
    }
}
// ==================== TROVO FUNCTIONS ====================
async function getTrovoUser(username) {
    if (typeof username !== 'string' || !username)
        return null;
    logger_1.logger.info(`[Trovo API] getTrovoUser started for: ${username}`);
    try {
        const trovoData = await checkTrovo(username);
        if (trovoData && trovoData.profileImageUrl) {
            logger_1.logger.info(`[Trovo API] Successfully validated Trovo user ${username}.`);
            return { userId: username, username: username, profileImageUrl: trovoData.profileImageUrl };
        }
        logger_1.logger.info(`[Trovo API] Could not validate Trovo user ${username}. They may not exist.`);
        return null;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger_1.logger.error(`[Trovo API Check Error] for "${username}": ${errorMessage}`);
        return null;
    }
}
// ==================== TIKTOK FUNCTIONS ====================
async function getTikTokUser(username) {
    if (typeof username !== 'string' || !username)
        return null;
    logger_1.logger.info(`[TikTok API] getTikTokUser started for: ${username}`);
    try {
        const tiktokData = await checkTikTok(username);
        if (tiktokData && tiktokData.profileImageUrl) {
            logger_1.logger.info(`[TikTok API] Successfully validated TikTok user ${username}.`);
            return { userId: username, username: username, profileImageUrl: tiktokData.profileImageUrl };
        }
        logger_1.logger.info(`[TikTok API] Could not validate TikTok user ${username}. They may not exist.`);
        return null;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger_1.logger.error(`[TikTok API Check Error] for "${username}": ${errorMessage}`);
        return null;
    }
}
// ==================== KICK FUNCTIONS ====================
async function checkKick(username) {
    logger_1.logger.info(`[Kick Check] Starting for username: ${username}`);
    const defaultResponse = { isLive: false, profileImageUrl: null };
    try {
        const kickData = await (0, kick_api_1.getKickUser)(username);
        if (kickData === null) {
            return { ...defaultResponse, profileImageUrl: null };
        }
        const profileImageUrl = kickData?.user?.profile_pic || null;
        if (kickData?.livestream && kickData.livestream.id) {
            const thumbnail = kickData.livestream.thumbnail;
            const thumbnailUrl = thumbnail?.src || thumbnail?.url || profileImageUrl;
            return {
                isLive: true,
                platform: 'kick',
                username: kickData.user.username,
                url: `https://kick.com/${kickData.user.username}`,
                title: kickData.livestream.session_title || 'Untitled Stream',
                game: kickData.livestream.categories?.[0]?.name || 'N/A',
                thumbnailUrl: thumbnailUrl,
                viewers: kickData.livestream.viewer_count || 0,
                profileImageUrl: profileImageUrl
            };
        }
        return { ...defaultResponse, profileImageUrl: profileImageUrl };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger_1.logger.warn(`[Check Kick] Could not determine status for "${username}" due to API errors: ${errorMessage}`);
        return { isLive: 'unknown', profileImageUrl: null };
    }
    finally {
        logger_1.logger.info(`[Kick Check] Finished for username: ${username}`);
    }
}
// ==================== YOUTUBE CHECK FUNCTION ====================
async function checkYouTube(channelId) {
    logger_1.logger.info(`[YouTube Check] Starting for channel ID: ${channelId}`);
    const defaultResponse = { isLive: false, profileImageUrl: null };
    let browser = null;
    try {
        browser = await (0, browserManager_1.getBrowser)();
        if (!browser) {
            logger_1.logger.error('[YouTube Check] Browser not available.');
            return defaultResponse;
        }
        const page = await browser.newPage();
        page.on('crash', () => logger_1.logger.error(`[YouTube Check] Page crashed for ${channelId}`));
        const url = `https://www.youtube.com/channel/${channelId}/live`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        if (!page.url().includes(channelId)) {
            logger_1.logger.info(`[YouTube Check] Redirect detected for ${channelId}. Final URL: ${page.url()}`);
            return { ...defaultResponse, profileImageUrl: null };
        }
        const profileImageUrl = await page.locator('#avatar #img').getAttribute('src').catch(() => null);
        if (page.url().includes("/watch")) {
            const isLiveBadge = await page.locator('span.ytp-live-badge').isVisible({ timeout: 5000 });
            if (isLiveBadge) {
                const title = await page.title().then(t => t.replace(' - YouTube', '').trim());
                const thumbnailUrl = await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null);
                return {
                    isLive: true,
                    platform: 'youtube',
                    username: title,
                    url: page.url(),
                    title: title,
                    thumbnailUrl: thumbnailUrl,
                    game: 'N/A',
                    viewers: 'N/A',
                    profileImageUrl: profileImageUrl
                };
            }
        }
        return { ...defaultResponse, profileImageUrl: profileImageUrl };
    }
    catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Unknown error';
        logger_1.logger.error(`[Check YouTube Error] for channel ID "${channelId}": ${errorMessage}`);
        return { isLive: 'unknown', profileImageUrl: null };
    }
    finally {
        if (browser)
            await (0, browserManager_1.closeBrowser)(browser);
        logger_1.logger.info(`[YouTube Check] Finished for channel ID: ${channelId}`);
    }
}
// ==================== TIKTOK CHECK FUNCTION ====================
async function checkTikTok(username) {
    logger_1.logger.info(`[TikTok Check] Starting for username: ${username}`);
    const defaultResponse = { isLive: false, profileImageUrl: null };
    let browser = null;
    try {
        browser = await (0, browserManager_1.getBrowser)();
        if (!browser) {
            logger_1.logger.error('[TikTok Check] Browser not available.');
            return defaultResponse;
        }
        const page = await browser.newPage();
        page.on('crash', () => logger_1.logger.error(`[TikTok Check] Page crashed for ${username}`));
        const url = `https://www.tiktok.com/@${username}/live`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        if (!page.url().includes(username)) {
            logger_1.logger.info(`[TikTok Check] Redirect detected for ${username}. Final URL: ${page.url()}`);
            return { ...defaultResponse, profileImageUrl: null };
        }
        const profileImageUrl = await page.locator('img[class*="StyledAvatar"]').getAttribute('src').catch(() => null);
        const isLive = await page.locator('[data-e2e="live-room-normal"]').isVisible({ timeout: 5000 });
        if (isLive) {
            const title = await page.title();
            const viewersText = await page.locator('[data-e2e="live-room-user-count"] span').first().textContent({ timeout: 2000 }).catch(() => 'N/A') ?? 'N/A';
            return {
                isLive: true,
                platform: 'tiktok',
                username: username,
                url: url,
                title: title.includes(username) ? title : 'Live on TikTok',
                game: 'N/A',
                thumbnailUrl: profileImageUrl,
                viewers: viewersText,
                profileImageUrl: profileImageUrl
            };
        }
        return { ...defaultResponse, profileImageUrl: profileImageUrl };
    }
    catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Unknown error';
        logger_1.logger.error(`[Check TikTok Error] for "${username}": ${errorMessage}`);
        return { ...defaultResponse, profileImageUrl: null };
    }
    finally {
        if (browser)
            await (0, browserManager_1.closeBrowser)(browser);
        logger_1.logger.info(`[TikTok Check] Finished for username: ${username}`);
    }
}
// ==================== TROVO CHECK FUNCTION ====================
async function checkTrovo(username) {
    logger_1.logger.info(`[Trovo Check] Starting for username: ${username}`);
    const defaultResponse = { isLive: false, profileImageUrl: null };
    let browser = null;
    try {
        browser = await (0, browserManager_1.getBrowser)();
        if (!browser) {
            logger_1.logger.error('[Trovo Check] Browser not available.');
            return defaultResponse;
        }
        const page = await browser.newPage();
        page.on('crash', () => logger_1.logger.error(`[Trovo Check] Page crashed for ${username}`));
        const url = `https://trovo.live/s/${username}`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        if (!page.url().includes(`/s/${username}`)) {
            logger_1.logger.info(`[Trovo Check] Redirect detected for ${username}. Final URL: ${page.url()}`);
            return { ...defaultResponse, profileImageUrl: null };
        }
        const profileImageUrl = await page.locator('.caster-avatar img').getAttribute('src').catch(() => null);
        const isLive = await page.locator('.live-indicator-ctn').isVisible({ timeout: 5000 });
        if (isLive) {
            const title = await page.title().then(t => t.split('|')[0]?.trim() ?? '');
            const game = await page.locator('div.category-name > a').textContent({ timeout: 2000 }).catch(() => 'N/A') ?? 'N/A';
            const thumbnailUrl = await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null) ?? null;
            const viewersText = await page.locator('.viewer-count span').textContent({ timeout: 2000 }).catch(() => '0') ?? '0';
            const viewers = parseInt(viewersText, 10) || 0;
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
        return { ...defaultResponse, profileImageUrl: profileImageUrl };
    }
    catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Unknown error';
        logger_1.logger.error(`[Check Trovo Error] for "${username}": ${errorMessage}`);
        return { ...defaultResponse, profileImageUrl: null };
    }
    finally {
        if (browser)
            await (0, browserManager_1.closeBrowser)(browser);
        logger_1.logger.info(`[Trovo Check] Finished for username: ${username}`);
    }
}
// ==================== FACEBOOK FUNCTIONS ====================
async function checkFacebook(username) {
    logger_1.logger.info(`[Facebook Check] Starting for username: ${username}`);
    const defaultResponse = { isLive: false, profileImageUrl: null };
    let browser = null;
    try {
        browser = await (0, browserManager_1.getBrowser)();
        if (!browser) {
            logger_1.logger.error('[Facebook Check] Browser not available.');
            return defaultResponse;
        }
        const page = await browser.newPage();
        page.on('crash', () => logger_1.logger.error(`[Facebook Check] Page crashed for ${username}`));
        // Facebook Gaming URL format
        const url = `https://www.facebook.com/gaming/${username}`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        // Check if redirected or user doesn't exist
        if (!page.url().includes(username) && !page.url().includes('/gaming/')) {
            logger_1.logger.info(`[Facebook Check] Redirect detected for ${username}. Final URL: ${page.url()}`);
            return { ...defaultResponse, profileImageUrl: null };
        }
        // Try to get profile image
        const profileImageUrl = await page.locator('img[data-imgperflogname="profileCoverPhoto"]').getAttribute('src').catch(() => page.locator('img[class*="ProfilePhoto"]').getAttribute('src').catch(() => null));
        // Check for live indicator
        const isLiveAriaLabel = await page.locator('[aria-label*="Live"]').isVisible({ timeout: 5000 }).catch(() => false);
        const isLiveText = await page.locator('text=/LIVE/i').isVisible({ timeout: 5000 }).catch(() => false);
        const isLive = isLiveAriaLabel || isLiveText;
        if (isLive) {
            const title = await page.title().then(t => t.split('|')[0]?.trim() ?? '');
            const thumbnailUrl = await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null) ?? null;
            return {
                isLive: true,
                platform: 'facebook',
                username: username,
                url: url,
                title: title || 'Live on Facebook Gaming',
                game: 'N/A', // Facebook doesn't always expose game category via scraping
                thumbnailUrl: thumbnailUrl,
                viewers: 'N/A', // Viewer count often hidden or requires login
                profileImageUrl: profileImageUrl
            };
        }
        return { ...defaultResponse, profileImageUrl: profileImageUrl };
    }
    catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Unknown error';
        logger_1.logger.error(`[Check Facebook Error] for "${username}": ${errorMessage}`);
        return { ...defaultResponse, profileImageUrl: null };
    }
    finally {
        if (browser)
            await (0, browserManager_1.closeBrowser)(browser);
        logger_1.logger.info(`[Facebook Check] Finished for username: ${username}`);
    }
}
async function getFacebookUser(username) {
    if (typeof username !== 'string' || !username)
        return null;
    logger_1.logger.info(`[Facebook API] getFacebookUser started for: ${username}`);
    try {
        const facebookData = await checkFacebook(username);
        if (facebookData && facebookData.profileImageUrl) {
            logger_1.logger.info(`[Facebook API] Successfully validated Facebook Gaming user ${username}.`);
            return { userId: username, username: username, profileImageUrl: facebookData.profileImageUrl };
        }
        logger_1.logger.info(`[Facebook API] Could not validate Facebook Gaming user ${username}. They may not exist.`);
        return null;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger_1.logger.error(`[Facebook API Check Error] for "${username}": ${errorMessage}`);
        return null;
    }
}
// ==================== INSTAGRAM FUNCTIONS ====================
async function checkInstagram(username) {
    logger_1.logger.info(`[Instagram Check] Starting for username: ${username}`);
    const defaultResponse = { isLive: false, profileImageUrl: null };
    let browser = null;
    try {
        browser = await (0, browserManager_1.getBrowser)();
        if (!browser) {
            logger_1.logger.error('[Instagram Check] Browser not available.');
            return defaultResponse;
        }
        const page = await browser.newPage();
        page.on('crash', () => logger_1.logger.error(`[Instagram Check] Page crashed for ${username}`));
        const url = `https://www.instagram.com/${username}/live/`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        // Check if redirected or user doesn't exist
        if (!page.url().includes(username)) {
            logger_1.logger.info(`[Instagram Check] Redirect detected for ${username}. Final URL: ${page.url()}`);
            return { ...defaultResponse, profileImageUrl: null };
        }
        // Try to get profile image
        const profileImageUrl = await page.locator('img[class*="xpdipgo"]').getAttribute('src').catch(() => page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null));
        // Check for live indicator - Instagram shows "LIVE" badge
        const isLiveAriaLabel = await page.locator('[aria-label*="Live"]').isVisible({ timeout: 5000 }).catch(() => false);
        const isLiveText = await page.locator('text=/LIVE/i').first().isVisible({ timeout: 5000 }).catch(() => false);
        const isLive = isLiveAriaLabel || isLiveText;
        if (isLive) {
            const title = await page.title().then(t => t.replace(' • Instagram', '').trim());
            return {
                isLive: true,
                platform: 'instagram',
                username: username,
                url: `https://www.instagram.com/${username}/`,
                title: title || `${username} is live on Instagram`,
                game: 'N/A',
                thumbnailUrl: profileImageUrl,
                viewers: 'N/A', // Viewer count requires login to see
                profileImageUrl: profileImageUrl
            };
        }
        return { ...defaultResponse, profileImageUrl: profileImageUrl };
    }
    catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Unknown error';
        logger_1.logger.error(`[Check Instagram Error] for "${username}": ${errorMessage}`);
        return { ...defaultResponse, profileImageUrl: null };
    }
    finally {
        if (browser)
            await (0, browserManager_1.closeBrowser)(browser);
        logger_1.logger.info(`[Instagram Check] Finished for username: ${username}`);
    }
}
async function getInstagramUser(username) {
    if (typeof username !== 'string' || !username)
        return null;
    logger_1.logger.info(`[Instagram API] getInstagramUser started for: ${username}`);
    try {
        const instagramData = await checkInstagram(username);
        if (instagramData && instagramData.profileImageUrl) {
            logger_1.logger.info(`[Instagram API] Successfully validated Instagram user ${username}.`);
            return { userId: username, username: username, profileImageUrl: instagramData.profileImageUrl };
        }
        logger_1.logger.info(`[Instagram API] Could not validate Instagram user ${username}. They may not exist.`);
        return null;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger_1.logger.error(`[Instagram API Check Error] for "${username}": ${errorMessage}`);
        return null;
    }
}
/**
 * Get the latest YouTube video for a channel
 * @param channelId - YouTube channel ID
 * @returns Latest video data or null if not found
 */
async function getLatestYouTubeVideo(channelId) {
    try {
        const response = await axios_1.default.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                part: 'snippet',
                channelId: channelId,
                order: 'date',
                maxResults: 1,
                type: 'video',
                key: process.env.YOUTUBE_API_KEY
            }
        });
        const item = response.data.items?.[0];
        if (!item)
            return null;
        return {
            videoId: item.id.videoId,
            title: item.snippet.title,
            url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
            thumbnailUrl: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || null,
            publishedAt: item.snippet.publishedAt,
            channelTitle: item.snippet.channelTitle
        };
    }
    catch (error) {
        logger_1.logger.error(`[YouTube API] Error fetching latest video for channel ${channelId}:`, { error: error.response?.data || error.message });
        return null;
    }
}
