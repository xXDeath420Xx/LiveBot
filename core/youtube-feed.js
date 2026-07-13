import axios from 'axios';
import { EmbedBuilder } from 'discord.js';
import { XMLParser } from 'fast-xml-parser';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/**
 * Check all YouTube feeds and post new content
 */
async function checkYouTubeFeeds(client) {
  try {
    // Skip feeds that have been suspended due to repeated failures (circuit
    // breaker). Without this, malformed channel IDs spam the logs forever —
    // 671 warnings in ~hour before this fix.
    const [feeds] = await pool.execute(
      `SELECT * FROM youtube_feeds
       WHERE (suspended_until IS NULL OR suspended_until < NOW())
         AND youtube_channel_id REGEXP '^UC[A-Za-z0-9_-]{22}$'`
    );
    if (feeds.length === 0) return;

    for (const feed of feeds) {
      await processYouTubeFeed(feed, client);
    }
  } catch (error) {
    logger.error('[YouTubeFeed] Error checking YouTube feeds:', error);
  }
}

/**
 * Process a single YouTube feed
 */
async function processYouTubeFeed(feed, client) {
  try {
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${feed.youtube_channel_id}`;
    const response = await axios.get(feedUrl, {
      headers: {
        'User-Agent': 'CertiFriedUtility/1.0'
      }
    });

    const parser = new XMLParser({ ignoreAttributes: false });
    const result = parser.parse(response.data);

    const entries = result.feed.entry;
    if (!entries || entries.length === 0) return;

    const latestVideo = Array.isArray(entries) ? entries[0] : entries;
    const latestVideoId = latestVideo['yt:videoId'];

    // If it's a new video and not the one we've already posted
    if (latestVideoId && latestVideoId !== feed.last_video_id) {
      const guild = client.guilds.cache.get(feed.guild_id);
      if (!guild) return;

      const channel = await guild.channels.fetch(feed.discord_channel_id).catch(() => null);
      if (!channel) return;

      // Update the channel name in the database if it's not set
      let channelName = feed.channel_name;
      if (!channelName) {
        channelName = latestVideo.author.name;
        await pool.execute(
          'UPDATE youtube_feeds SET channel_name = ? WHERE id = ?',
          [channelName, feed.id]
        );
      }

      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle(latestVideo.title)
        .setURL(latestVideo.link['@_href'])
        .setAuthor({
          name: `${channelName} just uploaded a new video!`,
          iconURL: 'https://i.imgur.com/k2EXDBl.png'
        })
        .setImage(latestVideo['media:group']['media:thumbnail']['@_url'])
        .setDescription(latestVideo['media:group']['media:description'].substring(0, 250) + '...')
        .setTimestamp(new Date(latestVideo.published));

      await channel.send({
        content: `Hey @everyone, a new video from **${channelName}** is out!`,
        embeds: [embed]
      });

      await pool.execute(
        'UPDATE youtube_feeds SET last_video_id = ?, failed_count = 0, last_error = NULL WHERE id = ?',
        [latestVideoId, feed.id]
      );
    } else {
      // Successful fetch but nothing new — still reset failure counter so
      // a temporary blip doesn't trip the circuit breaker.
      if (feed.failed_count > 0) {
        await pool.execute('UPDATE youtube_feeds SET failed_count = 0, last_error = NULL WHERE id = ?', [feed.id]);
      }
    }
  } catch (error) {
    // Circuit breaker: track consecutive failures, suspend after 5 in a row
    // for 24h. Stops "channel doesn't exist" feeds from spamming the logs +
    // burning HTTP requests on every check cycle.
    try {
      const [r] = await pool.execute(
        `UPDATE youtube_feeds
         SET failed_count = failed_count + 1,
             last_error = ?,
             suspended_until = CASE WHEN failed_count + 1 >= 5 THEN DATE_ADD(NOW(), INTERVAL 24 HOUR) ELSE suspended_until END
         WHERE id = ?`,
        [String(error.message || error).slice(0, 240), feed.id]
      );
      if (r.affectedRows > 0) {
        const newCount = (feed.failed_count || 0) + 1;
        if (newCount === 5) {
          logger.error(`[YouTubeFeed] Suspending feed ${feed.id} (channel "${feed.youtube_channel_id}") for 24h after 5 consecutive failures: ${error.message}`);
        }
      }
    } catch (_) { /* meta-failure on the failure counter — don't compound */ }
    logger.warn(`[YouTubeFeed] Failed to process feed for channel ID ${feed.youtube_channel_id}:`, error.message);
  }
}

export { checkYouTubeFeeds };
