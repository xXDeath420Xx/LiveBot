import axios, { AxiosResponse } from 'axios';
import logger from './logger';
import { TwitchStreamData, TwitchUserData } from '../types';

let accessToken: string | null = null;
let tokenExpiresAt: number = 0;

interface TwitchTokenResponse {
    access_token: string;
    expires_in: number;
}

interface TwitchStreamsResponse {
    data: TwitchStreamData[];
}

interface TwitchUsersResponse {
    data: TwitchUserData[];
}

interface TwitchScheduleResponse {
    data: any;
}

async function getAccessToken(): Promise<string> {
    if (accessToken && Date.now() < tokenExpiresAt) {
        return accessToken;
    }

    try {
        const response: AxiosResponse<TwitchTokenResponse> = await axios.post(
            `https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`
        );
        accessToken = response.data.access_token;
        tokenExpiresAt = Date.now() + (response.data.expires_in * 1000) - (5 * 60 * 1000); // Refresh 5 mins before expiry
        logger.info('Successfully refreshed Twitch API token.', { category: 'twitch' });
        return accessToken;
    } catch (error: unknown) {
        const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger.error('Failed to get Twitch API token:', { error: errorData, category: 'twitch' });
        throw new Error('Could not get Twitch API token.');
    }
}

async function isStreamerLive(twitchUsername: string): Promise<boolean> {
    try {
        const token = await getAccessToken();
        const response: AxiosResponse<TwitchStreamsResponse> = await axios.get(
            `https://api.twitch.tv/helix/streams?user_login=${twitchUsername}`,
            {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID as string,
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        return response.data.data.length > 0;
    } catch (error: unknown) {
        const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger.error(`Error checking if streamer ${twitchUsername} is live:`, { error: errorData, category: 'twitch' });
        return false;
    }
}

async function getStreamDetails(twitchUsername: string): Promise<TwitchStreamData | null> {
    try {
        const token = await getAccessToken();
        const response: AxiosResponse<TwitchStreamsResponse> = await axios.get(
            `https://api.twitch.tv/helix/streams?user_login=${twitchUsername}`,
            {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID as string,
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        return response.data.data[0] || null;
    } catch (error: unknown) {
        const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger.error(`Error getting stream details for ${twitchUsername}:`, { error: errorData, category: 'twitch' });
        return null;
    }
}

async function getStreamSchedule(twitchUserId: string): Promise<AxiosResponse<TwitchScheduleResponse> | null> {
    try {
        const token = await getAccessToken();
        return await axios.get(
            `https://api.twitch.tv/helix/schedule?broadcaster_id=${twitchUserId}`,
            {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID as string,
                    'Authorization': `Bearer ${token}`
                }
            }
        );
    } catch (error: unknown) {
        const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger.error(`Error getting stream schedule for ${twitchUserId}:`, { error: errorData, category: 'twitch' });
        return null;
    }
}

async function getTwitchUser(identifier: string): Promise<TwitchUserData | null> {
    const token = await getAccessToken();
    if (!token) return null;

    const isUserId = /^[0-9]+$/.test(identifier);
    const param = isUserId ? 'id' : 'login';

    try {
        const response: AxiosResponse<TwitchUsersResponse> = await axios.get(
            `https://api.twitch.tv/helix/users?${param}=${identifier.toLowerCase()}`,
            {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID as string,
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        return response.data.data?.[0] || null;
    } catch (error: unknown) {
        const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger.error(`[Twitch User Check Error] for "${identifier}":`, { error: errorData, category: 'twitch' });
        return null;
    }
}

interface TwitchTeamMember {
    user_id: string;
    user_login: string;
    user_name: string;
}

interface TwitchTeamResponse {
    data: Array<{
        users: TwitchTeamMember[];
    }>;
}

async function getTwitchTeamMembers(teamName: string): Promise<TwitchTeamMember[] | null> {
    const token = await getAccessToken();
    if (!token) return null;

    try {
        const response: AxiosResponse<TwitchTeamResponse> = await axios.get(
            `https://api.twitch.tv/helix/teams?name=${teamName.toLowerCase()}`,
            {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID as string,
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        return response.data.data?.[0]?.users || null;
    } catch (error: unknown) {
        const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        logger.error(`[Twitch Team Check Error] for "${teamName}":`, { error: errorData, category: 'twitch' });
        return null;
    }
}

async function getTwitchUsers(usernames: string[]): Promise<TwitchUserData[]> {
    const token = await getAccessToken();
    if (!token || usernames.length === 0) return [];

    // Twitch API allows up to 100 users per request
    const maxPerRequest = 100;
    const chunks: string[][] = [];
    for (let i = 0; i < usernames.length; i += maxPerRequest) {
        chunks.push(usernames.slice(i, i + maxPerRequest));
    }

    const allUsers: TwitchUserData[] = [];
    for (const chunk of chunks) {
        const loginParams = chunk.map(u => `login=${encodeURIComponent(u.toLowerCase())}`).join('&');
        try {
            const response: AxiosResponse<TwitchUsersResponse> = await axios.get(
                `https://api.twitch.tv/helix/users?${loginParams}`,
                {
                    headers: {
                        'Client-ID': process.env.TWITCH_CLIENT_ID as string,
                        'Authorization': `Bearer ${token}`
                    }
                }
            );
            if (response.data.data) {
                allUsers.push(...response.data.data);
            }
        } catch (error: unknown) {
            const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
            logger.error(`[Twitch Batch User Check Error]:`, { error: errorData, category: 'twitch' });
        }
    }
    return allUsers;
}

async function getApiStatus(): Promise<boolean> {
    try {
        await getAccessToken();
        return true;
    } catch (error: unknown) {
        return false;
    }
}

export {
    isStreamerLive,
    getStreamDetails,
    getAccessToken,
    getStreamSchedule,
    getTwitchUser,
    getTwitchUsers,
    getTwitchTeamMembers,
    getApiStatus
};
