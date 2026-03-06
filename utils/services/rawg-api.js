import axios from 'axios';
import logger from '../logger.js';

/**
 * RAWG Video Games Database API Service
 * API: https://rawg.io/apidocs
 * Free tier: No authentication required for basic use
 */
export default class RAWGAPIService {
  constructor() {
    this.baseUrl = 'https://api.rawg.io/api';
    // Using a demo key - in production, get your own free key at https://rawg.io/apidocs
    this.apiKey = process.env.RAWG_API_KEY || ''; // Free API, no key strictly required
    this.timeout = 10000;
  }

  /**
   * Search for games
   * @param {string} query - Search query
   * @param {number} pageSize - Number of results (max 40)
   * @returns {Promise<Array>} Array of game objects
   */
  async searchGames(query, pageSize = 5) {
    try {
      const params = {
        search: query,
        page_size: Math.min(pageSize, 40)
      };

      if (this.apiKey) {
        params.key = this.apiKey;
      }

      const response = await axios.get(`${this.baseUrl}/games`, {
        params,
        timeout: this.timeout
      });

      return response.data.results || [];
    } catch (error) {
      logger.error('[RAWG API] Error searching games', {
        error: error.message,
        query
      });
      throw new Error('Failed to search games');
    }
  }

  /**
   * Get detailed game information
   * @param {number} gameId - RAWG game ID
   * @returns {Promise<Object>} Game details
   */
  async getGameDetails(gameId) {
    try {
      const params = {};
      if (this.apiKey) {
        params.key = this.apiKey;
      }

      const response = await axios.get(`${this.baseUrl}/games/${gameId}`, {
        params,
        timeout: this.timeout
      });

      return response.data;
    } catch (error) {
      logger.error('[RAWG API] Error getting game details', {
        error: error.message,
        gameId
      });
      throw new Error('Failed to get game details');
    }
  }

  /**
   * Get game screenshots
   * @param {number} gameId - RAWG game ID
   * @returns {Promise<Array>} Array of screenshot objects
   */
  async getGameScreenshots(gameId) {
    try {
      const params = {};
      if (this.apiKey) {
        params.key = this.apiKey;
      }

      const response = await axios.get(`${this.baseUrl}/games/${gameId}/screenshots`, {
        params,
        timeout: this.timeout
      });

      return response.data.results || [];
    } catch (error) {
      logger.error('[RAWG API] Error getting screenshots', {
        error: error.message,
        gameId
      });
      return [];
    }
  }

  /**
   * Get upcoming game releases
   * @param {string} ordering - Sort order (e.g., 'released', '-released', '-added')
   * @returns {Promise<Array>} Array of game objects
   */
  async getUpcomingReleases(pageSize = 10) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const nextMonth = new Date();
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      const nextMonthStr = nextMonth.toISOString().split('T')[0];

      const params = {
        dates: `${today},${nextMonthStr}`,
        ordering: 'released',
        page_size: Math.min(pageSize, 40)
      };

      if (this.apiKey) {
        params.key = this.apiKey;
      }

      const response = await axios.get(`${this.baseUrl}/games`, {
        params,
        timeout: this.timeout
      });

      return response.data.results || [];
    } catch (error) {
      logger.error('[RAWG API] Error getting upcoming releases', {
        error: error.message
      });
      throw new Error('Failed to get upcoming releases');
    }
  }

  /**
   * Get recently released games
   * @param {number} pageSize - Number of results
   * @returns {Promise<Array>} Array of game objects
   */
  async getRecentReleases(pageSize = 10) {
    try {
      const lastMonth = new Date();
      lastMonth.setMonth(lastMonth.getMonth() - 1);
      const lastMonthStr = lastMonth.toISOString().split('T')[0];
      const today = new Date().toISOString().split('T')[0];

      const params = {
        dates: `${lastMonthStr},${today}`,
        ordering: '-released',
        page_size: Math.min(pageSize, 40)
      };

      if (this.apiKey) {
        params.key = this.apiKey;
      }

      const response = await axios.get(`${this.baseUrl}/games`, {
        params,
        timeout: this.timeout
      });

      return response.data.results || [];
    } catch (error) {
      logger.error('[RAWG API] Error getting recent releases', {
        error: error.message
      });
      throw new Error('Failed to get recent releases');
    }
  }

  /**
   * Get popular games
   * @param {number} pageSize - Number of results
   * @returns {Promise<Array>} Array of game objects
   */
  async getPopularGames(pageSize = 10) {
    try {
      const params = {
        ordering: '-rating',
        page_size: Math.min(pageSize, 40),
        metacritic: '80,100' // Only highly rated games
      };

      if (this.apiKey) {
        params.key = this.apiKey;
      }

      const response = await axios.get(`${this.baseUrl}/games`, {
        params,
        timeout: this.timeout
      });

      return response.data.results || [];
    } catch (error) {
      logger.error('[RAWG API] Error getting popular games', {
        error: error.message
      });
      throw new Error('Failed to get popular games');
    }
  }

  /**
   * Get games by genre
   * @param {string} genre - Genre slug (e.g., 'action', 'rpg', 'strategy')
   * @param {number} pageSize - Number of results
   * @returns {Promise<Array>} Array of game objects
   */
  async getGamesByGenre(genre, pageSize = 10) {
    try {
      const params = {
        genres: genre,
        ordering: '-rating',
        page_size: Math.min(pageSize, 40)
      };

      if (this.apiKey) {
        params.key = this.apiKey;
      }

      const response = await axios.get(`${this.baseUrl}/games`, {
        params,
        timeout: this.timeout
      });

      return response.data.results || [];
    } catch (error) {
      logger.error('[RAWG API] Error getting games by genre', {
        error: error.message,
        genre
      });
      throw new Error('Failed to get games by genre');
    }
  }

  /**
   * Format game data for Discord embed
   * @param {Object} game - Game object from RAWG API
   * @returns {Object} Formatted game data
   */
  formatGameData(game) {
    const platforms = game.platforms?.map(p => p.platform.name).join(', ') || 'Unknown';
    const genres = game.genres?.map(g => g.name).join(', ') || 'Unknown';
    const releaseDate = game.released || 'TBA';
    const rating = game.rating ? `${game.rating}/5` : 'No rating';
    const metacritic = game.metacritic ? `${game.metacritic}/100` : 'N/A';

    return {
      id: game.id,
      name: game.name,
      description: game.description_raw || game.description || 'No description available.',
      platforms,
      genres,
      releaseDate,
      rating,
      metacritic,
      image: game.background_image,
      website: game.website,
      rawgUrl: `https://rawg.io/games/${game.slug}`,
      playtime: game.playtime ? `${game.playtime} hours` : 'N/A',
      esrb: game.esrb_rating?.name || 'Not Rated'
    };
  }
}
