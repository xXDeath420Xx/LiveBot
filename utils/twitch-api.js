const axios = require("axios");
const db = require("./db");
const logger = require("./logger");

let accessToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiresAt) {
        return accessToken;
    }

    try {
        const response = await axios.post(`https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`);
        accessToken = response.data.access_token;
        tokenExpiresAt = Date.now() + (response.data.expires_in * 1000) - (5 * 60 * 1000); // Refresh 5 mins before expiry
        logger.info("Successfully refreshed Twitch API token.", { category: "twitch" });
        return accessToken;
    } catch (error) {
        logger.error("Failed to get Twitch API token:", { error: error.response?.data || error.message, category: "twitch" });
        throw new Error("Could not get Twitch API token.");
    }
}

async function isStreamerLive(twitchUsername) {
    try {
        const token = await getAccessToken();
        const response = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${twitchUsername}`,
            {
                headers: {
                    "Client-ID": process.env.TWITCH_CLIENT_ID,
                    "Authorization": `Bearer ${token}`
                }
            }
        );
        return response.data.data.length > 0;
    } catch (error) {
        logger.error(`Error checking if streamer ${twitchUsername} is live:`, { error: error.response?.data || error.message, category: "twitch" });
        return false;
    }
}

async function getStreamDetails(twitchUsername) {
    try {
        const token = await getAccessToken();
        const response = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${twitchUsername}`,
            {
                headers: {
                    "Client-ID": process.env.TWITCH_CLIENT_ID,
                    "Authorization": `Bearer ${token}`
                }
            }
        );
        return response.data.data[0];
    } catch (error) {
        logger.error(`Error getting stream details for ${twitchUsername}:`, { error: error.response?.data || error.message, category: "twitch" });
        return null;
    }
}

async function getStreamSchedule(twitchUserId) {
    try {
        const token = await getAccessToken();
        return await axios.get(`https://api.twitch.tv/helix/schedule?broadcaster_id=${twitchUserId}`,
            {
                headers: {
                    "Client-ID": process.env.TWITCH_CLIENT_ID,
                    "Authorization": `Bearer ${token}`
                }
            }
        );
    } catch (error) {
        logger.error(`Error getting stream schedule for ${twitchUserId}:`, { error: error.response?.data || error.message, category: "twitch" });
        return null;
    }
}

async function getTwitchUser(identifier) {
    const token = await getAccessToken();
    if (!token) return null;
    const isUserId = /^[0-9]+$/.test(identifier);
    const param = isUserId ? 'id' : 'login';
    try {
        const res = await axios.get(`https://api.twitch.tv/helix/users?${param}=${identifier.toLowerCase()}`, { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } });
        return res.data.data?.[0];
    } catch (e) {
        logger.error(`[Twitch User Check Error] for "${identifier}":`, e.response ? e.response.data : e.message, { category: "twitch" });
        return null;
    }
}

async function getTwitchTeamMembers(teamName) {
    const token = await getAccessToken();
    if (!token) return null;
    try {
        const res = await axios.get(`https://api.twitch.tv/helix/teams?name=${teamName.toLowerCase()}`, { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } });
        return res.data.data?.[0]?.users || null;
    } catch (e) {
        logger.error(`[Twitch Team Check Error] for "${teamName}":`, e.response ? e.response.data : e.message, { category: "twitch" });
        return null;
    }
}

module.exports = { isStreamerLive, getStreamDetails, getAccessToken, getStreamSchedule, getTwitchUser, getTwitchTeamMembers };