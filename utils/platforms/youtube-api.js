import axios from 'axios';
import logger from '../logger.js';

/**
 * Get YouTube channel ID from various identifier formats
 * @param {string} identifier - Channel ID, username, or handle
 * @returns {Promise<Object|null>} Object with channelId and channelName, or null if not found
 */
async function getYouTubeChannelId(identifier) {
  if (!process.env.YOUTUBE_API_KEY) {
    logger.error("[YouTube API Error] YOUTUBE_API_KEY is not set in the environment variables.");
    return null;
  }

  let searchIdentifier = identifier;
  if (identifier.startsWith('@')) {
    searchIdentifier = identifier.substring(1);
  }

  // If it's already a channel ID (starts with UC), return it
  if (identifier.startsWith('UC')) {
    return { channelId: identifier, channelName: null };
  }

  try {
    // Try searching for the channel
    const searchResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q: searchIdentifier,
        type: 'channel',
        maxResults: 1,
        key: process.env.YOUTUBE_API_KEY
      }
    });

    if (searchResponse.data.items?.[0]) {
      return {
        channelId: searchResponse.data.items[0].id.channelId,
        channelName: searchResponse.data.items[0].snippet.title
      };
    }

    // Try by username
    const channelResponse = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: {
        part: 'snippet',
        forUsername: searchIdentifier,
        key: process.env.YOUTUBE_API_KEY
      }
    });

    if (channelResponse.data.items?.[0]) {
      return {
        channelId: channelResponse.data.items[0].id,
        channelName: channelResponse.data.items[0].snippet.title
      };
    }

    logger.warn(`[YouTube API Check] Could not find a channel for identifier: "${identifier}"`);
    return null;
  } catch (error) {
    const errorMessage = error.response?.data?.error?.message || (error instanceof Error ? error.message : 'Unknown error');
    logger.error(`[YouTube API Check Error] for "${identifier}": ${errorMessage}`);
    return null;
  }
}

/**
 * Check if a YouTube channel is currently live
 * @param {string} channelId - YouTube channel ID
 * @returns {Promise<boolean>} True if live, false otherwise
 */
async function isStreamerLive(channelId) {
  try {
    logger.info(`[YouTube API] Checking if channel ${channelId} is live`);

    if (!process.env.YOUTUBE_API_KEY) {
      logger.error("[YouTube API Error] YOUTUBE_API_KEY is not set in the environment variables.");
      return false;
    }

    // Search for live broadcasts on this channel
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        channelId: channelId,
        eventType: 'live',
        type: 'video',
        key: process.env.YOUTUBE_API_KEY
      }
    });

    const isLive = response.data.items && response.data.items.length > 0;

    if (isLive) {
      logger.info(`[YouTube API] Channel ${channelId} is LIVE`);
    } else {
      logger.info(`[YouTube API] Channel ${channelId} is NOT live`);
    }

    return isLive;
  } catch (error) {
    logger.error(`[YouTube API] Error checking live status for ${channelId}:`, { error });
    return false;
  }
}

/**
 * Get stream details for a live YouTube channel
 * @param {string} channelId - YouTube channel ID
 * @returns {Promise<Object|null>} Stream details or null if offline/error
 */
async function getStreamDetails(channelId) {
  try {
    logger.info(`[YouTube API] Fetching stream details for channel ${channelId}`);

    if (!process.env.YOUTUBE_API_KEY) {
      logger.error("[YouTube API Error] YOUTUBE_API_KEY is not set in the environment variables.");
      return null;
    }

    // Search for live broadcasts
    const searchResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        channelId: channelId,
        eventType: 'live',
        type: 'video',
        maxResults: 1,
        key: process.env.YOUTUBE_API_KEY
      }
    });

    if (!searchResponse.data.items || searchResponse.data.items.length === 0) {
      logger.info(`[YouTube API] Channel ${channelId} is not live, no details available`);
      return null;
    }

    const liveVideo = searchResponse.data.items[0];

    // Get more detailed video info
    const videoResponse = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'snippet,liveStreamingDetails,statistics',
        id: liveVideo.id.videoId,
        key: process.env.YOUTUBE_API_KEY
      }
    });

    if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
      return null;
    }

    const videoDetails = videoResponse.data.items[0];
    const liveDetails = videoDetails.liveStreamingDetails;
    const snippet = videoDetails.snippet;

    return {
      title: snippet.title || 'Untitled Stream',
      game_name: snippet.categoryId || 'N/A',
      viewer_count: liveDetails?.concurrentViewers || 'N/A',
      thumbnail_url: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || null,
      started_at: liveDetails?.actualStartTime || null,
      video_id: liveVideo.id.videoId,
      url: `https://www.youtube.com/watch?v=${liveVideo.id.videoId}`
    };
  } catch (error) {
    logger.error(`[YouTube API] Failed to get stream details for ${channelId}:`, { error });
    return null;
  }
}

/**
 * Get the latest video from a YouTube channel
 * @param {string} channelId - YouTube channel ID
 * @returns {Promise<Object|null>} Latest video data or null if not found
 */
async function getLatestVideo(channelId) {
  try {
    logger.info(`[YouTube API] Fetching latest video for channel ${channelId}`);

    if (!process.env.YOUTUBE_API_KEY) {
      logger.error("[YouTube API Error] YOUTUBE_API_KEY is not set in the environment variables.");
      return null;
    }

    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        channelId: channelId,
        order: 'date',
        maxResults: 1,
        type: 'video',
        key: process.env.YOUTUBE_API_KEY
      }
    });

    const item = response.data.items?.[0];
    if (!item) {
      logger.info(`[YouTube API] No videos found for channel ${channelId}`);
      return null;
    }

    const video = {
      videoId: item.id.videoId,
      title: item.snippet.title,
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      thumbnailUrl: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || null,
      publishedAt: item.snippet.publishedAt,
      channelTitle: item.snippet.channelTitle
    };

    logger.info(`[YouTube API] Found latest video for channel ${channelId}: ${video.title}`);
    return video;
  } catch (error) {
    logger.error(`[YouTube API] Error fetching latest video for ${channelId}:`, { error: error.response?.data || error.message });
    return null;
  }
}

export { isStreamerLive, getStreamDetails, getLatestVideo, getYouTubeChannelId };
