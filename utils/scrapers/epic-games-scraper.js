import FreeGamesScraper from './free-games-scraper-base.js';

/**
 * Scraper for Epic Games Store free games
 * Uses the public Epic Games GraphQL API
 */
export default class EpicGamesScraper extends FreeGamesScraper {
  constructor() {
    super('epic');
    this.apiUrl = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions';
  }

  /**
   * Fetch currently free games from Epic Games Store
   * @returns {Promise<Array<Object>>} Array of normalized game objects
   */
  async fetchFreeGames() {
    try {
      this.log('info', 'Fetching free games from Epic Games Store');

      const params = new URLSearchParams({
        locale: 'en-US',
        country: 'US',
        allowCountries: 'US'
      });

      const data = await this.makeRequest(`${this.apiUrl}?${params}`);

      if (!data || !data.data || !data.data.Catalog || !data.data.Catalog.searchStore) {
        this.log('warn', 'Invalid response structure from Epic Games API');
        return [];
      }

      const games = data.data.Catalog.searchStore.elements || [];
      const freeGames = [];

      const now = new Date();

      for (const game of games) {
        // Check if game has current promotions
        if (!game.promotions) continue;

        const currentOffers = game.promotions.promotionalOffers || [];
        const upcomingOffers = game.promotions.upcomingPromotionalOffers || [];

        // Process current free games
        for (const offerSet of currentOffers) {
          for (const offer of offerSet.promotionalOffers || []) {
            if (this.isGameFree(offer)) {
              const normalizedGame = this.normalizeEpicGame(game, offer, false);
              if (normalizedGame) {
                freeGames.push(normalizedGame);
              }
            }
          }
        }
      }

      this.log('info', `Found ${freeGames.length} free game(s) on Epic Games Store`);
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
   * Check if an offer makes the game free
   * @param {Object} offer - Promotional offer object
   * @returns {boolean}
   */
  isGameFree(offer) {
    return offer.discountSetting &&
           offer.discountSetting.discountPercentage === 0;
  }

  /**
   * Normalize an Epic Games game object to our standard format
   * @param {Object} game - Raw game data from Epic
   * @param {Object} offer - Promotional offer data
   * @param {boolean} isUpcoming - Whether this is an upcoming free game
   * @returns {Object|null} Normalized game object
   */
  normalizeEpicGame(game, offer, isUpcoming = false) {
    try {
      // Accept BASE_GAME and OTHERS (some games like Hogwarts Legacy use OTHERS)
      // Skip DLC, add-ons, bundles, etc.
      const validTypes = ['BASE_GAME', 'OTHERS'];
      if (!validTypes.includes(game.offerType)) {
        return null;
      }

      // Skip if title contains DLC/addon keywords
      const titleLower = game.title.toLowerCase();
      if (titleLower.includes('dlc') || titleLower.includes('add-on') ||
          titleLower.includes('pack') || titleLower.includes('bundle') ||
          titleLower.includes('edition') && titleLower.includes('upgrade')) {
        return null;
      }

      // Get the best image
      const keyImages = game.keyImages || [];
      const thumbnail = this.getBestImage(keyImages);

      // Extract platforms
      const platforms = {
        windows: false,
        mac: false,
        linux: false
      };

      if (game.customAttributes) {
        for (const attr of game.customAttributes) {
          if (attr.key === 'com.epicgames.app.productSlug') {
            // Platform info is sometimes in custom attributes
          }
        }
      }

      // Default to Windows if no platform info
      if (!platforms.windows && !platforms.mac && !platforms.linux) {
        platforms.windows = true;
      }

      // Get original price - fmtPrice.originalPrice is a formatted string like "$5.99"
      const rawPrice = game.price?.totalPrice?.fmtPrice?.originalPrice;
      const originalPrice = rawPrice && typeof rawPrice === 'string'
        ? parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || 0
        : (typeof rawPrice === 'number' ? rawPrice : 0);

      return {
        external_id: `epic_${game.id}`,
        title: game.title,
        description: game.description || '',
        store: 'epic',
        kind: 'game',
        platform_windows: platforms.windows,
        platform_mac: platforms.mac,
        platform_linux: platforms.linux,
        platform_android: false,
        platform_ios: false,
        platform_xbox: false,
        platform_playstation: false,
        url: `https://store.epicgames.com/en-US/p/${game.productSlug || game.urlSlug}`,
        thumbnail_url: thumbnail,
        org_price_usd: originalPrice,
        until_date: offer.endDate ? new Date(offer.endDate) : null,
        is_free_to_keep: true,
        is_dlc: false,
        rating_score: null
      };
    } catch (error) {
      this.log('warn', `Failed to normalize game: ${game.title}`, {
        error: error.message
      });
      return null;
    }
  }

  /**
   * Get the best image from keyImages array
   * Prioritizes: Thumbnail -> Featured -> DieselStoreFrontWide -> First available
   * @param {Array} keyImages - Array of image objects
   * @returns {string|null} Image URL
   */
  getBestImage(keyImages) {
    if (!keyImages || keyImages.length === 0) return null;

    const priority = ['Thumbnail', 'OfferImageWide', 'DieselStoreFrontWide', 'Featured'];

    for (const type of priority) {
      const image = keyImages.find(img => img.type === type);
      if (image && image.url) {
        return image.url;
      }
    }

    // Return first available image
    return keyImages[0]?.url || null;
  }
}
