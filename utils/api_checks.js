const axios = require('axios');
const initCycleTLS = require('cycletls');
const { getBrowser } = require('./browserManager');

let twitchToken = null;
let tokenExpires = 0;

async function getYouTubeChannelId(identifier) {
    if (!process.env.YOUTUBE_API_KEY) {
        console.error("[YouTube API Error] YOUTUBE_API_KEY is not set in the environment variables.");
        return null;
    }
    if (identifier && identifier.startsWith('UC')) {
        return { channelId: identifier, channelName: null };
    }
    try {
        const searchResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: { part: 'snippet', q: identifier, type: 'channel', maxResults: 1, key: process.env.YOUTUBE_API_KEY }
        });
        if (searchResponse.data.items?.[0]) {
            return {
                channelId: searchResponse.data.items[0].id.channelId,
                channelName: searchResponse.data.items[0].snippet.title
            };
        }

        const channelResponse = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
            params: { part: 'snippet', forUsername: identifier, key: process.env.YOUTUBE_API_KEY }
        });
        if (channelResponse.data.items?.[0]) {
            return {
                channelId: channelResponse.data.items[0].id,
                channelName: channelResponse.data.items[0].snippet.title
            };
        }
        return null;
    } catch (error) {
        console.error(`[YouTube API Check Error] for "${identifier}":`, error.response?.data?.error?.message || error.message);
        return null;
    }
}

async function getKickUser(cycleTLS, username) {
    if (typeof username !== 'string' || !username) return null;
    try {
        const requestUrl = `https://kick.com/api/v1/channels/${username.toLowerCase()}`;
        const response = await cycleTLS(requestUrl, {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        });
        if (response.status === 200 && response.body) {
            return typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
        }
        return null;
    } catch (error) {
        console.error(`[Kick API Check Error] for "${username}":`, error.message);
        return null;
    }
}

async function getTwitchAccessToken() {
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
        console.error("[Twitch Auth Error] Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET in the .env file.");
        return null;
    }
    if (twitchToken && tokenExpires > Date.now()) return twitchToken;
    try {
        const response = await axios.post('https://id.twitch.tv/oauth2/token', `client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        twitchToken = response.data.access_token;
        tokenExpires = Date.now() + (response.data.expires_in * 1000);
        return twitchToken;
    } catch (error) { 
        console.error("[Twitch Auth Error]", error.response ? error.response.data : error.message);
        return null; 
    }
}

async function getTwitchUser(identifier) {
    const token = await getTwitchAccessToken();
    if (!token) return null;
    const isUserId = /^[0-9]+$/.test(identifier);
    const param = isUserId ? 'id' : 'login';
    try {
        const res = await axios.get(`https://api.twitch.tv/helix/users?${param}=${identifier.toLowerCase()}`, { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } });
        return res.data.data?.[0];
    } catch (e) {
        console.error(`[Twitch User Check Error] for "${identifier}":`, e.response ? e.response.data : e.message);
        return null;
    }
}

async function getTwitchTeamMembers(teamName) {
    const token = await getTwitchAccessToken();
    if (!token) return null;
    try {
        const res = await axios.get(`https://api.twitch.tv/helix/teams?name=${teamName.toLowerCase()}`, { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } });
        return res.data.data?.[0]?.users || null;
    } catch (e) {
        console.error(`[Twitch Team Check Error] for "${teamName}":`, e.response ? e.response.data : e.message);
        return null;
    }
}

async function checkKick(cycleTLS, username) {
    const defaultResponse = { isLive: false, username: username, platform: 'kick', url: `https://kick.com/${username.toLowerCase()}`, title: null, game: null, thumbnailUrl: null, viewers: 0 };
    try {
        const kickData = await getKickUser(cycleTLS, username);
        if (kickData?.livestream) {
            return { 
                isLive: true, 
                platform: 'kick',
                username: kickData.user.username, 
                url: `https://kick.com/${kickData.user.username}`, 
                title: kickData.livestream.session_title || 'Untitled Stream', 
                game: kickData.livestream.categories?.[0]?.name || 'N/A', 
                thumbnailUrl: kickData.livestream.thumbnail?.src || kickData.user?.profile_pic || null,
                viewers: kickData.livestream.viewer_count || 0
            };
        }
        return defaultResponse;
    } catch (error) {
        console.error(`[Check Kick Error] for "${username}":`, error.message);
        return defaultResponse; 
    }
}

