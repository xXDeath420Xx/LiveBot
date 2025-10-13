const axios = require('axios');
const { getBrowser, closeBrowser } = require('./browserManager');
const logger = require('./logger');
const kickApi = require('./kick-api');

// getCycleTLSInstance and exitCycleTLSInstance have been moved to utils/tls-manager.js
// to break a circular dependency.

async function getYouTubeChannelId(identifier) {
    if (!process.env.YOUTUBE_API_KEY) {
        logger.error("[YouTube API Error] YOUTUBE_API_KEY is not set in the environment variables.");
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
        const searchResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
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

        const channelResponse = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
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

        logger.warn(`[YouTube API Check] Could not find a channel for identifier: "${identifier}"`);
        return null;
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        logger.error(`[YouTube API Check Error] for "${identifier}": ${errorMessage}`);
        return null;
    }
}

async function getTrovoUser(username) {
    if (typeof username !== 'string' || !username) return null;
    logger.info(`[Trovo API] getTrovoUser started for: ${username}`);
    try {
        const trovoData = await checkTrovo(username);
        if (trovoData && trovoData.profileImageUrl) {
            logger.info(`[Trovo API] Successfully validated Trovo user ${username}.`);
            return { userId: username, username: username, profileImageUrl: trovoData.profileImageUrl };
        }
        logger.info(`[Trovo API] Could not validate Trovo user ${username}. They may not exist.`);
        return null;
    } catch (error) {
        logger.error(`[Trovo API Check Error] for "${username}":`, error.message);
        return null;
    }
}

async function getTikTokUser(username) {
    if (typeof username !== 'string' || !username) return null;
    logger.info(`[TikTok API] getTikTokUser started for: ${username}`);
    try {
        const tiktokData = await checkTikTok(username);
        if (tiktokData && tiktokData.profileImageUrl) {
            logger.info(`[TikTok API] Successfully validated TikTok user ${username}.`);
            return { userId: username, username: username, profileImageUrl: tiktokData.profileImageUrl };
        }
        logger.info(`[TikTok API] Could not validate TikTok user ${username}. They may not exist.`);
        return null;
    } catch (error) {
        logger.error(`[TikTok API Check Error] for "${username}":`, error.message);
        return null;
    }
}

async function checkKick(username) {
    logger.info(`[Kick Check] Starting for username: ${username}`);
    const defaultResponse = { isLive: false, profileImageUrl: null };

    try {
        const kickData = await kickApi.getKickUser(username);

        if (kickData === null) {
            return { ...defaultResponse, profileImageUrl: null };
        }

        const profileImageUrl = kickData?.user?.profile_pic || null;

        if (kickData?.livestream && kickData.livestream.id) {
            return {
                isLive: true,
                platform: 'kick',
                username: kickData.user.username,
                url: `https://kick.com/${kickData.user.username}`,
                title: kickData.livestream.session_title || 'Untitled Stream',
                game: kickData.livestream.categories?.[0]?.name || 'N/A',
                thumbnailUrl: kickData.livestream.thumbnail?.src || profileImageUrl,
                viewers: kickData.livestream.viewer_count || 0,
                profileImageUrl: profileImageUrl
            };
        }
        return { ...defaultResponse, profileImageUrl: profileImageUrl };
    } catch (error) {
        logger.warn(`[Check Kick] Could not determine status for "${username}" due to API errors: ${error.message}`);
        return { isLive: 'unknown', profileImageUrl: null };
    } finally {
        logger.info(`[Kick Check] Finished for username: ${username}`);
    }
}

