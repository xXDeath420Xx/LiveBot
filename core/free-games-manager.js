import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { withTimeout } from '../utils/errorHandler.js';
import { TIMEOUTS } from '../utils/constants.js';
import EpicGamesScraper from '../utils/scrapers/epic-games-scraper.js';
import SteamScraper from '../utils/scrapers/steam-scraper.js';
import GOGScraper from '../utils/scrapers/gog-scraper.js';
import PrimeGamingScraper from '../utils/scrapers/prime-gaming-scraper.js';
import { gameKey } from '../utils/free-games-key.js';

/**
 * Collapse a scraper's output to one entry per real game.
 *
 * This sits between EVERY scraper and the database on purpose. Prime Gaming's card walk was
 * resolving to the whole offer grid rather than a single card, so all 54 buttons reported the first
 * title on the page — the same game, 54 times, each of which would have become its own announcement
 * and its own Discord post. That specific bug is fixed at the source, but a scraper scrapes someone
 * else's HTML: the next redesign can break it again, silently, at 3am. A guard here means the worst
 * a broken scraper can do is announce too few games, never the same game fifty times.
 *
 * Identity is the store URL, falling back to the title only when there is no usable URL.
 */
function dedupeGames(games) {
  const out = [];
  const seen = new Set();
  for (const g of games ?? []) {
    const id = gameKey(g?.url) ?? (g?.title ? `title:${String(g.title).trim().toLowerCase()}` : null);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(g);
  }
  return out;
}

/**
 * Manages free games discovery, storage, and notifications
 */
export default class FreeGamesManager {
  constructor(client) {
    this.client = client;
    this.scrapers = {
      epic: new EpicGamesScraper(),
      steam: new SteamScraper(),
      gog: new GOGScraper(),
      prime: new PrimeGamingScraper()
    };
  }

  /**
   * Check all platforms for new free games
   * Optimized: Fetches all platforms concurrently, then processes games in parallel
   * @returns {Promise<Array>} Array of new announcements created
   */
  async checkForNewGames() {
    logger.info('[FreeGamesManager] Checking for new free games across all platforms');

    const newAnnouncements = [];
    const platformResults = [];

    // Fetch all platforms concurrently - scrapers have built-in caching and timeouts
    const fetchPromises = Object.entries(this.scrapers).map(async ([platform, scraper]) => {
      try {
        logger.info(`[FreeGamesManager] Checking ${platform}...`);

        // Use cached results when available (5-minute TTL in scraper)
        // Scraper has built-in 5-second timeout for fast responses
        const games = await scraper.getCachedOrFetch();

        return { platform, games, error: null };
      } catch (error) {
        logger.error(`[FreeGamesManager] Error checking ${platform}`, {
          error: error.message
        });
        return { platform, games: null, error: error.message };
      }
    });

    // Wait for all platform fetches to complete
    const results = await Promise.allSettled(fetchPromises);

    // Process results
    for (const result of results) {
      if (result.status === 'fulfilled') {
        platformResults.push(result.value);
      }
    }

    // Process all games from successful fetches
    for (const { platform, games, error } of platformResults) {
      if (error) {
        await this.updateScraperCache(platform, null, error);
        continue;
      }

      const deduped = dedupeGames(games);
      if (deduped.length !== (games?.length ?? 0)) {
        logger.warn(`[FreeGamesManager] ${platform} returned ${games.length} games but only ${deduped.length} are distinct — ` +
          'the scraper is repeating itself. Announcing the deduplicated set.');
      }

      if (deduped.length > 0) {
        // Process games in parallel batches of 5 to avoid overwhelming the database
        const batchSize = 5;
        for (let i = 0; i < deduped.length; i += batchSize) {
          const batch = deduped.slice(i, i + batchSize);
          const announcements = await Promise.all(
            batch.map(game => this.processGame(game).catch(() => null))
          );

          for (const announcement of announcements) {
            if (announcement) {
              newAnnouncements.push(announcement);
            }
          }
        }

        // Update scraper cache
        await this.updateScraperCache(platform, deduped, null);
      }
    }

    logger.info(`[FreeGamesManager] Found ${newAnnouncements.length} new announcement(s)`);
    return newAnnouncements;
  }

