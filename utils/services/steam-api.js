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
    this.baseUrl = 'https://api.steampowered.com';
    this.storeUrl = 'https://store.steampowered.com/api';
    this.communityUrl = 'https://steamcommunity.com';
    this.requestDelay = 500; // Delay between requests in ms
    this.lastRequestTime = 0;
  }

  // Read at call time, not construction: commands build this service at import, which ESM
  // hoists above dotenv.config().
  get apiKey() {
    return process.env.STEAM_API_KEY || '';
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
        url: url.replace(/key=[^&]+/, 'key=REDACTED')
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
   * @param {string[]} [feeds] - Restrict to these Steam feed names, e.g.
   *   ['steam_community_announcements'] for developer posts only. Filtering here rather than
   *   on the result matters: `count` is applied by Steam *before* any filtering, so for a game
   *   whose recent news is mostly third-party press (Baldur's Gate 3, Cyberpunk 2077, Destiny 2,
   *   Stardew Valley all are) a post-filter on count=10 returns nothing at all.
   */
  async getAppNews(appId, count = 5, feeds = null) {
    const feedParam = feeds?.length ? `&feeds=${encodeURIComponent(feeds.join(','))}` : '';
    const url = `${this.baseUrl}/ISteamNews/GetNewsForApp/v0002/?appid=${appId}&count=${count}&maxlength=0&format=json${feedParam}`;
    // cachedRequest keys on md5(url), so the feed filter gets its own cache entry.
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
   * Get workshop items for an app (IPublishedFileService/QueryFiles — needs STEAM_API_KEY).
   *
   * @param {string} appId - Steam app ID
   * @param {object|number} [options] - { sort: 'newest'|'updated', count (1-100), page, cacheMinutes }.
   *   The old positional form getWorkshopItems(appId, page, numPerPage) still works.
   * @param {number} [numPerPage] - legacy positional page size
   * @returns {Promise<Array>} items with numeric time_created / time_updated (unix seconds)
   */
  async getWorkshopItems(appId, options = {}, numPerPage = 10) {
    const opts = (options && typeof options === 'object') ? options : { page: options, count: numPerPage };
    const sort = opts.sort === 'updated' ? 'updated' : 'newest';
    const count = Math.max(1, Math.min(100, Number(opts.count) || 20));
    const page = Math.max(1, Number(opts.page) || 1);

    if (!this.apiKey) {
      logger.warn('[SteamAPI] STEAM_API_KEY is not set — workshop queries are unavailable');
      return [];
    }

    // query_type: 1 = ranked by publication date, 21 = ranked by last updated date
    const params = new URLSearchParams({
      key: this.apiKey,
      query_type: sort === 'updated' ? '21' : '1',
      page: String(page),
      numperpage: String(count),
      appid: String(appId),
      return_tags: 'true',
      return_short_description: 'true',
    });
    const url = `${this.baseUrl}/IPublishedFileService/QueryFiles/v1/?${params.toString()}`;

    try {
      // Short cache: shared by every guild watching the same app, but fresher than the poll interval.
      const data = await this.cachedRequest(url, 'workshop', String(appId), Number(opts.cacheMinutes) || 4);

      if (!data || !data.response || !Array.isArray(data.response.publishedfiledetails)) {
        return [];
      }

      return data.response.publishedfiledetails
        .filter(item => item && Number(item.result) === 1 && item.publishedfileid)
        .map(item => ({
          publishedfileid: String(item.publishedfileid),
          title: item.title || 'Untitled',
          short_description: item.short_description || item.file_description || '',
          creator: item.creator ? String(item.creator) : null,
          creator_appid: item.creator_appid != null ? String(item.creator_appid) : null,
          app_name: item.app_name || null,
          time_created: Number(item.time_created) || 0,
          time_updated: Number(item.time_updated) || Number(item.time_created) || 0,
          preview_url: item.preview_url || null,
          file_size: item.file_size != null ? Number(item.file_size) : null,
          views: Number(item.views) || 0,
          subscriptions: Number(item.subscriptions) || 0,
          favorited: Number(item.favorited) || 0,
          tags: (item.tags || []).map(t => (typeof t === 'string' ? t : (t.display_name || t.tag))).filter(Boolean),
          banned: !!item.banned,
          maybe_inappropriate_sex: !!item.maybe_inappropriate_sex,
          maybe_inappropriate_violence: !!item.maybe_inappropriate_violence,
        }));
    } catch (error) {
      logger.error(`[SteamAPI] Error fetching workshop items for ${appId}`, {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Upsert workshop items into steam_workshop_items (the local cache the watcher posts from).
   * @param {string} appId
   * @param {Array} items - from getWorkshopItems()
   */
  async cacheWorkshopItems(appId, items) {
    for (const item of items) {
      try {
        await pool.execute(
          `INSERT INTO steam_workshop_items (
             publishedfileid, app_id, title, creator_steamid, creator_appid, short_description,
             time_created, time_updated, preview_url, file_size, views, subscriptions, favorites, tags
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             title = VALUES(title), creator_steamid = VALUES(creator_steamid),
             short_description = VALUES(short_description), time_updated = VALUES(time_updated),
             preview_url = VALUES(preview_url), file_size = VALUES(file_size), views = VALUES(views),
             subscriptions = VALUES(subscriptions), favorites = VALUES(favorites), tags = VALUES(tags)`,
          [
            item.publishedfileid,
            String(appId),
            String(item.title || '').slice(0, 500),
            item.creator,
            item.creator_appid,
            item.short_description ? String(item.short_description).slice(0, 2000) : null,
            item.time_created ? new Date(item.time_created * 1000) : null,
            item.time_updated ? new Date(item.time_updated * 1000) : null,
            item.preview_url ? String(item.preview_url).slice(0, 500) : null,
            Number.isFinite(item.file_size) ? item.file_size : null,
            Math.min(2147483647, item.views || 0),
            Math.min(2147483647, item.subscriptions || 0),
            Math.min(2147483647, item.favorited || 0),
            JSON.stringify(item.tags || []),
          ]
        );
      } catch (error) {
        logger.error('[SteamAPI] Error caching workshop item', {
          appId, publishedfileid: item.publishedfileid, error: error.message
        });
      }
    }
  }

  /**
   * Resolve Steam persona names for SteamID64s (ISteamUser/GetPlayerSummaries, up to 100 per call).
   * Names already cached in steam_workshop_items are reused; new ones are written back there.
   * @param {string[]} steamIds
   * @returns {Promise<Map<string,string>>} steamid -> persona name (missing ids are omitted)
   */
  async getPlayerNames(steamIds) {
    const ids = [...new Set((steamIds || []).filter(id => /^\d{17}$/.test(String(id))).map(String))];
    const names = new Map();
    if (!ids.length) return names;

    try {
      const [rows] = await pool.query(
        `SELECT creator_steamid, MAX(creator_name) AS creator_name FROM steam_workshop_items
          WHERE creator_steamid IN (?) AND creator_name IS NOT NULL GROUP BY creator_steamid`,
        [ids]
      );
      for (const r of rows) names.set(String(r.creator_steamid), r.creator_name);
    } catch (error) {
      logger.warn('[SteamAPI] Could not read cached workshop creator names', { error: error.message });
    }

    const missing = ids.filter(id => !names.has(id));
    if (!missing.length || !this.apiKey) return names;

    try {
      await this.delay();
      const response = await axios.get(`${this.baseUrl}/ISteamUser/GetPlayerSummaries/v2/`, {
        params: { key: this.apiKey, steamids: missing.slice(0, 100).join(',') },
        timeout: 10000,
        headers: { 'User-Agent': 'CertiFried Utility Bot/2.0' }
      });
      for (const p of response.data?.response?.players || []) {
        if (p?.steamid && p.personaname) names.set(String(p.steamid), String(p.personaname).slice(0, 255));
      }
      for (const id of missing) {
        if (!names.has(id)) continue;
        await pool.execute(
          'UPDATE steam_workshop_items SET creator_name = ? WHERE creator_steamid = ?',
          [names.get(id), id]
        ).catch(error => logger.warn('[SteamAPI] Could not cache workshop creator name', { steamId: id, error: error.message }));
      }
    } catch (error) {
      logger.warn('[SteamAPI] GetPlayerSummaries failed', { error: error.message });
    }
    return names;
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
   * Get latest OFFICIAL news item for an app — skips third-party syndicated posts
   * (PC Gamer, VG247, Gamemag.ru etc.) which Steam mixes in via /externalpost/.
   * Returns the first item where is_external_url=false OR feedname is the canonical
   * "steam_community_announcements". Falls back to null if none found in top 25.
   * @param {string} appId - Steam app ID
   */
  async getLatestNews(appId) {
    const news = await this.getAppNews(appId, 25);
    if (!news.length) return null;
    const official = news.find(n =>
      n.is_external_url === false ||
      n.feedname === 'steam_community_announcements'
    );
    return official || null;
  }
}
