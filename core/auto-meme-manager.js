import { EmbedBuilder } from 'discord.js';
import axios from 'axios';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import configCache from '../utils/configCache.js';

export default class AutoMemeManager {
  constructor(client) {
    this.client = client;
  }

  /**
   * Configure auto-meme posting for a guild
   */
  async configureGuild(guildId, enabled, channelId = null, subreddit = 'memes', intervalHours = 24) {
    try {
      const [existing] = await pool.execute(
        'SELECT * FROM auto_meme_config WHERE guild_id = ?',
        [guildId]
      );

      if (existing.length > 0) {
        // Update existing config
        await pool.execute(
          `UPDATE auto_meme_config
           SET is_enabled = ?, channel_id = ?, subreddit = ?, post_interval_hours = ?
           WHERE guild_id = ?`,
          [enabled, channelId, subreddit, intervalHours, guildId]
        );
      } else {
        // Insert new config
        await pool.execute(
          `INSERT INTO auto_meme_config (guild_id, is_enabled, channel_id, subreddit, post_interval_hours)
           VALUES (?, ?, ?, ?, ?)`,
          [guildId, enabled, channelId, subreddit, intervalHours]
        );
      }

      // Invalidate cache so next lookup gets fresh data
      configCache.invalidate('auto_meme_config', guildId);
      logger.info(`[AutoMemeManager] Configured guild ${guildId}: enabled=${enabled}, channel=${channelId}, subreddit=${subreddit}, interval=${intervalHours}h`);

      return true;
    } catch (error) {
      logger.error('[AutoMemeManager] Error configuring guild', {
        error: error.message,
        guildId
      });
      throw error;
    }
  }

  /**
   * Get configuration for a guild (cached - 60s TTL)
   */
  async getGuildConfig(guildId) {
    try {
      return await configCache.get('auto_meme_config', guildId, async () => {
        const [rows] = await pool.execute(
          'SELECT * FROM auto_meme_config WHERE guild_id = ?',
          [guildId]
        );
        return rows.length > 0 ? rows[0] : null;
      });
    } catch (error) {
      logger.error('[AutoMemeManager] Error getting guild config', {
        error: error.message,
        guildId
      });
      return null;
    }
  }

