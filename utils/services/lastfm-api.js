import axios from 'axios';
import logger from '../logger.js';

/**
 * Last.fm API Service
 * API: https://www.last.fm/api
 * Free tier: API key required (free for non-commercial use)
 */
export default class LastFMAPIService {
  constructor() {
    this.baseUrl = 'https://ws.audioscrobbler.com/2.0/';
    // Get free API key at: https://www.last.fm/api/account/create
    this.apiKey = process.env.LASTFM_API_KEY || '';
    this.timeout = 10000;
  }

  /**
   * Get user's recent tracks
   * @param {string} username - Last.fm username
   * @param {number} limit - Number of tracks to return
   * @returns {Promise<Array>} Array of recent tracks
   */
  async getRecentTracks(username, limit = 10) {
    if (!this.apiKey) {
      throw new Error('Last.fm API key not configured');
    }

    try {
      const response = await axios.get(this.baseUrl, {
        params: {
          method: 'user.getrecenttracks',
          user: username,
          api_key: this.apiKey,
          format: 'json',
          limit
        },
        timeout: this.timeout
      });

      return response.data.recenttracks?.track || [];
    } catch (error) {
      logger.error('[Last.fm API] Error getting recent tracks', {
        error: error.message,
        username
      });
      throw new Error('Failed to get recent tracks');
    }
  }

  /**
   * Get user's top artists
   * @param {string} username - Last.fm username
   * @param {string} period - Time period (overall, 7day, 1month, 3month, 6month, 12month)
   * @param {number} limit - Number of artists to return
   * @returns {Promise<Array>} Array of top artists
   */
  async getTopArtists(username, period = '7day', limit = 10) {
    if (!this.apiKey) {
      throw new Error('Last.fm API key not configured');
    }

    try {
      const response = await axios.get(this.baseUrl, {
        params: {
          method: 'user.gettopartists',
          user: username,
          api_key: this.apiKey,
          format: 'json',
          period,
          limit
        },
        timeout: this.timeout
      });

      return response.data.topartists?.artist || [];
    } catch (error) {
      logger.error('[Last.fm API] Error getting top artists', {
        error: error.message,
        username
      });
      throw new Error('Failed to get top artists');
    }
  }

  /**
   * Get user's top tracks
   * @param {string} username - Last.fm username
   * @param {string} period - Time period (overall, 7day, 1month, 3month, 6month, 12month)
   * @param {number} limit - Number of tracks to return
   * @returns {Promise<Array>} Array of top tracks
   */
  async getTopTracks(username, period = '7day', limit = 10) {
    if (!this.apiKey) {
      throw new Error('Last.fm API key not configured');
    }

    try {
      const response = await axios.get(this.baseUrl, {
        params: {
          method: 'user.gettoptracks',
          user: username,
          api_key: this.apiKey,
          format: 'json',
          period,
          limit
        },
        timeout: this.timeout
      });

      return response.data.toptracks?.track || [];
    } catch (error) {
      logger.error('[Last.fm API] Error getting top tracks', {
        error: error.message,
        username
      });
      throw new Error('Failed to get top tracks');
    }
  }

  /**
   * Get user's top albums
   * @param {string} username - Last.fm username
   * @param {string} period - Time period (overall, 7day, 1month, 3month, 6month, 12month)
   * @param {number} limit - Number of albums to return
   * @returns {Promise<Array>} Array of top albums
   */
  async getTopAlbums(username, period = '7day', limit = 10) {
    if (!this.apiKey) {
      throw new Error('Last.fm API key not configured');
    }

    try {
      const response = await axios.get(this.baseUrl, {
        params: {
          method: 'user.gettopalbums',
          user: username,
          api_key: this.apiKey,
          format: 'json',
          period,
          limit
        },
        timeout: this.timeout
      });

      return response.data.topalbums?.album || [];
    } catch (error) {
      logger.error('[Last.fm API] Error getting top albums', {
        error: error.message,
        username
      });
      throw new Error('Failed to get top albums');
    }
  }

