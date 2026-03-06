import { EmbedBuilder } from 'discord.js';
import crypto from 'crypto';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import SteamAPIService from '../utils/services/steam-api.js';

/**
 * Steam Watcher Manager
 * Implements adaptive polling - checks recently updated games more frequently
 */
export default class SteamWatcherManager {
  constructor(client) {
    this.client = client;
    this.steamAPI = new SteamAPIService();

    // Adaptive polling configuration
    this.INTERVAL_FAST = 5;        // 5 minutes for recently updated apps
    this.INTERVAL_NORMAL = 30;     // 30 minutes for normal apps
    this.INTERVAL_SLOW = 120;      // 2 hours for apps with no recent updates
    this.FAST_PERIOD_MINUTES = 180; // Keep fast polling for 3 hours after update
  }

  /**
   * Check all watchers that are due for a check
   */
  async checkWatchers() {
    logger.info('[SteamWatch] Checking watchers...');

    // Get watchers that need to be checked
    const [watchers] = await pool.execute(
      `SELECT * FROM steam_watchers
       WHERE is_enabled = TRUE
       AND (
         last_checked_at IS NULL
         OR DATE_ADD(last_checked_at, INTERVAL check_interval_minutes MINUTE) <= NOW()
       )
       ORDER BY last_checked_at IS NULL DESC, last_checked_at ASC
       LIMIT 50`
    );

    if (watchers.length === 0) {
      logger.debug('[SteamWatch] No watchers due for checking');
      return;
    }

    logger.info(`[SteamWatch] Checking ${watchers.length} watcher(s)`);

    for (const watcher of watchers) {
      try {
        await this.checkWatcher(watcher);

        // Add delay between checks
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        logger.error(`[SteamWatch] Error checking watcher ${watcher.id}`, {
          error: error.message,
          stack: error.stack
        });
      }
    }
  }

  /**
   * Check a single watcher for updates
   * @param {Object} watcher - Watcher database record
   */
  async checkWatcher(watcher) {
    logger.debug(`[SteamWatch] Checking watcher ${watcher.id} (${watcher.watcher_type}:${watcher.steam_id})`);

    let foundUpdate = false;

    switch (watcher.watcher_type) {
      case 'app_news':
        foundUpdate = await this.checkAppNews(watcher);
        break;
      case 'app_price':
        foundUpdate = await this.checkAppPrice(watcher);
        break;
      case 'free_promotions':
        foundUpdate = await this.checkFreePromotions(watcher);
        break;
      case 'valve_news':
        foundUpdate = await this.checkValveNews(watcher);
        break;
      default:
        logger.warn(`[SteamWatch] Unsupported watcher type: ${watcher.watcher_type}`);
    }

    // Update watcher with adaptive polling
    await this.updateWatcherInterval(watcher, foundUpdate);
  }

  /**
   * Check for app news updates
   * @param {Object} watcher - Watcher record
   */
  async checkAppNews(watcher) {
    const news = await this.steamAPI.getLatestNews(watcher.steam_id);

    if (!news) {
      return false; // No news found
    }

    // Check if we've already notified about this news item
    const contentHash = crypto.createHash('sha256')
      .update(`${news.gid}_${news.date}`)
      .digest('hex');

    const [[existing]] = await pool.execute(
      'SELECT id FROM steam_notifications WHERE watcher_id = ? AND content_hash = ?',
      [watcher.id, contentHash]
    );

    if (existing) {
      return false; // Already notified
    }

    // New news item found!
    logger.info(`[SteamWatch] Found new news for ${watcher.steam_name || watcher.steam_id}: ${news.title}`);

    await this.sendNewsNotification(watcher, news);
    await this.recordNotification(watcher.id, 'news', news.gid, contentHash);

    return true;
  }

