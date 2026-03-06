import axios from 'axios';
import logger from '../logger.js';
import pool from '../db.js';

/**
 * Get Kick user/channel data
 * @param {string} username - Kick username
 * @returns {Promise<Object|null>} Channel data or null if not found/error
 */
async function getKickUser(username) {
  if (typeof username !== 'string' || !username) return null;

  logger.info(`[Kick API] getKickUser started for: ${username}`);
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 5000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const requestUrl = `https://kick.com/api/v1/channels/${username}`;
      logger.info(`[Kick API] Requesting ${requestUrl} (Attempt ${attempt})`);

      // Use axios with custom headers to mimic browser request
      const response = await axios.get(requestUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://kick.com/',
        },
        timeout: 30000
      });

      if (response.status === 200 && response.data) {
        const data = response.data;
        if (!data || !data.user) {
          logger.info(`[Kick API] No 'user' object in response for '${username}', assuming non-existent.`);
          return null;
        }
        logger.info(`[Kick API] Successfully retrieved Kick user data for ${username}.`, {
          hasChatroom: !!data.chatroom,
          chatroomId: data.chatroom?.id || 'none'
        });

        // Auto-update chatroom_id in database if we have it
        if (data.chatroom?.id) {
          updateChatroomId(username, data.chatroom.id);
        }

        return data;
      }

      logger.warn(`[Kick API] Received status ${response.status} for ${username}. Retrying in ${RETRY_DELAY / 1000}s...`);

    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        logger.warn(`[Kick API] Received 404 for ${username}, user likely does not exist. Not retrying.`);
        return null;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Kick API Check Error] for "${username}" on attempt ${attempt}: ${errorMessage}`);
    }

    if (attempt < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }

  logger.error(`[Kick API] All retries failed for ${username}.`);
  return null;
}

/**
 * Check if a Kick streamer is currently live
 * @param {string} username - Kick username
 * @returns {Promise<boolean>} True if live, false otherwise
 */
async function isStreamerLive(username) {
  try {
    const user = await getKickUser(username);
    return user?.livestream?.is_live || false;
  } catch (error) {
    logger.error(`[Kick API] Error checking live status for ${username}:`, { error });
    return false;
  }
}

/**
 * Get stream details for a Kick streamer
 * @param {string} username - Kick username
 * @returns {Promise<Object|null>} Stream details or null if offline/error
 */
async function getStreamDetails(username) {
  try {
    const user = await getKickUser(username);
    if (!user || !user.livestream || !user.livestream.is_live) {
      return null;
    }

    return {
      title: user.livestream.session_title,
      game_name: user.livestream.categories?.[0]?.name || 'Not Set',
      viewer_count: user.livestream.viewer_count || 0,
      thumbnail_url: user.livestream.thumbnail?.url || null,
      started_at: user.livestream.created_at || null, // Kick uses created_at for stream start time
    };
  } catch (error) {
    logger.error(`[Kick API] Failed to get stream details for ${username}:`, { error });
    return null;
  }
}

/**
 * Update chatroom_id in database for a Kick channel
 * Called automatically when channel data is fetched
 */
async function updateChatroomId(channelName, chatroomId) {
  try {
    const [result] = await pool.execute(
      `UPDATE tokes_channels SET chatroom_id = ? WHERE platform = 'kick' AND LOWER(channel_name) = LOWER(?) AND chatroom_id IS NULL`,
      [chatroomId.toString(), channelName]
    );
    if (result.affectedRows > 0) {
      logger.info(`[Kick API] Updated chatroom_id for ${channelName}: ${chatroomId}`);
    }
  } catch (error) {
    logger.warn(`[Kick API] Failed to update chatroom_id for ${channelName}:`, { error: error.message });
  }
}

export { getKickUser, isStreamerLive, getStreamDetails };
