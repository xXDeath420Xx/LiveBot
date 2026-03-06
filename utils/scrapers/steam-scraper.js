import FreeGamesScraper from './free-games-scraper-base.js';

/**
 * Scraper for Steam free games
 * Checks Steam store for free-to-play games and free weekends
 */
export default class SteamScraper extends FreeGamesScraper {
  constructor() {
    super('steam');
    this.storeApiUrl = 'https://store.steampowered.com/api';
    this.searchUrl = 'https://store.steampowered.com/search/results/';
  }

  /**
   * Fetch currently free games from Steam
   * @returns {Promise<Array<Object>>} Array of normalized game objects
   */
  async fetchFreeGames() {
    try {
      this.log('info', 'Fetching free games from Steam');

      const freeGames = [];
      const seenAppIds = new Set();

      // Primary method: Search for games with 100% discount (free specials)
      const searchResults = await this.searchFreeSpecials();
      for (const game of searchResults) {
        if (!seenAppIds.has(game.external_id)) {
          seenAppIds.add(game.external_id);
          freeGames.push(game);
        }
      }

      // Secondary method: Check featured games for any we might have missed
      const featuredGames = await this.fetchFeaturedGames();
      for (const game of featuredGames) {
        if (!seenAppIds.has(game.external_id)) {
          seenAppIds.add(game.external_id);
          freeGames.push(game);
        }
      }

      this.log('info', `Found ${freeGames.length} free game(s) on Steam`);
      return freeGames;

    } catch (error) {
      this.log('error', 'Failed to fetch free games', {
        error: error.message,
        stack: error.stack
      });
      return [];
    }
  }

  /**
   * Search Steam for games currently on 100% discount (free specials)
   * This catches limited-time free games that may not appear in featured
   * @returns {Promise<Array<Object>>}
   */
  async searchFreeSpecials() {
    try {
      const params = new URLSearchParams({
        query: '',
        start: '0',
        count: '50',
        maxprice: 'free',
        specials: '1',
        infinite: '1'
      });

      const url = `${this.searchUrl}?${params}`;
      const response = await this.makeRequest(url);

      if (!response || !response.results_html) {
        this.log('warn', 'No results from Steam search API');
        return [];
      }

      // Extract app IDs from the HTML response
      const appIdRegex = /data-ds-appid="(\d+)"/g;
      const appIds = [];
      let match;

      while ((match = appIdRegex.exec(response.results_html)) !== null) {
        appIds.push(parseInt(match[1], 10));
      }

      this.log('info', `Found ${appIds.length} free special(s) from Steam search`);

      const freeGames = [];
      for (const appId of appIds) {
        const details = await this.fetchGameDetails(appId);
        if (details) {
          freeGames.push(details);
        }
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      return freeGames;

    } catch (error) {
      this.log('warn', 'Failed to search free specials', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Fetch featured games and filter for free ones
   * @returns {Promise<Array<Object>>}
   */
  async fetchFeaturedGames() {
    try {
      const url = `${this.storeApiUrl}/featured`;
      const data = await this.makeRequest(url);

      if (!data || !data.large_capsules) {
        return [];
      }

      const freeGames = [];

      // Check large capsules for free games
      for (const game of data.large_capsules || []) {
        if (game.discount_percent === 100 || game.final_price === 0) {
          const details = await this.fetchGameDetails(game.id);
          if (details) {
            freeGames.push(details);
          }
          // Add delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      return freeGames;

    } catch (error) {
      this.log('warn', 'Failed to fetch featured games', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Fetch detailed information about a specific game
   * @param {number} appId - Steam app ID
   * @returns {Promise<Object|null>}
   */
  async fetchGameDetails(appId) {
    try {
      const url = `${this.storeApiUrl}/appdetails?appids=${appId}`;
      const data = await this.makeRequest(url);

      if (!data || !data[appId] || !data[appId].success) {
        return null;
      }

      const gameData = data[appId].data;

      const priceInfo = gameData.price_overview;

      // Check if this is a limited-time free offer (100% discount on a paid game)
      if (priceInfo && priceInfo.discount_percent === 100 && priceInfo.initial > 0) {
        // This is a paid game that's temporarily free - include it!
        this.log('info', `Found free game: ${gameData.name} (100% off)`);
        return this.normalizeSteamGame(gameData);
      }

      // Skip permanently free-to-play games (no price info or always free)
      if (gameData.is_free && (!priceInfo || priceInfo.initial === 0)) {
        this.log('debug', `Skipping F2P game: ${gameData.name}`);
        return null;
      }

      // Check if game is currently free (final price is 0)
      if (priceInfo?.final !== 0) {
        return null;
      }

      return this.normalizeSteamGame(gameData);

    } catch (error) {
      this.log('warn', `Failed to fetch details for app ${appId}`, {
        error: error.message
      });
      return null;
    }
  }

  /**
   * Normalize a Steam game object to our standard format
   * @param {Object} game - Raw game data from Steam
   * @returns {Object} Normalized game object
   */
  normalizeSteamGame(game) {
    // Determine platforms
    const platforms = {
      windows: game.platforms?.windows ?? false,
      mac: game.platforms?.mac ?? false,
      linux: game.platforms?.linux ?? false
    };

    // Get original price
    const originalPrice = game.price_overview?.initial / 100 || 0;

    // Check if it's a free weekend or permanently free
    const isFreeToKeep = game.is_free;

    return {
      external_id: `steam_${game.steam_appid}`,
      title: game.name,
      description: game.short_description || '',
      store: 'steam',
      kind: game.type === 'dlc' ? 'dlc' : 'game',
      platform_windows: platforms.windows,
      platform_mac: platforms.mac,
      platform_linux: platforms.linux,
      platform_android: false,
      platform_ios: false,
      platform_xbox: false,
      platform_playstation: false,
      url: `https://store.steampowered.com/app/${game.steam_appid}`,
      thumbnail_url: game.header_image || null,
      org_price_usd: originalPrice,
      until_date: null, // Steam doesn't provide end dates in API
      is_free_to_keep: isFreeToKeep,
      is_dlc: game.type === 'dlc',
      rating_score: null
    };
  }

}