  /**
   * Check for price changes
   * @param {Object} watcher - Watcher record
   */
  async checkAppPrice(watcher) {
    // Get guild currency
    const [[settings]] = await pool.execute(
      'SELECT currency FROM steam_guild_settings WHERE guild_id = ?',
      [watcher.guild_id]
    );

    const currency = settings?.currency || 'us';
    const priceCheck = await this.steamAPI.checkPriceChanges(watcher.steam_id, currency);

    if (!priceCheck.hasChanged) {
      return false;
    }

    logger.info(`[SteamWatch] Found price change for ${watcher.steam_name || watcher.steam_id}`);

    await this.sendPriceNotification(watcher, priceCheck.current, priceCheck.previous);

    const contentHash = crypto.createHash('sha256')
      .update(`${watcher.steam_id}_${priceCheck.current.final}_${Date.now()}`)
      .digest('hex');

    await this.recordNotification(watcher.id, 'price', `${priceCheck.current.final}`, contentHash);

    return true;
  }

  /**
   * Check for free promotions
   * @param {Object} watcher - Watcher record
   */
  async checkFreePromotions(watcher) {
    const promotions = await this.steamAPI.getFreePromotions();

    if (promotions.length === 0) {
      return false;
    }

    let foundNew = false;

    for (const promo of promotions) {
      const contentHash = crypto.createHash('sha256')
        .update(`${promo.app_id}_${promo.type}`)
        .digest('hex');

      const [[existing]] = await pool.execute(
        'SELECT id FROM steam_notifications WHERE watcher_id = ? AND content_hash = ?',
        [watcher.id, contentHash]
      );

      if (!existing) {
        logger.info(`[SteamWatch] Found new free promotion: ${promo.name}`);
        await this.sendFreePromotionNotification(watcher, promo);
        await this.recordNotification(watcher.id, 'free_promotion', promo.app_id, contentHash);
        foundNew = true;
      }
    }

    return foundNew;
  }

  /**
   * Check Valve news
   * @param {Object} watcher - Watcher record
   */
  async checkValveNews(watcher) {
    const news = await this.steamAPI.getValveNews(1);

    if (news.length === 0) {
      return false;
    }

    const latestNews = news[0];
    const contentHash = crypto.createHash('sha256')
      .update(`${latestNews.gid}_${latestNews.date}`)
      .digest('hex');

    const [[existing]] = await pool.execute(
      'SELECT id FROM steam_notifications WHERE watcher_id = ? AND content_hash = ?',
      [watcher.id, contentHash]
    );

    if (existing) {
      return false;
    }

    logger.info(`[SteamWatch] Found new Valve news: ${latestNews.title}`);
    await this.sendNewsNotification(watcher, latestNews, 'Valve News');
    await this.recordNotification(watcher.id, 'valve_news', latestNews.gid, contentHash);

    return true;
  }

  /**
   * Update watcher check interval (FIXED 5-MINUTE POLLING)
   * @param {Object} watcher - Watcher record
   * @param {boolean} foundUpdate - Whether an update was found
   */
  async updateWatcherInterval(watcher, foundUpdate) {
    // Always use 5-minute intervals for consistent checking
    const newInterval = this.INTERVAL_FAST; // 5 minutes
    let newConsecutiveNoUpdates = watcher.consecutive_no_updates;
    let updateFoundAt = watcher.last_update_found_at;

    if (foundUpdate) {
      // Update found! Reset counter and update timestamp
      newConsecutiveNoUpdates = 0;
      updateFoundAt = new Date();
      logger.debug(`[SteamWatch] Watcher ${watcher.id}: Update found`);
    } else {
      // No update found, increment counter
      newConsecutiveNoUpdates++;
      logger.debug(`[SteamWatch] Watcher ${watcher.id}: No update (${newConsecutiveNoUpdates} consecutive)`);
    }

    // Update watcher in database (always use 5-minute interval)
    await pool.execute(
      `UPDATE steam_watchers
       SET last_checked_at = NOW(),
           check_interval_minutes = ?,
           consecutive_no_updates = ?,
           last_update_found_at = ?
       WHERE id = ?`,
      [newInterval, newConsecutiveNoUpdates, updateFoundAt, watcher.id]
    );
  }

