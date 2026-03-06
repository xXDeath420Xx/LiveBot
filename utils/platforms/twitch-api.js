import axios from 'axios';
import logger from '../logger.js';

let accessToken = null;
let tokenExpiresAt = 0;

/**
 * Get or refresh Twitch API access token
 * @returns {Promise<string>} Access token
 */
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt) {
    return accessToken;
  }

  try {
    const response = await axios.post(
      `https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`
    );
    accessToken = response.data.access_token;
    tokenExpiresAt = Date.now() + (response.data.expires_in * 1000) - (5 * 60 * 1000); // Refresh 5 mins before expiry
    logger.info('Successfully refreshed Twitch API token.', { category: 'twitch' });
    return accessToken;
  } catch (error) {
    const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
    logger.error('Failed to get Twitch API token:', { error: errorData, category: 'twitch' });
    throw new Error('Could not get Twitch API token.');
  }
}

/**
 * Validate Twitch username format
 * @param {string} username - Username to validate
 * @returns {boolean} True if valid
 */
function isValidTwitchUsername(username) {
  if (!username || typeof username !== 'string') return false;
  const trimmed = username.trim();
  if (trimmed.length < 4 || trimmed.length > 25) return false;
  return /^[a-zA-Z0-9_]+$/.test(trimmed);
}

/**
 * Validate Twitch user ID format (numeric only)
 * @param {string} userId - User ID to validate
 * @returns {boolean} True if valid
 */
function isValidTwitchUserId(userId) {
  if (!userId || typeof userId !== 'string') return false;
  const trimmed = userId.trim();
  return /^[0-9]+$/.test(trimmed) && trimmed.length > 0;
}

/**
 * Check if a Twitch streamer is currently live
 * @param {string} twitchUsername - Twitch username
 * @returns {Promise<boolean>} True if live, false otherwise
 */
async function isStreamerLive(twitchUsername) {
  if (!isValidTwitchUsername(twitchUsername)) {
    logger.warn(`Invalid Twitch username format: "${twitchUsername}" - skipping API call`, { category: 'twitch' });
    return false;
  }

  try {
    const token = await getAccessToken();
    const response = await axios.get(
      `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(twitchUsername.trim().toLowerCase())}`,
      {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${token}`
        }
      }
    );
    return response.data.data.length > 0;
  } catch (error) {
    const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
    logger.error(`Error checking if streamer ${twitchUsername} is live:`, { error: errorData, category: 'twitch' });
    return false;
  }
}

/**
 * Get stream details for a Twitch streamer
 * @param {string} twitchUsername - Twitch username
 * @returns {Promise<Object|null>} Stream data or null if offline/error
 */
async function getStreamDetails(twitchUsername) {
  if (!isValidTwitchUsername(twitchUsername)) {
    logger.warn(`Invalid Twitch username format for stream details: "${twitchUsername}" - skipping API call`, { category: 'twitch' });
    return null;
  }

  try {
    const token = await getAccessToken();
    const response = await axios.get(
      `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(twitchUsername.trim().toLowerCase())}`,
      {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${token}`
        }
      }
    );
    return response.data.data[0] || null;
  } catch (error) {
    const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
    logger.error(`Error getting stream details for ${twitchUsername}:`, { error: errorData, category: 'twitch' });
    return null;
  }
}

/**
 * Get stream schedule for a Twitch broadcaster
 * @param {string} twitchUserId - Twitch user ID (must be numeric)
 * @returns {Promise<Object|null>} Schedule response or null if error
 */
async function getStreamSchedule(twitchUserId) {
  // Validate broadcaster_id is a numeric user ID, not a username
  if (!isValidTwitchUserId(twitchUserId)) {
    logger.warn(`Invalid Twitch user ID for schedule: "${twitchUserId}" - broadcaster_id must be numeric`, { category: 'twitch' });
    return null;
  }

  try {
    const token = await getAccessToken();
    return await axios.get(
      `https://api.twitch.tv/helix/schedule?broadcaster_id=${encodeURIComponent(twitchUserId.trim())}`,
      {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${token}`
        }
      }
    );
  } catch (error) {
    const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
    logger.error(`Error getting stream schedule for ${twitchUserId}:`, { error: errorData, category: 'twitch' });
    return null;
  }
}

/**
 * Get Twitch user by username or user ID
 * @param {string} identifier - Username or user ID
 * @returns {Promise<Object|null>} User data or null if not found
 */
async function getTwitchUser(identifier) {
  if (!identifier || typeof identifier !== 'string' || identifier.trim().length === 0) {
    logger.warn(`Invalid Twitch identifier: "${identifier}" - skipping API call`, { category: 'twitch' });
    return null;
  }

  const token = await getAccessToken();
  if (!token) return null;

  const trimmed = identifier.trim();
  const isUserId = /^[0-9]+$/.test(trimmed);
  const param = isUserId ? 'id' : 'login';

  // Validate username format if not a user ID
  if (!isUserId && !isValidTwitchUsername(trimmed)) {
    logger.warn(`Invalid Twitch username format: "${trimmed}" - skipping API call`, { category: 'twitch' });
    return null;
  }

  try {
    const response = await axios.get(
      `https://api.twitch.tv/helix/users?${param}=${encodeURIComponent(trimmed.toLowerCase())}`,
      {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${token}`
        }
      }
    );
    return response.data.data?.[0] || null;
  } catch (error) {
    const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
    logger.error(`[Twitch User Check Error] for "${identifier}":`, { error: errorData, category: 'twitch' });
    return null;
  }
}

/**
 * Get Twitch team members by team name
 * @param {string} teamName - Team name
 * @returns {Promise<Array|null>} Array of team members or null if error
 */
async function getTwitchTeamMembers(teamName) {
  if (!teamName || typeof teamName !== 'string' || teamName.trim().length === 0) {
    logger.warn(`Invalid Twitch team name: "${teamName}" - skipping API call`, { category: 'twitch' });
    return null;
  }

  const token = await getAccessToken();
  if (!token) return null;

  try {
    const response = await axios.get(
      `https://api.twitch.tv/helix/teams?name=${encodeURIComponent(teamName.trim().toLowerCase())}`,
      {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${token}`
        }
      }
    );
    return response.data.data?.[0]?.users || null;
  } catch (error) {
    const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
    logger.error(`[Twitch Team Check Error] for "${teamName}":`, { error: errorData, category: 'twitch' });
    return null;
  }
}

/**
 * Get multiple Twitch users by usernames
 * @param {string[]} usernames - Array of usernames
 * @returns {Promise<Array>} Array of user data
 */
async function getTwitchUsers(usernames) {
  const token = await getAccessToken();
  if (!token || usernames.length === 0) return [];

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
      const response = await axios.get(
        `https://api.twitch.tv/helix/users?${loginParams}`,
        {
          headers: {
            'Client-ID': process.env.TWITCH_CLIENT_ID,
            'Authorization': `Bearer ${token}`
          }
        }
      );
      if (response.data.data) {
        allUsers.push(...response.data.data);
      }
    } catch (error) {
      const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
      logger.error(`[Twitch Batch User Check Error]:`, { error: errorData, category: 'twitch' });
    }
  }
  return allUsers;
}

/**
 * Check if Twitch API is accessible
 * @returns {Promise<boolean>} True if API is accessible
 */
async function getApiStatus() {
  try {
    await getAccessToken();
    return true;
  } catch (error) {
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