  /**
   * Get user profile information
   * @param {string} username - Last.fm username
   * @returns {Promise<Object>} User profile data
   */
  async getUserInfo(username) {
    if (!this.apiKey) {
      throw new Error('Last.fm API key not configured');
    }

    try {
      const response = await axios.get(this.baseUrl, {
        params: {
          method: 'user.getinfo',
          user: username,
          api_key: this.apiKey,
          format: 'json'
        },
        timeout: this.timeout
      });

      return response.data.user;
    } catch (error) {
      logger.error('[Last.fm API] Error getting user info', {
        error: error.message,
        username
      });
      throw new Error('Failed to get user information');
    }
  }

  /**
   * Compare music taste between two users
   * @param {string} user1 - First Last.fm username
   * @param {string} user2 - Second Last.fm username
   * @returns {Promise<Object>} Comparison data
   */
  async compareUsers(user1, user2) {
    if (!this.apiKey) {
      throw new Error('Last.fm API key not configured');
    }

    try {
      const response = await axios.get(this.baseUrl, {
        params: {
          method: 'tasteometer.compare',
          type1: 'user',
          type2: 'user',
          value1: user1,
          value2: user2,
          api_key: this.apiKey,
          format: 'json'
        },
        timeout: this.timeout
      });

      return response.data.comparison;
    } catch (error) {
      logger.error('[Last.fm API] Error comparing users', {
        error: error.message,
        user1,
        user2
      });
      throw new Error('Failed to compare users');
    }
  }

  /**
   * Get artist information
   * @param {string} artist - Artist name
   * @returns {Promise<Object>} Artist information
   */
  async getArtistInfo(artist) {
    if (!this.apiKey) {
      throw new Error('Last.fm API key not configured');
    }

    try {
      const response = await axios.get(this.baseUrl, {
        params: {
          method: 'artist.getinfo',
          artist,
          api_key: this.apiKey,
          format: 'json'
        },
        timeout: this.timeout
      });

      return response.data.artist;
    } catch (error) {
      logger.error('[Last.fm API] Error getting artist info', {
        error: error.message,
        artist
      });
      throw new Error('Failed to get artist information');
    }
  }

  /**
   * Get track information
   * @param {string} artist - Artist name
   * @param {string} track - Track name
   * @returns {Promise<Object>} Track information
   */
  async getTrackInfo(artist, track) {
    if (!this.apiKey) {
      throw new Error('Last.fm API key not configured');
    }

    try {
      const response = await axios.get(this.baseUrl, {
        params: {
          method: 'track.getinfo',
          artist,
          track,
          api_key: this.apiKey,
          format: 'json'
        },
        timeout: this.timeout
      });

      return response.data.track;
    } catch (error) {
      logger.error('[Last.fm API] Error getting track info', {
        error: error.message,
        artist,
        track
      });
      throw new Error('Failed to get track information');
    }
  }

  /**
   * Format user data for Discord embed
   * @param {Object} user - User object from Last.fm API
   * @returns {Object} Formatted user data
   */
  formatUserData(user) {
    const playcount = user.playcount?.toLocaleString() || '0';
    const registered = user.registered?.unixtime
      ? new Date(user.registered.unixtime * 1000).toLocaleDateString()
      : 'Unknown';

    return {
      username: user.name,
      realname: user.realname || user.name,
      url: user.url,
      playcount,
      registered,
      country: user.country || 'Unknown',
      avatar: user.image?.find(i => i.size === 'large')?.['#text'] || null
    };
  }

  /**
   * Format now playing track
   * @param {Object} track - Track object from Last.fm API
   * @returns {string} Formatted now playing string
   */
  formatNowPlaying(track) {
    const artist = track.artist?.['#text'] || track.artist?.name || 'Unknown Artist';
    const name = track.name || 'Unknown Track';
    const album = track.album?.['#text'] || 'Unknown Album';

    return `**${name}** by ${artist}\nAlbum: ${album}`;
  }

  /**
   * Get period display name
   * @param {string} period - Period code
   * @returns {string} Display name
   */
  getPeriodDisplayName(period) {
    const periods = {
      '7day': 'Last 7 Days',
      '1month': 'Last Month',
      '3month': 'Last 3 Months',
      '6month': 'Last 6 Months',
      '12month': 'Last Year',
      'overall': 'All Time'
    };

    return periods[period] || period;
  }
}
