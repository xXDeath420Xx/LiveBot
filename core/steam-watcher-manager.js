import { EmbedBuilder } from 'discord.js';
import crypto from 'crypto';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import SteamAPIService from '../utils/services/steam-api.js';
import {
  selectWorkshopNotifications,
  workshopHash,
  cleanWorkshopText,
  formatFileSize,
  workshopItemUrl,
  workshopBrowseUrl,
} from './steam-workshop-utils.js';

const STEAM_COLOR = 0x1B2838;
const WORKSHOP_FETCH_COUNT = 30;

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
    this.INTERVAL_WORKSHOP = 15;   // Workshop watchers post digests; two API queries per check
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
      case 'app_workshop':
        foundUpdate = await this.checkWorkshop(watcher);
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
   * Check an app's Steam Workshop for newly published and updated items.
   *
   * Only items published/updated after the watcher was created count, so adding a watcher never
   * dumps the backlog. Each item is announced once (new) and once per distinct update, de-duplicated
   * through steam_notifications; everything fetched is cached in steam_workshop_items. One message
   * per check: up to 10 embeds, with a link to the workshop page for any overflow.
   * @param {Object} watcher - Watcher record
   */
  async checkWorkshop(watcher) {
    const appId = String(watcher.steam_id);
    const newest = await this.steamAPI.getWorkshopItems(appId, { sort: 'newest', count: WORKSHOP_FETCH_COUNT });
    const updated = await this.steamAPI.getWorkshopItems(appId, { sort: 'updated', count: WORKSHOP_FETCH_COUNT });
    if (newest.length === 0 && updated.length === 0) return false;

    const unique = new Map();
    for (const item of [...newest, ...updated]) unique.set(item.publishedfileid, item);
    await this.steamAPI.cacheWorkshopItems(appId, [...unique.values()]);

    const channel = await this.getChannel(watcher);
    if (!channel) return false; // logged by getChannel; try again next check

    // Banned items are never shown; items Steam flags as sexual are shown only in NSFW channels.
    const visible = (item) => !item.banned && (!item.maybe_inappropriate_sex || channel.nsfw === true);

    const createdAt = watcher.created_at ? new Date(watcher.created_at).getTime() : Date.now();
    const sinceSec = Math.floor(createdAt / 1000);

    const candidateHashes = [];
    for (const item of unique.values()) {
      candidateHashes.push(workshopHash('new', item), workshopHash('upd', item));
    }
    const [seenRows] = await pool.query(
      'SELECT content_hash FROM steam_notifications WHERE watcher_id = ? AND content_hash IN (?)',
      [watcher.id, candidateHashes]
    );
    const seen = new Set(seenRows.map(r => r.content_hash));

    const hidden = [...unique.values()].filter(item => !visible(item));
    const { fresh, updates, skipped } = selectWorkshopNotifications({
      newest: newest.filter(visible),
      updated: updated.filter(visible),
      sinceSec,
      seen,
    });

    // Hidden items are recorded as seen so they are evaluated once, not every check.
    const hiddenRecords = hidden
      .filter(item => Number(item.time_created) >= sinceSec && !seen.has(workshopHash('new', item)))
      .map(item => ({ item, hash: workshopHash('new', item), kind: 'hidden' }));

    if (fresh.length === 0 && updates.length === 0 && skipped.length === 0) {
      for (const r of hiddenRecords) await this.recordNotification(watcher.id, 'workshop_hidden', r.item.publishedfileid, r.hash);
      return false;
    }

    logger.info(`[SteamWatch] Workshop ${watcher.steam_name || appId}: ${fresh.length} new, ${updates.length} updated, ${skipped.length} summarised`);

    const sent = await this.sendWorkshopNotification(watcher, channel, fresh, updates, skipped);
    if (!sent) return false; // nothing recorded, so the next check retries

    for (const { item, hash } of fresh) await this.recordNotification(watcher.id, 'workshop_new', item.publishedfileid, hash);
    for (const { item, hash } of updates) await this.recordNotification(watcher.id, 'workshop_update', item.publishedfileid, hash);
    for (const { item, hash, kind } of skipped) {
      await this.recordNotification(watcher.id, kind === 'new' ? 'workshop_new' : 'workshop_update', item.publishedfileid, hash);
    }
    for (const r of hiddenRecords) await this.recordNotification(watcher.id, 'workshop_hidden', r.item.publishedfileid, r.hash);

    return fresh.length + updates.length > 0;
  }

  /**
   * Post one workshop digest message (mentions + up to 10 embeds).
   * @returns {Promise<boolean>} true when the message was sent
   */
  async sendWorkshopNotification(watcher, channel, fresh, updates, skipped) {
    try {
      const names = await this.steamAPI.getPlayerNames([...fresh, ...updates].map(x => x.item.creator));
      const appName = watcher.steam_name || fresh[0]?.item.app_name || updates[0]?.item.app_name || `App ${watcher.steam_id}`;

      // Sized so ten embeds stay under Discord's 6000-character per-message total
      // (title 100 + description 180 + footer ~65 + author 40 + fields ~100 ≈ 485 each).
      const footerApp = String(appName).slice(0, 40);
      const build = (item, kind) => {
        const embed = new EmbedBuilder()
          .setColor(STEAM_COLOR)
          .setTitle(String(item.title || 'Untitled').slice(0, 100))
          .setURL(workshopItemUrl(item.publishedfileid))
          .setFooter({ text: `${kind === 'new' ? '🆕 New workshop item' : '🔄 Workshop item updated'} • ${footerApp}` })
          .setTimestamp(new Date((kind === 'new' ? item.time_created : item.time_updated) * 1000));
        const desc = cleanWorkshopText(item.short_description, 180);
        if (desc) embed.setDescription(desc);
        if (item.preview_url) embed.setThumbnail(item.preview_url);
        const author = names.get(String(item.creator));
        if (item.creator) {
          embed.setAuthor({
            name: (author || 'Steam user').slice(0, 40),
            url: `https://steamcommunity.com/profiles/${item.creator}/myworkshopfiles/?appid=${encodeURIComponent(watcher.steam_id)}`,
          });
        }
        const size = formatFileSize(item.file_size);
        if (size) embed.addFields({ name: 'Size', value: size, inline: true });
        if (item.tags?.length) embed.addFields({ name: 'Tags', value: item.tags.slice(0, 6).join(', ').slice(0, 80), inline: true });
        return embed;
      };

      const embeds = [
        ...fresh.map(f => build(f.item, 'new')),
        ...updates.map(u => build(u.item, 'update')),
      ];

      const lines = [];
      const mentionContent = this.buildMentionString(watcher);
      if (mentionContent) lines.push(mentionContent);
      const parts = [];
      if (fresh.length) parts.push(`**${fresh.length}** new`);
      if (updates.length) parts.push(`**${updates.length}** updated`);
      lines.push(`🛠️ **${appName}** Steam Workshop: ${parts.join(' and ') || 'activity'}`);
      if (skipped.length) {
        lines.push(`…plus **${skipped.length}** more — browse them: <${workshopBrowseUrl(watcher.steam_id)}>`);
      }

      await channel.send({ content: lines.join('\n').slice(0, 2000), embeds: embeds.slice(0, 10) });
      logger.info(`[SteamWatch] Sent workshop notification for watcher ${watcher.id}`, {
        new: fresh.length, updated: updates.length, summarised: skipped.length
      });
      return true;
    } catch (error) {
      logger.error('[SteamWatch] Error sending workshop notification', {
        watcher_id: watcher.id,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Update watcher check interval (FIXED 5-MINUTE POLLING; workshop watchers every 15 minutes)
   * @param {Object} watcher - Watcher record
   * @param {boolean} foundUpdate - Whether an update was found
   */
  async updateWatcherInterval(watcher, foundUpdate) {
    // Always use 5-minute intervals for consistent checking (workshop digests: 15 minutes)
    const newInterval = watcher.watcher_type === 'app_workshop' ? this.INTERVAL_WORKSHOP : this.INTERVAL_FAST;
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

      // Steam externalpost URLs include the source name as a path segment
      // (e.g. .../externalpost/PC Gamer/123…), which contains whitespace
      // that breaks Discord's autolink parser. Encode whitespace so the
      // link stays clickable.
      const safeUrl = news.url.replace(/\s/g, '%20');

      // Build plain text message
      let message = `**${news.title}**\n\n`;

      if (content) {
        // Truncate if too long for Discord (max 2000 chars total)
        const maxContentLength = 1800 - news.title.length - safeUrl.length;
        if (content.length > maxContentLength) {
          content = content.substring(0, maxContentLength - 3) + '...';
        }
        message += `${content}\n\n`;
      }

      message += safeUrl;

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
