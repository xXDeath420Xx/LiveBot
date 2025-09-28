import axios from "axios";
import {CycleTLSClient} from "cycletls";
import {getBrowser} from "./browserManager";
import {logger} from "./logger";

let twitchToken: string | null = null;
let tokenExpires = 0;

async function getYouTubeChannelId(identifier: string | null) {
    if (!process.env.YOUTUBE_API_KEY) {
        logger.error("[YouTube API Error] YOUTUBE_API_KEY is not set.");
        return null;
    }
    if (identifier && identifier.startsWith("UC")) {
        return {channelId: identifier, channelName: null};
    }
    try {
        const searchResponse = await axios.get("https://www.googleapis.com/youtube/v3/search", {
            params: {part: "snippet", q: identifier, type: "channel", maxResults: 1, key: process.env.YOUTUBE_API_KEY}
        });
        if (searchResponse.data.items?.[0]) {
            return {
                channelId: searchResponse.data.items[0].id.channelId,
                channelName: searchResponse.data.items[0].snippet.title
            };
        }
        const channelResponse = await axios.get("https://www.googleapis.com/youtube/v3/channels", {
            params: {part: "snippet", forUsername: identifier, key: process.env.YOUTUBE_API_KEY}
        });
        if (channelResponse.data.items?.[0]) {
            return {
                channelId: channelResponse.data.items[0].id,
                channelName: channelResponse.data.items[0].snippet.title
            };
        }
        return null;
    } catch (error) {
        logger.error(`[YouTube API Check Error] for "${identifier}":`, {error: error.response?.data?.error?.message || error.message});
        return null;
    }
}

async function getKickUser(cycleTLS: CycleTLSClient, username: string | null | undefined) {
    if (typeof username !== "string" || !username) {
        return null;
    }
    try {
        const response = await cycleTLS(`https://kick.com/api/v1/channels/${username.toLowerCase()}`, {
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
        });
        if (response.status === 200 && response.body) {
            return typeof response.body === "string" ? JSON.parse(response.body) : response.body;
        }
        return null;
    } catch (error) {
        logger.error(`[Kick API Check Error] for "${username}":`, {error: error.message});
        return null;
    }
}

async function getTwitchAccessToken() {
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
        logger.error("[Twitch Auth Error] Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET.");
        return null;
    }
    if (twitchToken && tokenExpires > Date.now()) {
        return twitchToken;
    }
    try {
        const response = await axios.post("https://id.twitch.tv/oauth2/token", `client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`);
        twitchToken = response.data.access_token;
        tokenExpires = Date.now() + (response.data.expires_in * 1000);
        return twitchToken;
    } catch (error) {
        logger.error("[Twitch Auth Error]", {error: error.response ? error.response.data : error.message});
        return null;
    }
}

async function getTwitchUser(identifier: string) {
    const token = await getTwitchAccessToken();
    if (!token) {
        return null;
    }
    const param = /^[0-9]+$/.test(identifier) ? "id" : "login";
    try {
        const res = await axios.get(`https://api.twitch.tv/helix/users?${param}=${identifier.toLowerCase()}`, {headers: {"Client-ID": process.env.TWITCH_CLIENT_ID, "Authorization": `Bearer ${token}`}});
        return res.data.data?.[0];
    } catch (e) {
        logger.error(`[Twitch User Check Error] for "${identifier}":`, {error: e.response ? e.response.data : e.message});
        return null;
    }
}

async function getTwitchTeamMembers(teamName: string) {
    const token = await getTwitchAccessToken();
    if (!token) {
        return null;
    }
    try {
        const res = await axios.get(`https://api.twitch.tv/helix/teams?name=${teamName.toLowerCase()}`, {headers: {"Client-ID": process.env.TWITCH_CLIENT_ID, "Authorization": `Bearer ${token}`}});
        return res.data.data?.[0]?.users || null;
    } catch (e) {
        logger.error(`[Twitch Team Check Error] for "${teamName}":`, {error: e.response ? e.response.data : e.message});
        return null;
    }
}

async function checkKick(cycleTLS: CycleTLSClient, username: string | null) {
    const defaultResponse = {isLive: false, profileImageUrl: null};
    try {
        const kickData = await getKickUser(cycleTLS, username);
        const profileImageUrl = kickData?.user?.profile_pic || null;
        if (kickData?.livestream) {
            return {
                isLive: true, platform: "kick", username: kickData.user.username, url: `https://kick.com/${kickData.user.username}`,
                title: kickData.livestream.session_title || "Untitled Stream", game: kickData.livestream.categories?.[0]?.name || "N/A",
                thumbnailUrl: kickData.livestream.thumbnail?.src || profileImageUrl, viewers: kickData.livestream.viewer_count || 0, profileImageUrl
            };
        }
        return {...defaultResponse, profileImageUrl};
    } catch (error) {
        logger.error(`[Check Kick Error] for "${username}":`, {error: error.message});
        return defaultResponse;
    }
}

