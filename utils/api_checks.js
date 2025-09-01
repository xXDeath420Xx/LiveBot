const axios = require('axios');
const { getBrowser } = require('./browserManager'); // Keep browser for TikTok/Trovo
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

let twitchToken = null;
let tokenExpires = 0;

async function getTwitchAccessToken() { /* ... unchanged ... */ }
async function getTwitchUser(username) { /* ... unchanged ... */ }
async function checkTwitch(streamer) { /* ... unchanged ... */ }

// FIX: New, reliable API method for Kick. No Puppeteer needed.
async function checkKick(username) {
    if (!username) return null;
    const url = `https://kick.com/api/v2/channels/${username.toLowerCase()}`;
    try {
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                'Accept': 'application/json',
            }
        });
        return data && data.id ? data : null;
    } catch (error) {
        if (error.response?.status !== 404) console.error(`[Kick API] Error for ${username}: ${error.message}`);
        return null;
    }
}

// FIX: New, reliable API method for YouTube. No Puppeteer needed.
async function checkYouTube(channelId) {
    if (!channelId) return { is_live: false };
    const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY; // You must get a key from Google Cloud Console
    if (!YOUTUBE_API_KEY) {
        console.error('[YouTube API] YOUTUBE_API_KEY is missing from .env file.');
        return { is_live: false };
    }
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&eventType=live&type=video&key=${YOUTUBE_API_KEY}`;
    try {
        const { data } = await axios.get(url);
        if (data.items && data.items.length > 0) {
            const video = data.items[0];
            return {
                is_live: true,
                url: `https://www.youtube.com/watch?v=${video.id.videoId}`,
                title: video.snippet.title,
                thumbnailUrl: video.snippet.thumbnails.high.url
            };
        }
        return { is_live: false };
    } catch (error) {
        console.error(`[YouTube API] Error for ${channelId}:`, error.response?.data?.error?.message || error.message);
        return { is_live: false };
    }
}

// Puppeteer-based checkers remain for platforms without reliable APIs
async function checkTikTok(browser, username){ /* ... unchanged ... */ }
async function checkTrovo(browser, username){ /* ... unchanged ... */ }

module.exports = { getTwitchUser, checkTwitch, checkKick, checkYouTube, checkTikTok, checkTrovo };