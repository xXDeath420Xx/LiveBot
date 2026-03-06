import FreeGamesScraper from './free-games-scraper-base.js';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Use stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

/**
 * Scraper for Amazon Prime Gaming (formerly Twitch Prime)
 * Uses Puppeteer with stealth mode to bypass anti-bot protection
 */
export default class PrimeGamingScraper extends FreeGamesScraper {
  constructor() {
    super('prime');
    this.baseUrl = 'https://gaming.amazon.com';
  }

  /**
   * Fetch currently free games from Prime Gaming using Puppeteer
   * @returns {Promise<Array<Object>>} Array of normalized game objects
   */
  async fetchFreeGames() {
    let browser = null;

    try {
      this.log('info', 'Fetching free games from Prime Gaming using browser automation');

      // Launch headless browser
      browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920x1080'
        ]
      });

      const page = await browser.newPage();

      // Set realistic viewport and user agent
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      // Navigate to Prime Gaming
      this.log('info', 'Navigating to Prime Gaming...');
      await page.goto(this.baseUrl, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      // Wait for content to load
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Extract game offers from the page - ONLY actual games, not loot
      const games = await page.evaluate(() => {
        const offers = [];

        // Find ONLY buttons that say exactly "Claim game" - not "Claim in-game content" or just "Claim"
        const claimButtons = Array.from(document.querySelectorAll('button, a')).filter(el => {
          if (!el.textContent) return false;
          const text = el.textContent.toLowerCase().trim();
          // Must contain "claim game" but NOT "in-game"
          return text.includes('claim game') && !text.includes('in-game');
        });

        claimButtons.forEach(button => {
          try {
            // Walk up the DOM to find the card container
            let card = button.closest('[class*="offer"]') || button.closest('[class*="item"]') || button.closest('article') || button.parentElement.parentElement;

            if (!card) return;

            // Try to find title - look for headings or prominent text near the button
            const titleElement = card.querySelector('h3, h2, h4, [class*="title"], [class*="Title"]');
            let title = titleElement ? titleElement.textContent.trim() : null;

            // Fallback: look for text above the button
            if (!title) {
              const textElements = Array.from(card.querySelectorAll('p, div, span'));
              const textAboveButton = textElements.find(el =>
                el.textContent &&
                el.textContent.length > 3 &&
                el.textContent.length < 100 &&
                !el.textContent.toLowerCase().includes('claim')
              );
              title = textAboveButton ? textAboveButton.textContent.trim() : null;
            }

            if (!title || title.length < 3) return;

            // Get image
            const imgElement = card.querySelector('img');
            const image = imgElement ? (imgElement.src || imgElement.dataset.src) : null;

            // Get link
            const linkElement = card.querySelector('a') || button;
            const link = linkElement.href || window.location.href;

            offers.push({
              title,
              image,
              link,
              endDate: null,
              type: 'game' // Only games make it here
            });
          } catch (err) {
            console.error('Error parsing offer:', err);
          }
        });

        return offers;
      });

      await browser.close();
      browser = null;

      // Normalize the games - only include actual games, not in-game loot or F2P games
      const freeGames = [];

      // Keywords that typically indicate in-game loot/DLC rather than full games
      const lootKeywords = [
        'pack', 'bundle', 'content', 'loot', 'drop', 'reward', 'bonus',
        'skin', 'skins', 'cosmetic', 'item', 'items', 'currency', 'coins',
        'points', 'credits', 'dlc', 'add-on', 'addon', 'expansion',
        'starter', 'booster', 'crate', 'chest', 'box', 'kit', 'gear',
        'chapter', 'season pass', 'battle pass', 'edition', 'upgrade',
        'soundtrack', 'artbook', 'art book', 'wallpaper', 'avatar',
        'emote', 'spray', 'charm', 'sticker', 'badge', 'emblem',
        'weapon', 'character', 'outfit', 'costume', 'mount', 'pet',
        'card', 'deck', 'token', 'gem', 'diamond', 'gold', 'silver',
        'premium', 'vip', 'membership', 'subscription', 'pass'
      ];

      // Free-to-play games - any Prime offer for these is loot, not the game itself
      const freeToPlayGames = [
        'fortnite', 'apex legends', 'league of legends', 'valorant',
        'call of duty warzone', 'warzone', 'destiny 2', 'genshin impact',
        'rocket league', 'fall guys', 'multiversus', 'overwatch 2',
        'counter-strike', 'cs2', 'csgo', 'dota 2', 'team fortress 2',
        'path of exile', 'warframe', 'smite', 'paladins', 'brawlhalla',
        'world of tanks', 'world of warships', 'war thunder',
        'hearthstone', 'legends of runeterra', 'magic the gathering',
        'pokemon unite', 'pokemon go', 'diablo immortal', 'lost ark',
        'new world', 'guild wars 2', 'star wars the old republic',
        'neverwinter', 'tera', 'black desert', 'maplestory',
        'roblox', 'minecraft', 'among us', 'dead by daylight',
        'rainbow six siege', 'pubg', 'naraka', 'the finals',
        'xdefiant', 'spectre divide', 'marvel rivals', 'deadlock'
      ];

      for (const game of games) {
        // Skip if explicitly marked as loot
        if (game.type === 'loot') {
          continue;
        }

        const titleLower = (game.title || '').toLowerCase();

        // Skip UI elements and parsing errors
        if (titleLower === 'claim games' || titleLower === 'claim game' || titleLower.length < 4) {
          continue;
        }

        // Skip if title contains loot-related keywords
        const isLikelyLoot = lootKeywords.some(keyword =>
          titleLower.includes(keyword)
        );

        if (isLikelyLoot) {
          this.log('debug', `Skipping loot/DLC item: ${game.title}`);
          continue;
        }

        // Skip if it's content for a free-to-play game
        const isF2PContent = freeToPlayGames.some(f2pGame =>
          titleLower.includes(f2pGame)
        );

        if (isF2PContent) {
          this.log('debug', `Skipping F2P game content: ${game.title}`);
          continue;
        }

        const normalized = this.normalizeScrapedGame(game);
        if (normalized) {
          freeGames.push(normalized);
        }
      }

      this.log('info', `Found ${freeGames.length} free game(s) on Prime Gaming (excluded loot/DLC/F2P)`);
      return freeGames;

    } catch (error) {
      this.log('error', 'Failed to fetch free games', {
        error: error.message,
        stack: error.stack
      });

      if (browser) {
        await browser.close();
      }

      return [];
    }
  }

  /**
   * Normalize a scraped game object to our standard format
   * @param {Object} game - Raw game data from scraping
   * @returns {Object|null} Normalized game object
   */
  normalizeScrapedGame(game) {
    try {
      if (!game.title) {
        return null;
      }

      const isLoot = game.type === 'loot';

      // Parse end date if available
      let endDate = null;
      if (game.endDate) {
        // Try to parse common date formats
        const dateMatch = game.endDate.match(/(\w+)\s+(\d+),?\s+(\d+)/);
        if (dateMatch) {
          endDate = new Date(`${dateMatch[1]} ${dateMatch[2]}, ${dateMatch[3]}`);
        }
      }

      // Generate a consistent ID from the title
      const gameId = game.title.toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');

      return {
        external_id: `prime_${gameId}`,
        title: game.title,
        description: isLoot ? 'In-game loot for Prime Gaming members' : 'Free game for Prime Gaming members',
        store: 'prime',
        kind: isLoot ? 'loot' : 'game',
        platform_windows: true, // Most Prime games support Windows
        platform_mac: false,
        platform_linux: false,
        platform_android: false,
        platform_ios: false,
        platform_xbox: false,
        platform_playstation: false,
        url: game.link || this.baseUrl,
        thumbnail_url: game.image,
        org_price_usd: 0,
        until_date: endDate,
        is_free_to_keep: !isLoot,
        is_dlc: isLoot,
        rating_score: null
      };
    } catch (error) {
      this.log('warn', `Failed to normalize game: ${game.title}`, {
        error: error.message
      });
      return null;
    }
  }
}