async function checkTwitch(streamer) {
    const defaultResponse = { isLive: false, username: streamer.username, platform: 'twitch', url: `https://www.twitch.tv/${streamer.username}`, title: null, game: null, thumbnailUrl: null, viewers: 0 };
    const token = await getTwitchAccessToken();
    if (!token) return defaultResponse;
    try {
        const res = await axios.get(`https://api.twitch.tv/helix/streams?user_id=${streamer.platform_user_id}`, { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } });
        const streamData = res.data.data[0];
        if (streamData) {
            let thumbnailUrl = streamData.thumbnail_url?.replace('{width}', '1280').replace('{height}', '720') || null;
            return { 
                isLive: true, 
                platform: 'twitch',
                username: streamData.user_name, 
                url: `https://www.twitch.tv/${streamData.user_login}`, 
                title: streamData.title || 'Untitled Stream', 
                game: streamData.game_name || 'N/A', 
                thumbnailUrl: thumbnailUrl, 
                viewers: streamData.viewer_count 
            };
        }
        return defaultResponse;
    } catch (e) {
        console.error(`[Check Twitch Error] for user ID "${streamer.platform_user_id}":`, e.response ? e.response.data : e.message);
        return defaultResponse; 
    }
}

async function checkYouTube(browser, channelId) {
    const defaultResponse = { isLive: false, platform: 'youtube', username: `Channel ${channelId}`, url: `https://www.youtube.com/channel/${channelId}`, title: null, game: null, thumbnailUrl: null, viewers: 0 };
    let page = null;
    try {
        if (!browser || !browser.isConnected()) return defaultResponse;
        page = await browser.newPage();
        await page.goto(`https://www.youtube.com/channel/${channelId}/live`, { waitUntil: "domcontentloaded", timeout: 30000 });
        if (page.url().includes("/watch")) {
            const isLiveBadge = await page.locator('span.ytp-live-badge').isVisible({ timeout: 2000 });
            if (isLiveBadge) {
                const title = await page.title().then(t => t.replace(' - YouTube', '').trim());
                return {
                    isLive: true, platform: 'youtube', username: title, url: page.url(),
                    title: title, thumbnailUrl: await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null),
                    game: 'N/A', viewers: 'N/A'
                };
            }
        }
        return defaultResponse;
    } catch (e) {
        console.error(`[Check YouTube Error] for channel ID "${channelId}":`, e.message);
        return defaultResponse;
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

async function checkTikTok(browser, username) {
    const defaultResponse = { isLive: false, platform: 'tiktok', username, url: `https://www.tiktok.com/@${username}`, title: null, game: null, thumbnailUrl: null, viewers: 0 };
    let page = null;
    try {
        if (!browser || !browser.isConnected()) return defaultResponse;
        page = await browser.newPage();
        await page.goto(`https://www.tiktok.com/@${username}/live`, { waitUntil: "domcontentloaded", timeout: 30000 });
        const isLive = await page.locator('[data-e2e="live-room-normal"]').isVisible({ timeout: 5000 });
        if (isLive) { 
            const title = await page.title();
            return { 
                isLive: true, platform: 'tiktok', username: username, url: `https://www.tiktok.com/@${username}/live`,
                title: title.includes(username) ? title : 'Live on TikTok', game: 'N/A', 
                viewers: await page.locator('[data-e2e="live-room-user-count"] span').first().textContent({ timeout: 2000 }).catch(() => 'N/A')
            }; 
        }
        return defaultResponse;
    } catch (e) {
        console.error(`[Check TikTok Error] for "${username}":`, e.message);
        return defaultResponse; 
    }
    finally { if (page) await page.close().catch(() => {}); }
}

async function checkTrovo(browser, username) {
    const defaultResponse = { isLive: false, platform: 'trovo', username, url: `https://trovo.live/s/${username}`, title: null, game: null, thumbnailUrl: null, viewers: 0 };
    let page = null;
    try {
        if (!browser || !browser.isConnected()) return defaultResponse;
        page = await browser.newPage();
        await page.goto(`https://trovo.live/s/${username}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        const isLive = await page.locator('.live-indicator-ctn').isVisible({ timeout: 5000 });
        if (isLive) {
            const title = await page.title().then(t => t.split('|')[0].trim());
            const game = await page.locator('div.category-name > a').textContent({ timeout: 2000 }).catch(() => 'N/A');
            return {
                isLive: true, platform: 'trovo', username: username, url: `https://trovo.live/s/${username}`,
                title: title || 'Untitled Stream', game: game, thumbnailUrl: await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null),
                viewers: parseInt(await page.locator('.viewer-count span').textContent({ timeout: 2000 }).catch(() => '0'), 10) || 0
            };
        }
        return defaultResponse;
    } catch (e) {
        console.error(`[Check Trovo Error] for "${username}":`, e.message);
        return defaultResponse;
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

module.exports = { getYouTubeChannelId, getTwitchUser, getKickUser, checkTwitch, checkYouTube, checkKick, checkTikTok, checkTrovo, getTwitchTeamMembers };