async function checkYouTube(channelId) {
    logger.info(`[YouTube Check] Starting for channel ID: ${channelId}`);
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

        const url = `https://www.youtube.com/channel/${channelId}/live`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

        if (!page.url().includes(channelId)) {
            logger.info(`[YouTube Check] Redirect detected for ${channelId}. Final URL: ${page.url()}`);
            return { ...defaultResponse, profileImageUrl: null };
        }

        const profileImageUrl = await page.locator('#avatar #img').getAttribute('src').catch(() => null);

        if (page.url().includes("/watch")) {
            const isLiveBadge = await page.locator('span.ytp-live-badge').isVisible({ timeout: 5000 });
            if (isLiveBadge) {
                const title = await page.title().then(t => t.replace(' - YouTube', '').trim());
                return {
                    isLive: true, platform: 'youtube', username: title, url: page.url(),
                    title: title, thumbnailUrl: await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null),
                    game: 'N/A', viewers: 'N/A', profileImageUrl: profileImageUrl
                };
            }
        }
        return { ...defaultResponse, profileImageUrl: profileImageUrl };
    } catch (e) {
        logger.error(`[Check YouTube Error] for channel ID "${channelId}":`, e.message);
        return { isLive: 'unknown', profileImageUrl: null };
    } finally {
        if (browser) await closeBrowser(browser);
        logger.info(`[YouTube Check] Finished for channel ID: ${channelId}`);
    }
}

async function checkTikTok(username) {
    logger.info(`[TikTok Check] Starting for username: ${username}`);
    const defaultResponse = { isLive: false, profileImageUrl: null };
    let browser = null;
    try {
        browser = await getBrowser();
        if (!browser) {
            logger.error('[TikTok Check] Browser not available.');
            return defaultResponse;
        }
        const page = await browser.newPage();
        page.on('crash', () => logger.error(`[TikTok Check] Page crashed for ${username}`));

        const url = `https://www.tiktok.com/@${username}/live`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

        if (!page.url().includes(username)) {
            logger.info(`[TikTok Check] Redirect detected for ${username}. Final URL: ${page.url()}`);
            return { ...defaultResponse, profileImageUrl: null };
        }

        const profileImageUrl = await page.locator('img[class*="StyledAvatar"]').getAttribute('src').catch(() => null);
        const isLive = await page.locator('[data-e2e="live-room-normal"]').isVisible({ timeout: 5000 });

        if (isLive) {
            const title = await page.title();
            return {
                isLive: true, platform: 'tiktok', username: username, url: url,
                title: title.includes(username) ? title : 'Live on TikTok', game: 'N/A',
                viewers: await page.locator('[data-e2e="live-room-user-count"] span').first().textContent({ timeout: 2000 }).catch(() => 'N/A'),
                profileImageUrl: profileImageUrl
            };
        }
        return { ...defaultResponse, profileImageUrl: profileImageUrl };
    } catch (e) {
        logger.error(`[Check TikTok Error] for "${username}":`, e.message);
        return { ...defaultResponse, profileImageUrl: null };
    } finally {
        if (browser) await closeBrowser(browser);
        logger.info(`[TikTok Check] Finished for username: ${username}`);
    }
}

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
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

        if (!page.url().includes(`/s/${username}`)) {
            logger.info(`[Trovo Check] Redirect detected for ${username}. Final URL: ${page.url()}`);
            return { ...defaultResponse, profileImageUrl: null };
        }

        const profileImageUrl = await page.locator('.caster-avatar img').getAttribute('src').catch(() => null);
        const isLive = await page.locator('.live-indicator-ctn').isVisible({ timeout: 5000 });
        if (isLive) {
            const title = await page.title().then(t => t.split('|')[0].trim());
            const game = await page.locator('div.category-name > a').textContent({ timeout: 2000 }).catch(() => 'N/A');
            return {
                isLive: true, platform: 'trovo',
                username: username, url: url,
                title: title || 'Untitled Stream', game: game, thumbnailUrl: await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null),
                viewers: parseInt(await page.locator('.viewer-count span').textContent({ timeout: 2000 }).catch(() => '0'), 10) || 0,
                profileImageUrl: profileImageUrl
            };
        }
        return { ...defaultResponse, profileImageUrl: profileImageUrl };
    } catch (e) {
        logger.error(`[Check Trovo Error] for "${username}":`, e.message);
        return { ...defaultResponse, profileImageUrl: null };
    } finally {
        if (browser) await closeBrowser(browser);
        logger.info(`[Trovo Check] Finished for username: ${username}`);
    }
}

module.exports = { getYouTubeChannelId, getTrovoUser, getTikTokUser, checkYouTube, checkKick, checkTikTok, checkTrovo };