  /**
   * Check a single platform for new games (used for staggered checking)
   * Much lighter than checking all platforms at once
   * @param {string} platformName - Platform to check (epic, steam, gog, prime)
   * @returns {Promise<Array>} Array of new announcements created
   */
  async checkSinglePlatform(platformName) {
    const scraper = this.scrapers[platformName];
    if (!scraper) {
      logger.warn(`[FreeGamesManager] Unknown platform: ${platformName}`);
      return [];
    }

    logger.info(`[FreeGamesManager] Checking ${platformName} for new games`);
    const newAnnouncements = [];

    try {
      // Use cached results when available, otherwise fetch fresh
      const games = await scraper.getCachedOrFetch();

      if (games && games.length > 0) {
        // Process games sequentially to avoid DB contention
        for (const game of games) {
          try {
            const announcement = await this.processGame(game);
            if (announcement) {
              newAnnouncements.push(announcement);
            }
          } catch (err) {
            logger.error(`[FreeGamesManager] Error processing game ${game.title}`, {
              error: err.message
            });
          }
        }

        // Update scraper cache in DB
        await this.updateScraperCache(platformName, games, null);
      }

      logger.info(`[FreeGamesManager] ${platformName}: Found ${games?.length || 0} games, ${newAnnouncements.length} new`);

    } catch (error) {
      logger.error(`[FreeGamesManager] Error checking ${platformName}`, {
        error: error.message
      });
      await this.updateScraperCache(platformName, null, error.message);
    }

    return newAnnouncements;
  }

