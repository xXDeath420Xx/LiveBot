import axios from 'axios';
import crypto from 'crypto';
import pool from '../db.js';
import logger from '../logger.js';

/**
 * Steam API Service
 * Handles all interactions with Steam APIs with caching and rate limiting
 */
export default class SteamAPIService {
  constructor() {
    this.apiKey = '559BDF91A19193518F40CD6CEB15C1DF';
    this.baseUrl = 'https://api.steampowered.com';
    this.storeUrl = 'https://store.steampowered.com/api';
    this.communityUrl = 'https://steamcommunity.com';
    this.requestDelay = 500; // Delay between requests in ms
    this.lastRequestTime = 0;
  }

  /**
   * Delay to respect rate limiting
   */
  async delay() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.requestDelay) {
      await new Promise(resolve => setTimeout(resolve, this.requestDelay - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Make a cached HTTP request
   * @param {string} url - Full URL to request
   * @param {string} cacheType - Type of cache
   * @param {string} steamId - Steam ID for caching
   * @param {number} cacheDurationMinutes - Cache duration in minutes
   */
  async cachedRequest(url, cacheType, steamId, cacheDurationMinutes = 30) {
    const cacheKey = crypto.createHash('md5').update(url).digest('hex');

    // Check cache first
    const [[cached]] = await pool.execute(
      'SELECT data, expires_at FROM steam_cache WHERE cache_key = ? AND expires_at > NOW()',
      [cacheKey]
    );

    if (cached) {
      logger.debug(`[SteamAPI] Cache hit for ${cacheType}:${steamId}`);
      return JSON.parse(cached.data);
    }

    // Make request with rate limiting
    await this.delay();
    logger.debug(`[SteamAPI] Fetching ${cacheType}:${steamId} from Steam`);

    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'CertiFried Utility Bot/2.0'
        }
      });

      const data = response.data;

      // Cache the response
      const expiresAt = new Date(Date.now() + cacheDurationMinutes * 60 * 1000);
      await pool.execute(
        `INSERT INTO steam_cache (cache_key, cache_type, steam_id, data, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data), expires_at = VALUES(expires_at), updated_at = NOW()`,
        [cacheKey, cacheType, steamId, JSON.stringify(data), expiresAt]
      );

      return data;
    } catch (error) {
      logger.error(`[SteamAPI] Error fetching ${cacheType}:${steamId}`, {
        error: error.message,
        url
      });
      return null;
    }
  }

  /**
   * Get app details from Steam Store API
   * @param {string} appId - Steam app ID
   * @param {string} currency - Currency code (default: USD)
   */
  async getAppDetails(appId, currency = 'us') {
    const url = `${this.storeUrl}/appdetails?appids=${appId}&cc=${currency}`;
    const data = await this.cachedRequest(url, 'app_details', appId, 60); // Cache for 1 hour

    if (!data || !data[appId] || !data[appId].success) {
      return null;
    }

    const appData = data[appId].data;

    // Update or insert into steam_apps table
    try {
      const genres = appData.genres ? JSON.stringify(appData.genres.map(g => g.description)) : null;
      const categories = appData.categories ? JSON.stringify(appData.categories.map(c => c.description)) : null;
      const releaseDate = appData.release_date && !appData.release_date.coming_soon
        ? new Date(appData.release_date.date)
        : null;

      await pool.execute(
        `INSERT INTO steam_apps (
          app_id, name, type, is_free, header_image, short_description,
          genres, categories, release_date, last_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          type = VALUES(type),
          is_free = VALUES(is_free),
          header_image = VALUES(header_image),
          short_description = VALUES(short_description),
          genres = VALUES(genres),
          categories = VALUES(categories),
          release_date = VALUES(release_date),
          last_updated_at = NOW()`,
        [
          appId,
          appData.name,
          appData.type,
          appData.is_free,
          appData.header_image,
          appData.short_description,
          genres,
          categories,
          releaseDate
        ]
      );
    } catch (error) {
      logger.error('[SteamAPI] Error updating steam_apps', { error: error.message });
    }

    return appData;
  }

  /**
   * Get news for an app
   * @param {string} appId - Steam app ID
   * @param {number} count - Number of news items to fetch
   */
  async getAppNews(appId, count = 5) {
    const url = `${this.baseUrl}/ISteamNews/GetNewsForApp/v0002/?appid=${appId}&count=${count}&maxlength=0&format=json`;
    const data = await this.cachedRequest(url, 'app_news', appId, 15); // Cache for 15 minutes

    if (!data || !data.appnews || !data.appnews.newsitems) {
      return [];
    }

    return data.appnews.newsitems;
  }

  /**
   * Get price information for an app
   * @param {string} appId - Steam app ID
   * @param {string} currency - Currency code
   */
  async getAppPrice(appId, currency = 'us') {
    const appDetails = await this.getAppDetails(appId, currency);

    if (!appDetails || !appDetails.price_overview) {
      // Free app or no price data
      return {
        is_free: appDetails?.is_free || false,
        currency: currency.toUpperCase(),
        initial: 0,
        final: 0,
        discount_percent: 0
      };
    }

    const price = appDetails.price_overview;

    // Record price history
    try {
      await pool.execute(
        `INSERT INTO steam_price_history (app_id, currency, price_cents, discount_percent, final_price_cents)
         VALUES (?, ?, ?, ?, ?)`,
        [
          appId,
          price.currency,
          price.initial,
          price.discount_percent,
          price.final
        ]
      );
    } catch (error) {
      // Ignore duplicate entries
    }

    return {
      is_free: false,
      currency: price.currency,
      initial: price.initial,
      final: price.final,
      discount_percent: price.discount_percent,
      formatted: price.final_formatted || `${(price.final / 100).toFixed(2)}`
    };
  }

  /**
   * Get workshop items for an app
   * @param {string} appId - Steam app ID
   * @param {number} page - Page number
   * @param {number} numPerPage - Items per page
   */
  async getWorkshopItems(appId, page = 1, numPerPage = 10) {
    // Use ISteamRemoteStorage/GetPublishedFileDetails for authenticated workshop access
    const url = `${this.baseUrl}/IPublishedFileService/QueryFiles/v1/?key=${this.apiKey}&query_type=1&page=${page}&numperpage=${numPerPage}&creator_appid=${appId}&appid=${appId}&requiredtags=&excludedtags=&match_all_tags=true&required_flags=&omitted_flags=&search_text=&filetype=0&child_publishedfileid=&days=7&include_recent_votes_only=false&cache_max_age_seconds=0&language=0&required_kv_tags={}`;

    try {
      const data = await this.cachedRequest(url, 'workshop', appId, 15);

      if (!data || !data.response || !data.response.publishedfiledetails) {
        return [];
      }

      return data.response.publishedfiledetails.map(item => ({
        publishedfileid: item.publishedfileid,
        title: item.title,
        creator: item.creator,
        time_created: item.time_created,
        time_updated: item.time_updated,
        preview_url: item.preview_url,
        views: item.views,
        subscriptions: item.subscriptions,
        favorited: item.favorited,
        tags: item.tags || []
      }));
    } catch (error) {
      logger.error(`[SteamAPI] Error fetching workshop items for ${appId}`, {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Get free promotions from Steam
   */
  async getFreePromotions() {
    const url = `${this.storeUrl}/featuredcategories`;
    const data = await this.cachedRequest(url, 'free_promotions', 'featured', 30);

    if (!data) {
      return [];
    }

    const freeItems = [];

    // Check for free weekend games
    if (data.free_weekend && data.free_weekend.items) {
      for (const item of data.free_weekend.items) {
        freeItems.push({
          app_id: item.id,
          name: item.name,
          type: 'free_weekend',
          discount_percent: item.discount_percent,
          header_image: item.header_image
        });
      }
    }

    return freeItems;
  }

  /**
   * Search for Steam apps
   * @param {string} query - Search query
   * @param {number} limit - Max results
   */
  async searchApps(query, limit = 10) {
    const url = `${this.storeUrl}/storesearch/?term=${encodeURIComponent(query)}&l=english&cc=us`;
    const data = await this.cachedRequest(url, 'app_details', `search_${query}`, 60);

    if (!data || !data.items) {
      return [];
    }

    return data.items.slice(0, limit).map(item => ({
      app_id: item.id,
      name: item.name,
      type: item.type,
      tiny_image: item.tiny_image,
      price: item.price ? {
        currency: item.price.currency,
        initial: item.price.initial,
        final: item.price.final,
        discount_percent: item.price.discount_percent
      } : null
    }));
  }

  /**
   * Get Valve news (Steam blog/announcements)
   */
  async getValveNews(count = 5) {
    // Valve's app ID is 593110 (Steam)
    return await this.getAppNews('593110', count);
  }

  /**
   * Check if an app has price changes
   * @param {string} appId - Steam app ID
   * @param {string} currency - Currency code
   */
  async checkPriceChanges(appId, currency) {
    const currentPrice = await this.getAppPrice(appId, currency);

    // Get last recorded price
    const [[lastPrice]] = await pool.execute(
      `SELECT price_cents, discount_percent, final_price_cents
       FROM steam_price_history
       WHERE app_id = ? AND currency = ?
       ORDER BY recorded_at DESC
       LIMIT 1 OFFSET 1`,
      [appId, currency]
    );

    if (!lastPrice) {
      // No price history, this is the first check
      return { hasChanged: false, current: currentPrice, previous: null };
    }

    const hasChanged = (
      currentPrice.final !== lastPrice.final_price_cents ||
      currentPrice.discount_percent !== lastPrice.discount_percent
    );

    return {
      hasChanged,
      current: currentPrice,
      previous: {
        initial: lastPrice.price_cents,
        final: lastPrice.final_price_cents,
        discount_percent: lastPrice.discount_percent
      }
    };
  }

  /**
   * Get latest news item for an app (for checking updates)
   * @param {string} appId - Steam app ID
   */
  async getLatestNews(appId) {
    const news = await this.getAppNews(appId, 1);
    return news.length > 0 ? news[0] : null;
  }
}
