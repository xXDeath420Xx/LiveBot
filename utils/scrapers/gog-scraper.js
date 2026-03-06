import FreeGamesScraper from './free-games-scraper-base.js';

/**
 * Scraper for GOG (Good Old Games) free games
 * Checks GOG for giveaways and free games
 */
export default class GOGScraper extends FreeGamesScraper {
  constructor() {
    super('gog');
    this.apiUrl = 'https://api.gog.com';
    this.catalogUrl = 'https://catalog.gog.com';
  }

  /**
   * Fetch currently free games from GOG
   * @returns {Promise<Array<Object>>} Array of normalized game objects
   */
  async fetchFreeGames() {
    try {
      this.log('info', 'Fetching free games from GOG');

      const freeGames = [];

      // Check for games on sale for 100% off
      const onSaleGames = await this.fetchOnSaleGames();
      freeGames.push(...onSaleGames);

      this.log('info', `Found ${freeGames.length} free game(s) on GOG`);
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
   * Fetch games currently on sale and filter for free ones
   * @returns {Promise<Array<Object>>}
   */
  async fetchOnSaleGames() {
    try {
      // GOG's catalog API endpoint - filter for discounted games, then check for 100% off
      // We look for high discounts to find potential giveaways
      const url = `${this.catalogUrl}/v1/catalog?limit=48&discounted=true&order=desc:discount`;

      const data = await this.makeRequest(url);

      if (!data || !data.products) {
        return [];
      }

      const freeGames = [];

      for (const product of data.products) {
        const finalPrice = parseFloat(product.price?.finalMoney?.amount || '999');
        const basePrice = parseFloat(product.price?.baseMoney?.amount || '0');

        // Only include games that are:
        // 1. Currently free (final price is $0.00)
        // 2. Normally cost money (base price > $0) - this filters out permanently free games
        if (finalPrice === 0 && basePrice > 0) {
          const normalized = this.normalizeCatalogGame(product);
          if (normalized) {
            freeGames.push(normalized);
          }
        }
      }

      return freeGames;

    } catch (error) {
      this.log('warn', 'Failed to fetch on-sale games', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Normalize a GOG catalog game object to our standard format
   * @param {Object} product - Raw product data from GOG catalog API
   * @returns {Object} Normalized game object
   */
  normalizeCatalogGame(product) {
    // Determine platforms from operatingSystems
    const platforms = {
      windows: product.operatingSystems?.includes('windows') || false,
      mac: product.operatingSystems?.includes('osx') || false,
      linux: product.operatingSystems?.includes('linux') || false
    };

    // Get thumbnail from cover images
    const thumbnail = product.coverVertical || product.coverHorizontal || null;

    // Get original price
    const originalPrice = parseFloat(product.price?.baseMoney?.amount || '0');

    return {
      external_id: `gog_${product.id}`,
      title: product.title,
      description: '', // Catalog API doesn't include description
      store: 'gog',
      kind: product.productType === 'dlc' ? 'dlc' : 'game',
      platform_windows: platforms.windows,
      platform_mac: platforms.mac,
      platform_linux: platforms.linux,
      platform_android: false,
      platform_ios: false,
      platform_xbox: false,
      platform_playstation: false,
      url: `https://www.gog.com/en/game/${product.slug}`,
      thumbnail_url: thumbnail,
      org_price_usd: originalPrice,
      until_date: null, // GOG doesn't always provide end dates
      is_free_to_keep: originalPrice === 0, // If base price is 0, it's free-to-play
      is_dlc: product.productType === 'dlc',
      rating_score: null
    };
  }

  /**
   * Fetch detailed information about a specific game
   * @param {string|number} gameId - GOG game ID
   * @returns {Promise<Object|null>}
   */
  async fetchGameDetails(gameId) {
    try {
      const url = `${this.apiUrl}/v2/games/${gameId}?locale=en-US`;
      const data = await this.makeRequest(url);

      if (!data) {
        return null;
      }

      return this.normalizeGOGGame(data);

    } catch (error) {
      this.log('warn', `Failed to fetch details for game ${gameId}`, {
        error: error.message
      });
      return null;
    }
  }

  /**
   * Normalize a GOG game object to our standard format
   * @param {Object} game - Raw game data from GOG
   * @returns {Object} Normalized game object
   */
  normalizeGOGGame(game) {
    // Determine platforms from systems
    const platforms = {
      windows: false,
      mac: false,
      linux: false
    };

    if (game.systems) {
      platforms.windows = game.systems.includes('windows');
      platforms.mac = game.systems.includes('osx') || game.systems.includes('mac');
      platforms.linux = game.systems.includes('linux');
    }

    // Get images
    const thumbnail = game._links?.boxArtImage?.href ||
                     game._links?.icon?.href ||
                     null;

    // Get original price
    const originalPrice = game.price?.baseAmount / 100 || 0;

    return {
      external_id: `gog_${game.id}`,
      title: game.title,
      description: game.summary || '',
      store: 'gog',
      kind: game.productType === 'DLC' ? 'dlc' : 'game',
      platform_windows: platforms.windows,
      platform_mac: platforms.mac,
      platform_linux: platforms.linux,
      platform_android: false,
      platform_ios: false,
      platform_xbox: false,
      platform_playstation: false,
      url: `https://www.gog.com${game._links?.self?.href || `/game/${game.slug}`}`,
      thumbnail_url: thumbnail,
      org_price_usd: originalPrice,
      until_date: null, // GOG doesn't always provide end dates
      is_free_to_keep: true,
      is_dlc: game.productType === 'DLC',
      rating_score: game.rating ? game.rating / 10 : null
    };
  }
}