  /**
   * Send news notification to Discord
   * @param {Object} watcher - Watcher record
   * @param {Object} news - News item
   * @param {string} title - Override title
   */
  async sendNewsNotification(watcher, news, title = null) {
    try {
      const channel = await this.getChannel(watcher);
      if (!channel) return;

      // Clean up HTML and BBCode tags from content and format it
      let content = news.contents || '';

      // First, handle HTML tags
      content = content
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<p>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<li>/gi, '• ')
        .replace(/<\/li>/gi, '\n')
        .replace(/<ul>/gi, '')
        .replace(/<\/ul>/gi, '')
        .replace(/<ol>/gi, '')
        .replace(/<\/ol>/gi, '')
        .replace(/<[^>]*>/g, '');

      // Handle BBCode tags - convert to plain text or Discord markdown
      content = content
        .replace(/\[b\]/gi, '**')
        .replace(/\[\/b\]/gi, '**')
        .replace(/\[i\]/gi, '')
        .replace(/\[\/i\]/gi, '')
        .replace(/\[u\]/gi, '')
        .replace(/\[\/u\]/gi, '')
        .replace(/\[strike\]/gi, '~~')
        .replace(/\[\/strike\]/gi, '~~')
        .replace(/\[h1\]/gi, '\n')
        .replace(/\[\/h1\]/gi, '\n')
        .replace(/\[h2\]/gi, '\n')
        .replace(/\[\/h2\]/gi, '\n')
        .replace(/\[h3\]/gi, '\n')
        .replace(/\[\/h3\]/gi, '\n')
        .replace(/\[list\]/gi, '\n')
        .replace(/\[\/list\]/gi, '\n')
        .replace(/\[\*\]/gi, '• ')
        .replace(/\[hr\]\[\/hr\]/gi, '\n')
        .replace(/\[url=([^\]]+)\]([^\[]+)\[\/url\]/gi, '$2')
        .replace(/\[url\]([^\[]+)\[\/url\]/gi, '$1')
        .replace(/\[img\]([^\[]+)\[\/img\]/gi, '')
        .replace(/\[quote\]/gi, '')
        .replace(/\[\/quote\]/gi, '')
        .replace(/\[code\]/gi, '')
        .replace(/\[\/code\]/gi, '')
        .replace(/\[previewyoutube=[^\]]+\]\[\/previewyoutube\]/gi, '')
        .replace(/\[[^\]]+\]/g, ''); // Remove any remaining BBCode tags

      // Handle HTML entities
      content = content
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      // Build plain text message
      let message = `**${news.title}**\n\n`;

      if (content) {
        // Truncate if too long for Discord (max 2000 chars total)
        const maxContentLength = 1800 - news.title.length - news.url.length;
        if (content.length > maxContentLength) {
          content = content.substring(0, maxContentLength - 3) + '...';
        }
        message += `${content}\n\n`;
      }

      message += news.url;

      const mentionContent = this.buildMentionString(watcher);
      const fullMessage = mentionContent ? `${mentionContent}\n${message}` : message;

      await channel.send(fullMessage);

      logger.info(`[SteamWatch] Sent news notification for watcher ${watcher.id}`);
    } catch (error) {
      logger.error(`[SteamWatch] Error sending news notification`, {
        watcher_id: watcher.id,
        error: error.message
      });
    }
  }

  /**
   * Send price change notification
   * @param {Object} watcher - Watcher record
   * @param {Object} current - Current price info
   * @param {Object} previous - Previous price info
   */
  async sendPriceNotification(watcher, current, previous) {
    try {
      const channel = await this.getChannel(watcher);
      if (!channel) return;

      let message = '';

      if (current.is_free) {
        message = `**${watcher.steam_name || 'Steam App'} - Now FREE!**\n\n`;
        message += `This game is now available for free!\n\n`;
      } else if (current.discount_percent > 0) {
        message = `**${watcher.steam_name || 'Steam App'} - ${current.discount_percent}% OFF**\n\n`;
        message += `~~${this.formatPrice(current.initial, current.currency)}~~ → **${current.formatted}**\n\n`;
      } else {
        message = `**${watcher.steam_name || 'Steam App'} - Price Update**\n\n`;
        message += `Now: **${this.formatPrice(current.final, current.currency)}**\n`;
        if (previous) {
          message += `Previously: ${this.formatPrice(previous.final, current.currency)}\n\n`;
        }
      }

      message += `https://store.steampowered.com/app/${watcher.steam_id}`;

      const mentionContent = this.buildMentionString(watcher);
      const fullMessage = mentionContent ? `${mentionContent}\n${message}` : message;

      await channel.send(fullMessage);

      logger.info(`[SteamWatch] Sent price notification for watcher ${watcher.id}`);
    } catch (error) {
      logger.error(`[SteamWatch] Error sending price notification`, {
        watcher_id: watcher.id,
        error: error.message
      });
    }
  }

  /**
   * Send free promotion notification
   * @param {Object} watcher - Watcher record
   * @param {Object} promo - Promotion details
   */
  async sendFreePromotionNotification(watcher, promo) {
    try {
      const channel = await this.getChannel(watcher);
      if (!channel) return;

      const promoType = promo.type === 'free_weekend' ? 'Free Weekend' : 'Free Promotion';

      let message = `**${promo.name} - ${promoType}**\n\n`;

      if (promo.type === 'free_weekend') {
        message += `Play ${promo.name} for FREE this weekend!\n\n`;
      } else {
        message += `${promo.name} is currently FREE! Grab it while the promotion lasts!\n\n`;
      }

      message += `https://store.steampowered.com/app/${promo.app_id}`;

      const mentionContent = this.buildMentionString(watcher);
      const fullMessage = mentionContent ? `${mentionContent}\n${message}` : message;

      await channel.send(fullMessage);

      logger.info(`[SteamWatch] Sent free promotion notification for watcher ${watcher.id}`);
    } catch (error) {
      logger.error(`[SteamWatch] Error sending free promotion notification`, {
        watcher_id: watcher.id,
        error: error.message
      });
    }
  }

  /**
   * Get Discord channel for watcher (handles multi-bot routing)
   * @param {Object} watcher - Watcher record
   */
  async getChannel(watcher) {
    let botClient = this.client;

    // Multi-bot support
    if (global.botManager) {
      const botId = global.botManager.guildBotMapping.get(watcher.guild_id);
      if (botId) {
        botClient = global.botManager.clients.get(botId) || this.client;
      }
    }

    try {
      return await botClient.channels.fetch(watcher.discord_channel_id);
    } catch (error) {
      logger.warn(`[SteamWatch] Channel ${watcher.discord_channel_id} not found for guild ${watcher.guild_id}`);
      return null;
    }
  }

  /**
   * Build mention string from watcher configuration
   * @param {Object} watcher - Watcher record
   */
  buildMentionString(watcher) {
    const mentions = [];

    if (watcher.mention_role_ids) {
      try {
        const roles = JSON.parse(watcher.mention_role_ids);
        mentions.push(...roles.map(id => `<@&${id}>`));
      } catch (error) {
        // Invalid JSON
      }
    }

    if (watcher.mention_user_ids) {
      try {
        const users = JSON.parse(watcher.mention_user_ids);
        mentions.push(...users.map(id => `<@${id}>`));
      } catch (error) {
        // Invalid JSON
      }
    }

    return mentions.length > 0 ? mentions.join(' ') : '';
  }

  /**
   * Format price in cents
   * @param {number} cents - Price in cents
   * @param {string} currency - Currency code
   */
  formatPrice(cents, currency) {
    const amount = (cents / 100).toFixed(2);
    return `${currency} ${amount}`;
  }

  /**
   * Record notification in database
   * @param {number} watcherId - Watcher ID
   * @param {string} notificationType - Type of notification
   * @param {string} contentId - Content ID
   * @param {string} contentHash - Content hash for duplicate detection
   */
  async recordNotification(watcherId, notificationType, contentId, contentHash) {
    await pool.execute(
      'INSERT INTO steam_notifications (watcher_id, notification_type, content_id, content_hash) VALUES (?, ?, ?, ?)',
      [watcherId, notificationType, contentId, contentHash]
    );
  }
}
