// utils/api_checks.js (DEFINITIVE - All functions restored and working)
const axios = require('axios');
const db = require('./db');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const initCycleTLS = require('cycletls');
const tough = require('tough-cookie');
const { getBrowser } = require('./browserManager');

let twitchToken = null;
let tokenExpires = 0;
const cookieJar = new tough.CookieJar();

async function getYouTubeChannelId(username) {
    if (!process.env.YOUTUBE_API_KEY) return null;
    try {
        const response = await axios.get('https://www.googleapis.com/youtube/v3/search', { params: { part: 'snippet', q: username, type: 'channel', maxResults: 1, key: process.env.YOUTUBE_API_KEY }});
        return response.data.items?.[0]?.id?.channelId || null;
    } catch (error) { return null; }
}
async function getKickUser(cycleTLS, username) {
    if (typeof username !== 'string' || !username) return null;
    try {
        const requestUrl = `https://kick.com/api/v2/channels/${username.toLowerCase()}`;
        const ageGateCookie = new tough.Cookie({ key: 'kick_agreed_to_age_gate', value: 'true', domain: 'kick.com' });
        await cookieJar.setCookie(ageGateCookie, 'https://kick.com');
        const response = await cycleTLS(requestUrl, {
            userAgent: 'KICK/1.0.13 Dalvik/2.1.0(Linux; U; Android 13; Pixel 6 Pro Build / TQ1A.221205.011)',
            headers: { 'Accept': 'application/json', 'Cookie': await cookieJar.getCookieString(requestUrl) },
            ja3: '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0',
            timeout: 60
        });
        if (response.status === 200 && response.body) return response.body;
        return null;
    } catch (error) { return null; }
}
async function getTwitchAccessToken() {
    if (twitchToken && tokenExpires > Date.now()) return twitchToken;
    try {
        const response = await axios.post(`https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`);
        twitchToken = response.data.access_token;
        tokenExpires = Date.now() + (response.data.expires_in * 1000);
        return twitchToken;
    } catch (error) { return null; }
}
async function getTwitchUser(username) {
    const token = await getTwitchAccessToken();
    if (!token) return null;
    try {
        const res = await axios.get(`https://api.twitch.tv/helix/users?login=${username}`, { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } });
        return res.data.data[0];
    } catch (e) { return null; }
}
async function checkKick(cycleTLS, username) {
    try {
        const kickData = await getKickUser(cycleTLS, username);
        if (kickData && kickData.livestream) {
            return { isLive: true, username: kickData.user.username, url: `https://kick.com/${kickData.user.username}`, title: kickData.livestream.session_title, game: kickData.livestream.categories?.[0]?.name || 'N/A', thumbnailUrl: kickData.livestream.thumbnail?.url || kickData.user?.profile_pic };
        }
        return { isLive: false };
    } catch (error) { return { isLive: false }; }
}
async function checkTwitch(streamer) {
    const token = await getTwitchAccessToken();
    if (!token) return { isLive: false };
    try {
        const res = await axios.get(`https://api.twitch.tv/helix/streams?user_id=${streamer.platform_user_id}`, { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } });
        const streamData = res.data.data[0];
        if (streamData) { return { isLive: true, username: streamData.user_name, url: `https://www.twitch.tv/${streamData.user_login}`, title: streamData.title, game: streamData.game_name, thumbnailUrl: streamData.thumbnail_url.replace('{width}', '1280').replace('{height}', '720') }; }
        return { isLive: false };
    } catch (e) { return { isLive: false }; }
}
async function checkYouTube(channelId) {
    if (!process.env.YOUTUBE_API_KEY) { return { isLive: false }; }
    try {
        const res = await axios.get('https://www.googleapis.com/youtube/v3/search', { params: { part: 'snippet', channelId: channelId, eventType: 'live', type: 'video', key: process.env.YOUTUBE_API_KEY } });
        const liveStream = res.data.items[0];
        if (liveStream) { const videoId = liveStream.id.videoId; return { isLive: true, url: `https://www.youtube.com/watch?v=${videoId}`, title: liveStream.snippet.title, thumbnailUrl: liveStream.snippet.thumbnails.high.url, game: 'N/A' }; }
        return { isLive: false };
    } catch (error) { return { isLive: false }; }
}
async function checkTikTok(username) {
    let page = null;
    try {
        const browser = await getBrowser();
        if (!browser) return { isLive: false };
        page = await browser.newPage();
        await page.goto(`https://www.tiktok.com/@${username}/live`, { waitUntil: "domcontentloaded", timeout: 30000 });
        const isLive = await page.evaluate(() => !!document.querySelector('div[data-e2e="live-room-normal"]'));
        if (isLive) { const title = await page.title(); return { isLive: true, url: `https://www.tiktok.com/@${username}/live`, title: title.includes(username) ? title : 'Live on TikTok' }; }
        return { isLive: false };
    } catch (e) { return { isLive: false }; }
    finally { if (page) await page.close().catch(()=>{}); }
}
async function checkTrovo(username) {
    try {
        const res = await axios.post('https://api-web.trovo.live/graphql', {"operationName":"live_LiveReaderService_GetLiveInfo","variables":{"params":{"userName":username,"requireDetail":true}},"query":"query live_LiveReaderService_GetLiveInfo($params: LiveReadGetLiveInfoRequest!) {\n  live_LiveReaderService_GetLiveInfo(params: $params) {\n    isLive\n    title\n    streamerInfo {\n      userName\n      nickName\n    }\n    category {\n      name\n    }\n    thumbUrl: programPic\n  }\n}"});
        const details = res.data?.data?.live_LiveReaderService_GetLiveInfo;
        if (details?.isLive) { return { isLive: true, username: details.streamerInfo.nickName, url: `https://trovo.live/s/${details.streamerInfo.userName}`, title: details.title, game: details.category.name, thumbnailUrl: details.thumbUrl }; }
        return { isLive: false };
    } catch (error) { return { isLive: false }; }
}
module.exports = { getYouTubeChannelId, getTwitchUser, getKickUser, checkTwitch, checkYouTube, checkKick, checkTikTok, checkTrovo };