  /**
   * Process a game: save to database and create announcement if new
   * @param {Object} gameData - Normalized game object
   * @returns {Promise<Object|null>} Announcement object if created, null otherwise
   */
  async processGame(gameData) {
    try {
      // Check if product already exists
      const [existingProducts] = await pool.execute(
        'SELECT id FROM free_games_products WHERE external_id = ?',
        [gameData.external_id]
      );

      let productId;

      if (existingProducts.length > 0) {
        // Update existing product
        productId = existingProducts[0].id;
        await this.updateProduct(productId, gameData);
        return null; // Not a new game
      } else {
        // Insert new product
        productId = await this.insertProduct(gameData);

        // Create announcement for new game
        const announcement = await this.createAnnouncement(productId, gameData);
        return announcement;
      }

    } catch (error) {
      logger.error('[FreeGamesManager] Error processing game', {
        game: gameData.title,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Sanitize a price value - strips currency symbols and ensures numeric output
   * @param {*} value - Raw price value (string like "$5.99", number, or null)
   * @returns {number} Numeric price value safe for DECIMAL column
   */
  sanitizePrice(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return isNaN(value) ? 0 : value;
    if (typeof value === 'string') {
      const parsed = parseFloat(value.replace(/[^0-9.]/g, ''));
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  /**
   * Insert a new product into the database
   * @param {Object} gameData - Game data object
   * @returns {Promise<number>} Product ID
   */
  async insertProduct(gameData) {
    const [result] = await pool.execute(
      `INSERT INTO free_games_products (
        external_id, title, description, store, kind,
        platform_windows, platform_mac, platform_linux,
        platform_android, platform_ios, platform_xbox, platform_playstation,
        url, thumbnail_url, org_price_usd, until_date,
        is_free_to_keep, is_dlc, rating_score, is_active, approved
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gameData.external_id,
        gameData.title,
        gameData.description,
        gameData.store,
        gameData.kind,
        gameData.platform_windows,
        gameData.platform_mac,
        gameData.platform_linux,
        gameData.platform_android,
        gameData.platform_ios,
        gameData.platform_xbox,
        gameData.platform_playstation,
        gameData.url,
        gameData.thumbnail_url,
        this.sanitizePrice(gameData.org_price_usd),
        gameData.until_date,
        gameData.is_free_to_keep,
        gameData.is_dlc,
        gameData.rating_score,
        true, // is_active
        true  // approved
      ]
    );

    logger.info(`[FreeGamesManager] Inserted new product: ${gameData.title} (${gameData.store})`);
    return result.insertId;
  }

  /**
   * Update an existing product
   * @param {number} productId - Product ID
   * @param {Object} gameData - Game data object
   */
  async updateProduct(productId, gameData) {
    await pool.execute(
      `UPDATE free_games_products SET
        title = ?, description = ?, url = ?, thumbnail_url = ?,
        org_price_usd = ?, until_date = ?, updated_at = NOW()
      WHERE id = ?`,
      [
        gameData.title,
        gameData.description,
        gameData.url,
        gameData.thumbnail_url,
        this.sanitizePrice(gameData.org_price_usd),
        gameData.until_date,
        productId
      ]
    );
  }

  /**
   * Create an announcement for a new game
   * @param {number} productId - Product ID
   * @param {Object} gameData - Game data object
   * @returns {Promise<Object>} Announcement object
   */
  async createAnnouncement(productId, gameData) {
    // Determine channel type
    const channel = gameData.is_free_to_keep ? 'free' : 'weekend';

    // Create announcement
    const [result] = await pool.execute(
      `INSERT INTO free_games_announcements (
        title, channel, until_date, is_active, notified
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        gameData.title,
        channel,
        gameData.until_date,
        true,
        false
      ]
    );

    const announcementId = result.insertId;

    // Link product to announcement
    await pool.execute(
      'INSERT INTO free_games_announcement_products (announcement_id, product_id) VALUES (?, ?)',
      [announcementId, productId]
    );

    logger.info(`[FreeGamesManager] Created announcement for ${gameData.title}`);

    return {
      id: announcementId,
      title: gameData.title,
      channel,
      productId
    };
  }

  /**
   * Update scraper cache with last check time and data
   * @param {string} platform - Platform name
   * @param {Array|null} data - Data fetched (or null if error)
   * @param {string|null} error - Error message if failed
   */
  async updateScraperCache(platform, data, error) {
    try {
      await pool.execute(
        `INSERT INTO free_games_scraper_cache (platform, last_checked, last_data, last_error)
         VALUES (?, NOW(), ?, ?)
         ON DUPLICATE KEY UPDATE
           last_checked = NOW(),
           last_data = VALUES(last_data),
           last_error = VALUES(last_error)`,
        [
          platform,
          data ? JSON.stringify(data) : null,
          error
        ]
      );
    } catch (err) {
      logger.error(`[FreeGamesManager] Failed to update scraper cache for ${platform}`, {
        error: err.message
      });
    }
  }

  /**
   * Get all unnotified announcements
   * @returns {Promise<Array>}
   */
  async getUnnotifiedAnnouncements() {
    const [announcements] = await pool.execute(
      `SELECT
        a.id,
        a.title,
        a.channel,
        a.until_date,
        GROUP_CONCAT(p.id) as product_ids
      FROM free_games_announcements a
      JOIN free_games_announcement_products ap ON a.id = ap.announcement_id
      JOIN free_games_products p ON ap.product_id = p.id
      WHERE a.is_active = 1
        AND a.notified = 0
        AND (a.until_date IS NULL OR a.until_date > NOW())
        AND (p.until_date IS NULL OR p.until_date > NOW())
      GROUP BY a.id
      ORDER BY a.published_at DESC`
    );

    return announcements;
  }

  /**
   * Get products for an announcement
   * @param {number} announcementId - Announcement ID
   * @returns {Promise<Array>}
   */
  async getAnnouncementProducts(announcementId) {
    const [products] = await pool.execute(
      `SELECT p.*
      FROM free_games_products p
      JOIN free_games_announcement_products ap ON p.id = ap.product_id
      WHERE ap.announcement_id = ?`,
      [announcementId]
    );

    return products;
  }

  /**
   * Send notifications for unnotified announcements
   */
  async sendNotifications() {
    logger.info('[FreeGamesManager] Checking for announcements to notify');

    const announcements = await this.getUnnotifiedAnnouncements();

    if (announcements.length === 0) {
      logger.debug('[FreeGamesManager] No unnotified announcements');
      return;
    }

    logger.info(`[FreeGamesManager] Processing ${announcements.length} announcement(s)`);

    for (const announcement of announcements) {
      await this.notifyAnnouncement(announcement);
      // Add delay between notifications
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /**
   * Send notifications for a specific announcement
   * @param {Object} announcement - Announcement object
   */
  async notifyAnnouncement(announcement) {
    try {
      // Get products for this announcement
      const products = await this.getAnnouncementProducts(announcement.id);

      if (products.length === 0) {
        logger.warn(`[FreeGamesManager] No products found for announcement ${announcement.id}`);
        return;
      }

      // Get all active subscriptions that match filters
      const subscriptions = await this.getMatchingSubscriptions(announcement, products[0]);

      if (subscriptions.length === 0) {
        logger.info(`[FreeGamesManager] No matching subscriptions for announcement ${announcement.id}`);
        // Mark as notified since there's no one to notify
        await pool.execute(
          'UPDATE free_games_announcements SET notified = 1 WHERE id = ?',
          [announcement.id]
        );
        return;
      }

      // A promo whose window has closed is not news, it is misinformation. Never announce it, and
      // never leave it sitting in the queue pretending to be pending.
      if (announcement.until_date && new Date(announcement.until_date) < new Date()) {
        logger.info(`[FreeGamesManager] "${announcement.title}" expired ${announcement.until_date} — not announcing`);
        await pool.execute(
          'UPDATE free_games_announcements SET notified = 1, is_active = 0 WHERE id = ?',
          [announcement.id]);
        return;
      }

      logger.info(`[FreeGamesManager] Sending notification to ${subscriptions.length} subscription(s) for "${announcement.title}"`);

      let successCount = 0;
      let failCount = 0;
      let skipCount = 0;

      for (const sub of subscriptions) {
        // THE duplicate guard. `free_games_notifications` has always been written but never read,
        // so a retry re-sent to every subscription — including the ones that had already received
        // the message. That happens whenever a send half-fails (the post lands, then the ledger
        // INSERT throws), which reports failure for a message the guild can already see.
        if (await this.alreadyDelivered(sub.id, announcement.id)) { skipCount++; continue; }

        // The guild may already have been told about this game by the bot we are replacing. Their
        // members do not care which bot posted it — to them it is simply the same game, twice.
        if (await this.guildHasSeenProducts(sub.guild_id, products)) {
          logger.info(`[FreeGamesManager] guild ${sub.guild_id} already saw "${announcement.title}" (announced by the previous bot) — skipping`);
          await this.recordDelivered(sub.id, announcement.id);
          skipCount++;
          continue;
        }

        const success = await this.sendNotificationToSubscription(sub, announcement, products);
        if (success) {
          successCount++;
        } else {
          failCount++;
        }
      }

      logger.info(`[FreeGamesManager] Notification results for "${announcement.title}": ${successCount} sent, ${failCount} failed, ${skipCount} already had it`);

      // Retire the announcement only once EVERY matching subscription is accounted for. The old rule
      // — "one success is enough" — meant a guild whose send failed while another's succeeded never
      // got that game at all. Now a failure keeps the announcement open for retry, and the ledger
      // check above stops the retry from double-posting to anyone who already has it.
      if (failCount === 0) {
        await pool.execute(
          'UPDATE free_games_announcements SET notified = 1 WHERE id = ?',
          [announcement.id]
        );
      } else {
        logger.warn(`[FreeGamesManager] ${failCount} notification(s) failed for announcement ${announcement.id}; keeping it open so they retry`);
      }

    } catch (error) {
      logger.error(`[FreeGamesManager] Error notifying announcement ${announcement.id}`, {
        error: error.message,
        stack: error.stack
      });
    }
  }

  /** Has this exact subscription already been sent this exact announcement? */
  async alreadyDelivered(subscriptionId, announcementId) {
    const [[row]] = await pool.execute(
      'SELECT 1 AS hit FROM free_games_notifications WHERE subscription_id = ? AND announcement_id = ? LIMIT 1',
      [subscriptionId, announcementId]);
    return !!row;
  }

  /** Write the ledger row. Idempotent — a retry must not stack duplicate rows. */
  async recordDelivered(subscriptionId, announcementId) {
    await pool.execute(
      `INSERT INTO free_games_notifications (subscription_id, announcement_id)
       SELECT ?, ? FROM DUAL
        WHERE NOT EXISTS (SELECT 1 FROM free_games_notifications
                           WHERE subscription_id = ? AND announcement_id = ?)`,
      [subscriptionId, announcementId, subscriptionId, announcementId]);
  }

  /**
   * Has this GUILD already been shown these games — by anyone, us or the bot we replaced?
   *
   * Matched on store-URL identity, never on title (see utils/free-games-key.js). A product whose
   * URL we cannot parse yields no key, and a game with no key is treated as NOT seen: an unknown
   * must fall through to "announce it" rather than silently suppress a real free game.
   */
  async guildHasSeenProducts(guildId, products) {
    const keys = products.map(p => gameKey(p.url)).filter(Boolean);
    if (!keys.length) return false;

    const [rows] = await pool.execute(
      `SELECT game_key FROM free_games_seen
        WHERE guild_id = ? AND game_key IN (${keys.map(() => '?').join(',')})`,
      [guildId, ...keys]);

    // Every game in the announcement must already be seen. If a bundle contains one new game among
    // three old ones, the guild has not seen it and it goes out.
    return rows.length === keys.length;
  }

  /** Remember that this guild has now been shown these games, so nothing ever announces them twice. */
  async recordSeen(guildId, products, source = 'us') {
    for (const p of products) {
      const key = gameKey(p.url);
      if (!key) continue;
      await pool.execute(
        `INSERT INTO free_games_seen (guild_id, game_key, title, source) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE seen_at = seen_at`,
        [guildId, key, p.title ?? null, source]);
    }
  }

  /**
   * Get subscriptions that match the announcement filters
   * @param {Object} announcement - Announcement object
   * @param {Object} product - Product object (first product in announcement)
   * @returns {Promise<Array>}
   */
  async getMatchingSubscriptions(announcement, product) {
    // Build filter query
    const channelFilter = `notify_${announcement.channel} = 1`;
    const storeFilter = `filter_${product.store} = 1`;

    const [subscriptions] = await pool.execute(
      `SELECT * FROM free_games_subscriptions
      WHERE is_enabled = 1 AND ${channelFilter} AND ${storeFilter}`
    );

    // Additional platform filtering
    return subscriptions.filter(sub => {
      if (product.platform_windows && !sub.filter_windows) return false;
      if (product.platform_mac && !sub.filter_mac) return false;
      if (product.platform_linux && !sub.filter_linux) return false;
      return true;
    });
  }

  /**
   * Send notification to a specific subscription
   * @param {Object} subscription - Subscription object
   * @param {Object} announcement - Announcement object
   * @param {Array} products - Array of product objects
   * @returns {Promise<boolean>} True if notification was sent successfully
   */
  async sendNotificationToSubscription(subscription, announcement, products) {
    try {
      // Get the correct bot for this guild
      let botClient = this.client;
      let usingCustomBot = false;

      if (global.botManager) {
        const botId = global.botManager.guildBotMapping.get(subscription.guild_id);
        if (botId) {
          const customClient = global.botManager.clients.get(botId);
          if (customClient) {
            botClient = customClient;
            usingCustomBot = true;
          }
        }
      }

      // Get the channel
      const channel = await botClient.channels.fetch(subscription.discord_channel_id).catch(() => null);

      if (!channel) {
        // A deleted channel is PERMANENT, not a blip. Now that a failure keeps an announcement open
        // for retry, reporting this as a normal failure would pin every announcement open forever,
        // retrying a channel that is never coming back. Close it out for this subscription and say
        // so loudly instead.
        logger.warn(`[FreeGamesManager] Channel ${subscription.discord_channel_id} is gone for guild ${subscription.guild_id} — ` +
          'closing this announcement for that subscription. Re-point it with /alerts freegames.', {
          usingCustomBot,
          botId: botClient.user?.id,
        });
        await this.recordDelivered(subscription.id, announcement.id).catch(() => {});
        return true; // "nothing left to do here", not "the guild got it"
      }

      // Build embed
      const embed = this.buildAnnouncementEmbed(announcement, products);

      // Build message content
      let content = subscription.custom_message || `🎮 **Free Game Alert!**`;

      if (subscription.mention_role_id) {
        content = `<@&${subscription.mention_role_id}> ${content}`;
      }

      // Send notification
      const message = await channel.send({
        content,
        embeds: [embed]
      });

      // The message is now visible in the guild. Everything from here on MUST NOT be able to report
      // failure — a "failed" send whose post actually landed is what caused the duplicate re-post.
      try {
        await this.recordDelivered(subscription.id, announcement.id);
        await this.recordSeen(subscription.guild_id, products, 'us');
      } catch (err) {
        logger.error('[FreeGamesManager] Post succeeded but the ledger write failed — the guild HAS the message', {
          error: err.message, subscriptionId: subscription.id, announcementId: announcement.id,
        });
        // Deliberately still true: the guild has it. Reporting false here would re-post it.
      }

      logger.info(`[FreeGamesManager] Sent notification to guild ${subscription.guild_id}`, {
        messageId: message.id,
        channelId: channel.id,
        announcementTitle: announcement.title,
        usingCustomBot
      });

      return true;

    } catch (error) {
      logger.error(`[FreeGamesManager] Error sending notification to subscription ${subscription.id}`, {
        error: error.message,
        guildId: subscription.guild_id
      });
      return false;
    }
  }

  /**
   * Build an embed for an announcement
   * @param {Object} announcement - Announcement object
   * @param {Array} products - Array of product objects
   * @returns {EmbedBuilder}
   */
  buildAnnouncementEmbed(announcement, products) {
    const product = products[0]; // Use first product for main info

    // Determine color based on store
    const colors = {
      epic: '#0078F2',
      steam: '#1B2838',
      gog: '#86328A',
      humble: '#CC2929',
      prime: '#9147FF',
      other: '#7289DA'
    };

    const color = colors[product.store] || colors.other;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(product.title)
      .setURL(product.url);

    // Description
    if (product.description) {
      const desc = product.description.length > 400
        ? product.description.substring(0, 397) + '...'
        : product.description;
      embed.setDescription(desc);
    }

    // Price and availability info (FreeStuff APP style)
    let priceInfo = '';
    const originalPrice = parseFloat(product.org_price_usd) || 0;
    if (originalPrice > 0) {
      priceInfo += `~~$${originalPrice.toFixed(2)}~~ **Free**`;
    } else {
      priceInfo += '**Free**';
    }

    if (product.until_date) {
      const untilDate = new Date(product.until_date);
      const year = untilDate.getFullYear();
      const month = String(untilDate.getMonth() + 1).padStart(2, '0');
      const day = String(untilDate.getDate()).padStart(2, '0');
      priceInfo += ` until ${year}-${month}-${day}`;
    }

    // Add rating if available
    if (product.rating_score) {
      priceInfo += `    ${product.rating_score}/10 ★`;
    }

    embed.addFields({
      name: '\u200b',
      value: priceInfo,
      inline: false
    });

    // Links (FreeStuff APP style)
    let links = '';
    if (product.store === 'epic') {
      links += `[Open in browser ↗](${product.url})    `;

      // Extract product slug from URL for launcher link. Skip it for internal
      // 32-hex GUID slugs (legacy bad data) — those don't resolve to a real page.
      const urlMatch = product.url.match(/\/p\/([^\/?#]+)/);
      const productSlug = urlMatch ? urlMatch[1] : '';
      if (productSlug && !/^[0-9a-f]{32}$/i.test(productSlug)) {
        links += `[Open in Epic Games Launcher ↗](https://launcher.store.epicgames.com/p/${productSlug})`;
      }
    } else {
      links += `[Open in browser ↗](${product.url})`;
    }

    embed.addFields({
      name: '\u200b',
      value: links,
      inline: false
    });

    // Game image
    if (product.thumbnail_url) {
      embed.setImage(product.thumbnail_url);
    }

    // Footer with store branding
    const storeNames = {
      epic: 'Epic Games',
      steam: 'Steam',
      gog: 'GOG',
      humble: 'Humble Bundle',
      prime: 'Prime Gaming',
      other: 'Other Store'
    };

    const storeName = storeNames[product.store] || product.store;

    embed.setFooter({
      text: `via freestuffbot.xyz • ${storeName}`,
      iconURL: product.store === 'epic'
        ? 'https://cdn2.unrealengine.com/Epic+Games+Node%2Fxlarge_whitetext_blackback_epiclogo_504x512_1529964470588-503x512-ac795e81c54b27aaa2e196456dd307bfe4ca3ca4.jpg'
        : undefined
    });

    return embed;
  }
}
