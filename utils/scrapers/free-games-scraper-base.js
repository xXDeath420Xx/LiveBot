import logger from '../logger.js';

// Global cache for scraper results (shared across all instances)
const scraperCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

/**
 * Base class for free games scrapers
 * Each platform scraper extends this class
 */
export default class FreeGamesScraper {
  constructor(platform) {
    this.platform = platform;
    this.requestTimeout = 5000; // 5 second timeout for fast responses
  }

  /**
   * Fetch free games from the platform
   * Must be implemented by each scraper
   * @returns {Promise<Array<Object>>} Array of game objects
   */
  async fetchFreeGames() {
    throw new Error(`fetchFreeGames() must be implemented by ${this.platform} scraper`);
  }

  /**
   * Get cached results or fetch new ones
   * @returns {Promise<Array<Object>>} Cached or fresh game data
   */
  async getCachedOrFetch() {
    const cacheKey = this.platform;
    const cached = scraperCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      this.log('debug', `Using cached results (${Math.round((Date.now() - cached.timestamp) / 1000)}s old)`);
      return cached.data;
    }

    // Fetch fresh data
    const data = await this.fetchFreeGames();

    // Cache the results
    scraperCache.set(cacheKey, {
      data,
      timestamp: Date.now()
    });

    return data;
  }

  /**
   * Clear the cache for this platform
   */
  clearCache() {
    scraperCache.delete(this.platform);
    this.log('debug', 'Cache cleared');
  }

  /**
   * Clear all platform caches
   */
  static clearAllCaches() {
    scraperCache.clear();
    logger.debug('[FreeGamesScraper] All caches cleared');
  }

  /**
   * Normalize a game object to our standard format
   * @param {Object} rawGame - Raw game data from platform
   * @returns {Object} Normalized game object
   */
  normalizeGame(rawGame) {
    // Parse price - strip currency symbols and parse as float
    let price = rawGame.original_price || 0;
    if (typeof price === 'string') {
      price = parseFloat(price.replace(/[^0-9.]/g, '')) || 0;
    }

    return {
      external_id: rawGame.id || rawGame.external_id,
      title: rawGame.title || rawGame.name,
      description: rawGame.description || '',
      store: this.platform,
      kind: rawGame.kind || 'game',
      platform_windows: rawGame.platforms?.windows ?? true,
      platform_mac: rawGame.platforms?.mac ?? false,
      platform_linux: rawGame.platforms?.linux ?? false,
      platform_android: rawGame.platforms?.android ?? false,
      platform_ios: rawGame.platforms?.ios ?? false,
      platform_xbox: rawGame.platforms?.xbox ?? false,
      platform_playstation: rawGame.platforms?.playstation ?? false,
      url: rawGame.url || rawGame.link,
      thumbnail_url: rawGame.thumbnail || rawGame.image,
      org_price_usd: price,
      until_date: rawGame.until ? new Date(rawGame.until) : null,
      is_free_to_keep: rawGame.free_to_keep ?? true,
      is_dlc: rawGame.is_dlc ?? false,
      rating_score: rawGame.rating || null
    };
  }

  /**
   * Make an HTTP request with error handling and timeout
   * @param {string} url - URL to fetch
   * @param {Object} options - Fetch options
   * @returns {Promise<Object>} Response data
   */
  async makeRequest(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeout);

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'CertiFriedUtility-FreeGamesBot/1.0',
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          ...options.headers
        },
        signal: controller.signal,
        ...options
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      }

      return await response.text();
    } catch (error) {
      clearTimeout(timeout);

      if (error.name === 'AbortError') {
        logger.warn(`[${this.platform}Scraper] Request timed out after ${this.requestTimeout}ms:`, { url });
        throw new Error(`Request timed out after ${this.requestTimeout}ms`);
      }

      logger.error(`[${this.platform}Scraper] Request failed:`, {
        url,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Log scraper activity
   * @param {string} level - Log level (info, warn, error)
   * @param {string} message - Log message
   * @param {Object} meta - Additional metadata
   */
  log(level, message, meta = {}) {
    logger[level](`[${this.platform}Scraper] ${message}`, meta);
  }
}
