"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStreamerLive = isStreamerLive;
exports.getStreamDetails = getStreamDetails;
exports.getAccessToken = getAccessToken;
exports.getStreamSchedule = getStreamSchedule;
exports.getTwitchUser = getTwitchUser;
exports.getTwitchUsers = getTwitchUsers;
exports.getTwitchTeamMembers = getTwitchTeamMembers;
exports.getApiStatus = getApiStatus;
const axios_1 = __importDefault(require("axios"));
const logger_1 = __importDefault(require("./logger"));
let accessToken = null;
let tokenExpiresAt = 0;
async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiresAt) {
        return accessToken;
    }
    try {
        const response = await axios_1.default.post(`https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`);
        accessToken = response.data.access_token;
        tokenExpiresAt = Date.now() + (response.data.expires_in * 1000) - (5 * 60 * 1000); // Refresh 5 mins before expiry
        logger_1.default.info('Successfully refreshed Twitch API token.', { category: 'twitch' });
        return accessToken;
    }
    catch (error) {
        const errorData = axios_1.default.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger_1.default.error('Failed to get Twitch API token:', { error: errorData, category: 'twitch' });
        throw new Error('Could not get Twitch API token.');
    }
}
async function isStreamerLive(twitchUsername) {
    try {
        const token = await getAccessToken();
        const response = await axios_1.default.get(`https://api.twitch.tv/helix/streams?user_login=${twitchUsername}`, {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${token}`
            }
        });
        return response.data.data.length > 0;
    }
    catch (error) {
        const errorData = axios_1.default.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger_1.default.error(`Error checking if streamer ${twitchUsername} is live:`, { error: errorData, category: 'twitch' });
        return false;
    }
}
async function getStreamDetails(twitchUsername) {
    try {
        const token = await getAccessToken();
        const response = await axios_1.default.get(`https://api.twitch.tv/helix/streams?user_login=${twitchUsername}`, {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${token}`
            }
        });
        return response.data.data[0] || null;
    }
    catch (error) {
        const errorData = axios_1.default.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger_1.default.error(`Error getting stream details for ${twitchUsername}:`, { error: errorData, category: 'twitch' });
        return null;
    }
}
async function getStreamSchedule(twitchUserId) {
    try {
        const token = await getAccessToken();
        return await axios_1.default.get(`https://api.twitch.tv/helix/schedule?broadcaster_id=${twitchUserId}`, {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${token}`
            }
        });
    }
    catch (error) {
        const errorData = axios_1.default.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger_1.default.error(`Error getting stream schedule for ${twitchUserId}:`, { error: errorData, category: 'twitch' });
        return null;
    }
}
async function getTwitchUser(identifier) {
    const token = await getAccessToken();
    if (!token)
        return null;
    const isUserId = /^[0-9]+$/.test(identifier);
    const param = isUserId ? 'id' : 'login';
    try {
        const response = await axios_1.default.get(`https://api.twitch.tv/helix/users?${param}=${identifier.toLowerCase()}`, {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${token}`
            }
        });
        return response.data.data?.[0] || null;
    }
    catch (error) {
        const errorData = axios_1.default.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger_1.default.error(`[Twitch User Check Error] for "${identifier}":`, { error: errorData, category: 'twitch' });
        return null;
    }
}
async function getTwitchTeamMembers(teamName) {
    const token = await getAccessToken();
    if (!token)
        return null;
    try {
        const response = await axios_1.default.get(`https://api.twitch.tv/helix/teams?name=${teamName.toLowerCase()}`, {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${token}`
            }
        });
        return response.data.data?.[0]?.users || null;
    }
    catch (error) {
        const errorData = axios_1.default.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger_1.default.error(`[Twitch Team Check Error] for "${teamName}":`, { error: errorData, category: 'twitch' });
        return null;
    }
}
async function getTwitchUsers(usernames) {
    const token = await getAccessToken();
    if (!token || usernames.length === 0)
        return [];
    // Twitch API allows up to 100 users per request
    const maxPerRequest = 100;
    const chunks = [];
    for (let i = 0; i < usernames.length; i += maxPerRequest) {
        chunks.push(usernames.slice(i, i + maxPerRequest));
    }
    const allUsers = [];
    for (const chunk of chunks) {
        const loginParams = chunk.map(u => `login=${encodeURIComponent(u.toLowerCase())}`).join('&');
        try {
            const response = await axios_1.default.get(`https://api.twitch.tv/helix/users?${loginParams}`, {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${token}`
                }
            });
            if (response.data.data) {
                allUsers.push(...response.data.data);
            }
        }
        catch (error) {
            const errorData = axios_1.default.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
            logger_1.default.error(`[Twitch Batch User Check Error]:`, { error: errorData, category: 'twitch' });
        }
    }
    return allUsers;
}
async function getApiStatus() {
    try {
        await getAccessToken();
        return true;
    }
    catch (error) {
        return false;
    }
}
