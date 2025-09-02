// utils/api_checks.js (Rewritten v3 - Final)
const axios = require('axios');
const db = require('./db');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
// We need getBrowser for our new Kick function
const { getBrowser } = require('./browserManager');

let twitchToken = null, tokenExpires = 0;
const BROWSER_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' };

// --- TOKEN MANAGERS & OTHER HELPERS ---
// getTwitchAccessToken and getTwitchUser remain the same.
async function getTwitchAccessToken() { /* ... unchanged ... */ }
async function getTwitchUser(username) { /* ... unchanged ... */ }
// --- [PREVIOUS CODE FOR TWITCH FUNCTIONS] ---

// THIS IS THE CRITICAL CHANGE
/**
 * REWRITE V3: Using Playwright to make the request instead of axios.
 * This creates a real browser instance to bypass Kick's WAF (security policy).
 */
async function getKickUser(username) {
    let page = null;
    try {
        const browser = await getBrowser();
        if (!browser) {
            console.error('[Kick API Error] Playwright browser is not available.');
            return null;
        }
        page = await browser.newPage();
        
        // Go to the API URL and retrieve the JSON content directly.
        const response = await page.goto(`https://kick.com/api/v2/channels/${username.toLowerCase()}`);
        
        if (response && response.ok()) {
            return await response.json();
        } else {
            console.error(`[Kick API Error] for ${username}: Page returned status ${response?.status()}`);
            return null;
        }
    } catch (error) {
        console.error(`[Kick API Error] for ${username}: A Playwright error occurred.`, error.message);
        return null;
    } finally {
        if (page) await page.close().catch(()=>{});
    }
}


// --- LIVE STATUS CHECKERS ---
// The live checkers are now updated to use the helper functions correctly.

async function checkTwitch(streamer) {
    // ... [Unchanged]
}

async function checkKick(username) {
    try {
        // This will now use the new, reliable playwright-based function
        const kickData = await getKickUser(username);
        if (kickData && kickData.livestream) {
            return {
                isLive: true,
                username: kickData.user.username,
                url: `https://kick.com/${kickData.user.username}`,
                title: kickData.livestream.session_title,
                game: kickData.livestream.categories?.[0]?.name || 'N/A',
                thumbnailUrl: kickData.livestream.thumbnail?.url
            };
        }
        return { isLive: false };
    } catch (error) {
        return { isLive: false };
    }
}

// All other functions (YouTube, TikTok, Trovo) remain the same.
async function checkYouTube(channelId) {
    // ... [Unchanged]
}
async function checkTikTok(username) {
    // ... [Unchanged]
}
async function checkTrovo(username) {
    // ... [Unchanged]
}


module.exports = { getTwitchUser, getKickUser, checkTwitch, checkYouTube, checkKick, checkTikTok, checkTrovo };
// --- Make sure to copy the full unchanged functions back in where specified ---
// Below are the full unchanged functions for easy copy-pasting

async function getTwitchAccessToken() {
    if (twitchToken && tokenExpires > Date.now()) return twitchToken;
    try {
        const response = await axios.post(`https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`);
        twitchToken = response.data.access_token;
        tokenExpires = Date.now() + (response.data.expires_in * 1000);
        return twitchToken;
    } catch (error) { 
        console.error("[Twitch Auth Error]", error.response?.data || error.message);
        return null;
    }
}

async function getTwitchUser(username) {
    const token = await getTwitchAccessToken();
    if (!token) return null;
    try {
        const res = await axios.get(`https://api.twitch.tv/helix/users?login=${username}`, { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } });
        return res.data.data[0];
    } catch (e) { return null; }
}

async function checkTwitch(streamer) {
    const token = await getTwitchAccessToken();
    if (!token) return { isLive: false };
    try {
        const res = await axios.get(`https://api.twitch.tv/helix/streams?user_id=${streamer.platform_user_id}`, { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } });
        const streamData = res.data.data[0];
        if (streamData) {
            return { isLive: true, username: streamData.user_name, url: `https://www.twitch.tv/${streamData.user_login}`, title: streamData.title, game: streamData.game_name, thumbnailUrl: streamData.thumbnail_url.replace('{width}', '1280').replace('{height}', '720') };
        }
        return { isLive: false };
    } catch (e) { return { isLive: false }; }
}

async function checkYouTube(channelId) {
    if (!process.env.YOUTUBE_API_KEY) {
        console.error("[YouTube API Error] YOUTUBE_API_KEY is missing from the .env file.");
        return { isLive: false };
    }
    try {
        const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: { part: 'snippet', channelId: channelId, eventType: 'live', type: 'video', key: process.env.YOUTUBE_API_KEY }
        });
        const liveStream = res.data.items[0];
        if (liveStream) {
            const videoId = liveStream.id.videoId;
            return { isLive: true, url: `https://www.youtube.com/watch?v=${videoId}`, title: liveStream.snippet.title, thumbnailUrl: liveStream.snippet.thumbnails.high.url, game: 'N/A' };
        }
        return { isLive: false };
    } catch (error) {
        console.error(`[YouTube API Error] for ${channelId}:`, error.response?.data?.error?.message || error.message);
        return { isLive: false };
    }
}

async function checkTikTok(username) {
    let page = null;
    try {
        const browser = await getBrowser();
        if (!browser) return { isLive: false };
        page = await browser.newPage();
        await page.goto(`https://www.tiktok.com/@${username}/live`, { waitUntil: "domcontentloaded", timeout: 30000 });
        const isLive = await page.evaluate(() => !!document.querySelector('div[data-e2e="live-room-normal"]'));
        if (isLive) {
            const title = await page.title();
            return { isLive: true, url: `https://www.tiktok.com/@${username}/live`, title: title.includes(username) ? title : 'Live on TikTok' };
        }
        return { isLive: false };
    } catch (e) { return { isLive: false }; }
    finally { if (page) await page.close().catch(()=>{}); }
}

async function checkTrovo(username) {
    try {
        const res = await axios.post('https://api-web.trovo.live/graphql', {"operationName":"live_LiveReaderService_GetLiveInfo","variables":{"params":{"userName":username,"requireDetail":true}},"query":"query live_LiveReaderService_GetLiveInfo($params: LiveReadGetLiveInfoRequest!) {\n  live_LiveReaderService_GetLiveInfo(params: $params) {\n    isLive\n    title\n    streamerInfo {\n      userName\n      nickName\n    }\n    category {\n      name\n    }\n    thumbUrl: programPic\n  }\n}"});
        const details = res.data?.data?.live_LiveReaderService_GetLiveInfo;
        if (details?.isLive) {
            return { isLive: true, username: details.streamerInfo.nickName, url: `https://trovo.live/s/${details.streamerInfo.userName}`, title: details.title, game: details.category.name, thumbnailUrl: details.thumbUrl };
        }
        return { isLive: false };
    } catch (error) { return { isLive: false }; }
}