  /**
   * Post memes to all configured guilds
   */
  async postScheduledMemes() {
    try {
      // Get all enabled configurations that are due for a post
      const [configs] = await pool.execute(
        `SELECT * FROM auto_meme_config
         WHERE is_enabled = TRUE
         AND channel_id IS NOT NULL
         AND (last_posted_at IS NULL
              OR DATE_ADD(last_posted_at, INTERVAL post_interval_hours HOUR) <= NOW())`
      );

      logger.info(`[AutoMemeManager] Found ${configs.length} guild(s) ready for meme posting`);

      for (const config of configs) {
        try {
          await this.postMemeToGuild(config);
        } catch (error) {
          logger.error(`[AutoMemeManager] Error posting meme to guild ${config.guild_id}`, {
            error: error.message
          });
        }
      }

    } catch (error) {
      logger.error('[AutoMemeManager] Error in scheduled meme posting', {
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Post a meme to a specific guild
   */
  async postMemeToGuild(config) {
    try {
      const guild = this.client.guilds.cache.get(config.guild_id);
      if (!guild) {
        logger.warn(`[AutoMemeManager] Guild ${config.guild_id} not found in cache`);
        return;
      }

      const channel = guild.channels.cache.get(config.channel_id);
      if (!channel) {
        logger.warn(`[AutoMemeManager] Channel ${config.channel_id} not found in guild ${config.guild_id}`);
        return;
      }

      // Check if channel is text-based
      if (!channel.isTextBased()) {
        logger.warn(`[AutoMemeManager] Channel ${config.channel_id} is not text-based`);
        return;
      }

      // Fetch a random meme from Reddit
      const meme = await this.fetchRedditMeme(config.subreddit, config.guild_id);

      if (!meme) {
        logger.warn(`[AutoMemeManager] No meme found for guild ${config.guild_id}`);
        return;
      }

      // Create embed
      const embed = new EmbedBuilder()
        .setColor('#FF4500')
        .setTitle(meme.title.length > 256 ? meme.title.substring(0, 253) + '...' : meme.title)
        .setURL(`https://reddit.com${meme.permalink}`)
        .setImage(meme.url)
        .setFooter({ text: `👍 ${meme.ups} upvotes • r/${config.subreddit}` })
        .setTimestamp();

      // Post to channel
      await channel.send({ embeds: [embed] });

      // Update last posted time
      await pool.execute(
        'UPDATE auto_meme_config SET last_posted_at = NOW() WHERE guild_id = ?',
        [config.guild_id]
      );

      // Record in history
      await pool.execute(
        `INSERT INTO auto_meme_history (guild_id, reddit_post_id, subreddit, title)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE posted_at = NOW()`,
        [config.guild_id, meme.id, config.subreddit, meme.title]
      );

      logger.info(`[AutoMemeManager] Posted meme to guild ${config.guild_id}, channel ${config.channel_id}`);

    } catch (error) {
      logger.error(`[AutoMemeManager] Error posting meme to guild`, {
        error: error.message,
        guildId: config.guild_id
      });
      throw error;
    }
  }

  /**
   * Fetch a random meme from Reddit
   */
  async fetchRedditMeme(subreddit, guildId) {
    try {
      const response = await axios.get(`https://www.reddit.com/r/${subreddit}/hot.json?limit=100`, {
        headers: { 'User-Agent': 'Discord Bot CertiFriedUtility/1.0' },
        timeout: 10000
      });

      const posts = response.data.data.children
        .filter(post =>
          !post.data.stickied &&
          !post.data.over_18 &&
          (post.data.post_hint === 'image' || post.data.url.match(/\.(jpg|jpeg|png|gif)$/i))
        )
        .map(post => post.data);

      if (posts.length === 0) {
        return null;
      }

      // Get previously posted memes for this guild
      const [history] = await pool.execute(
        'SELECT reddit_post_id FROM auto_meme_history WHERE guild_id = ? AND subreddit = ? ORDER BY posted_at DESC LIMIT 100',
        [guildId, subreddit]
      );

      const postedIds = new Set(history.map(h => h.reddit_post_id));

      // Try to find a meme that hasn't been posted yet
      let unpostedMemes = posts.filter(post => !postedIds.has(post.id));

      // If all memes have been posted, reset and use all
      if (unpostedMemes.length === 0) {
        unpostedMemes = posts;
      }

      // Return random meme from unposted
      const randomMeme = unpostedMemes[Math.floor(Math.random() * unpostedMemes.length)];

      return randomMeme;

    } catch (error) {
      logger.error('[AutoMemeManager] Error fetching Reddit meme', {
        error: error.message,
        subreddit
      });
      return null;
    }
  }

  /**
   * Manually post a meme to a channel (for testing)
   */
  async postManualMeme(guildId, channelId, subreddit = 'memes') {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) {
        throw new Error('Guild not found');
      }

      const channel = guild.channels.cache.get(channelId);
      if (!channel) {
        throw new Error('Channel not found');
      }

      if (!channel.isTextBased()) {
        throw new Error('Channel is not text-based');
      }

      const meme = await this.fetchRedditMeme(subreddit, guildId);

      if (!meme) {
        throw new Error('No meme found');
      }

      const embed = new EmbedBuilder()
        .setColor('#FF4500')
        .setTitle(meme.title.length > 256 ? meme.title.substring(0, 253) + '...' : meme.title)
        .setURL(`https://reddit.com${meme.permalink}`)
        .setImage(meme.url)
        .setFooter({ text: `👍 ${meme.ups} upvotes • r/${subreddit}` })
        .setTimestamp();

      await channel.send({ embeds: [embed] });

      return true;

    } catch (error) {
      logger.error('[AutoMemeManager] Error posting manual meme', {
        error: error.message
      });
      throw error;
    }
  }
}