async function checkTwitch(streamer: { platform_user_id: string }) {
    const defaultResponse = {isLive: false, profileImageUrl: null};
    const token = await getTwitchAccessToken();
    if (!token) {
        return defaultResponse;
    }
    let profileImageUrl = null;
    try {
        const userRes = await axios.get(`https://api.twitch.tv/helix/users?id=${streamer.platform_user_id}`, {headers: {"Client-ID": process.env.TWITCH_CLIENT_ID, "Authorization": `Bearer ${token}`}});
        profileImageUrl = userRes.data.data?.[0]?.profile_image_url || null;
    } catch (e) { /* Ignore */
    }

    try {
        const streamRes = await axios.get(`https://api.twitch.tv/helix/streams?user_id=${streamer.platform_user_id}`, {headers: {"Client-ID": process.env.TWITCH_CLIENT_ID, "Authorization": `Bearer ${token}`}});
        const streamData = streamRes.data.data[0];
        if (streamData) {
            const uptimeSeconds = Math.floor((Date.now() - new Date(streamData.started_at).getTime()) / 1000);
            let gameArtUrl = null;
            if (streamData.game_id) {
                try {
                    const gameRes = await axios.get(`https://api.twitch.tv/helix/games?id=${streamData.game_id}`, {headers: {"Client-ID": process.env.TWITCH_CLIENT_ID, "Authorization": `Bearer ${token}`}});
                    gameArtUrl = gameRes.data.data?.[0]?.box_art_url.replace("{width}", "285").replace("{height}", "380") || null;
                } catch (gameError) { /* Ignore */
                }
            }
            return {
                isLive: true, platform: "twitch", username: streamData.user_name, url: `https://www.twitch.tv/${streamData.user_login}`,
                title: streamData.title || "Untitled Stream", game: streamData.game_name || "N/A",
                thumbnailUrl: streamData.thumbnail_url?.replace("{width}", "1280").replace("{height}", "720"),
                viewers: streamData.viewer_count, profileImageUrl, uptime: uptimeSeconds, gameArtUrl
            };
        }
        return {isLive: false, profileImageUrl};
    } catch (e) {
        logger.error(`[Check Twitch Error] for user ID "${streamer.platform_user_id}":`, {error: e.message});
        return {...defaultResponse, profileImageUrl};
    }
}

async function checkYouTube(channelId: string) {
    const defaultResponse = {isLive: false, profileImageUrl: null};
    let page = null;
    try {
        const browser = await getBrowser();
        if (!browser) {
            return defaultResponse;
        }
        page = await browser.newPage();
        const url = `https://www.youtube.com/channel/${channelId}/live`;
        await page.goto(url, {waitUntil: "domcontentloaded", timeout: 45000});
        const profileImageUrl = await page.locator("#avatar #img").getAttribute("src").catch(() => null);
        if (page.url().includes("/watch")) {
            const isLiveBadge = await page.locator("span.ytp-live-badge").isVisible({timeout: 5000});
            if (isLiveBadge) {
                const title = await page.title().then(t => t.replace(" - YouTube", "").trim());
                return {
                    isLive: true, platform: "youtube", username: title, url: page.url(), title, profileImageUrl,
                    thumbnailUrl: await page.locator("meta[property=\"og:image\"]").getAttribute("content").catch(() => null), game: "N/A", viewers: "N/A"
                };
            }
        }
        return {...defaultResponse, profileImageUrl};
    } catch (e) {
        logger.error(`[Check YouTube Error] for channel ID "${channelId}":`, {error: e.message});
        return defaultResponse;
    } finally {
        if (page) {
            await page.close().catch(() => {
            });
        }
    }
}

async function checkTikTok(username: string) {
    logger.warn(`[checkTiktok] DEBUG: Hard-coded to return isLive:false (checking ${username}`);
    return {isLive: false};
}

async function checkTrovo(username: string) {
    logger.warn(`[checkTrovo] DEBUG: Hard-coded to return isLive:false (checking ${username}`);
    return {isLive: false};
}

export {getYouTubeChannelId, getTwitchUser, getKickUser, checkTwitch, checkYouTube, checkKick, checkTikTok, checkTrovo, getTwitchTeamMembers};
