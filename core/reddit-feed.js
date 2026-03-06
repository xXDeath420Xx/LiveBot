import axios from 'axios';
import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/**
 * Check all Reddit feeds and post new content
 */
async function checkRedditFeeds(client) {
  try {
    const [feeds] = await pool.execute('SELECT * FROM reddit_feeds');
    if (feeds.length === 0) return;

    for (const feed of feeds) {
      await processFeed(feed, client);
    }
  } catch (error) {
    logger.error('[RedditFeed] Error checking feeds:', error);
  }
}

/**
 * Process a single Reddit feed
 */
async function processFeed(feed, client) {
  try {
    const response = await axios.get(
      `https://www.reddit.com/r/${feed.subreddit}/new.json?limit=5`,
      {
        headers: {
          'User-Agent': 'CertiFriedUtility/1.0'
        }
      }
    );

    const posts = response.data.data.children;

    if (posts.length === 0) return;

    const newPosts = [];
    let latestPostId = feed.last_post_id;

    // Find posts newer than the last one we saw
    for (const post of posts) {
      if (post.data.id === feed.last_post_id) {
        break; // We've reached the last post we announced
      }
      newPosts.unshift(post.data); // Add to the beginning to send oldest first
    }

    if (newPosts.length > 0) {
      latestPostId = newPosts[newPosts.length - 1].id;
      const guild = client.guilds.cache.get(feed.guild_id);
      if (!guild) return;

      const channel = await guild.channels.fetch(feed.channel_id).catch(() => null);
      if (!channel) return;

      for (const post of newPosts) {
        const embed = new EmbedBuilder()
          .setColor('#FF4500')
          .setTitle(post.title.substring(0, 256))
          .setURL(`https://www.reddit.com${post.permalink}`)
          .setDescription(post.selftext ? post.selftext.substring(0, 400) : 'No text content.')
          .setAuthor({
            name: `New post in r/${feed.subreddit}`,
            iconURL: 'https://www.redditinc.com/assets/images/site/reddit-logo.png'
          })
          .addFields(
            { name: 'Author', value: `u/${post.author}`, inline: true },
            { name: 'Upvotes', value: post.score.toString(), inline: true }
          )
          .setTimestamp(post.created_utc * 1000);

        if (post.thumbnail && post.thumbnail.startsWith('http')) {
          embed.setThumbnail(post.thumbnail);
        }

        await channel.send({ embeds: [embed] });
      }

      await pool.execute(
        'UPDATE reddit_feeds SET last_post_id = ? WHERE id = ?',
        [latestPostId, feed.id]
      );
    }
  } catch (error) {
    logger.warn(`[RedditFeed] Failed to fetch subreddit r/${feed.subreddit}:`, error.message);
  }
}

export { checkRedditFeeds };
