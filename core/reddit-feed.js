import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { fetchSubredditPosts } from '../utils/reddit.js';
import { buildFeedContent, titlePasses, parseList } from './feed-message.js';
import { pollsGuild } from './guild-presence-logic.js';

/**
 * A feed's filters (all optional; empty means off, so older rows post everything as before):
 *   title_include / title_exclude  comma-separated keywords matched against the post title
 *   flair_filter                   comma-separated flairs; only posts with one of them are posted.
 *                                  Reddit reports flair through its API only (REDDIT_CLIENT_ID /
 *                                  _SECRET); on the public feed the flair is unknown and, while a
 *                                  flair filter is set, the post is held back.
 */
export function redditPostPasses(feed, post) {
    if (!titlePasses({ include: feed.title_include, exclude: feed.title_exclude }, post.title)) return false;
    const flairs = parseList(feed.flair_filter);
    if (flairs.length) {
        if (post.flair == null) return false;
        if (!flairs.includes(String(post.flair).trim().toLowerCase())) return false;
    }
    return true;
}

/**
 * Check all Reddit feeds and post new content
 */
async function checkRedditFeeds(client) {
  try {
    const [feeds] = await pool.execute('SELECT * FROM reddit_feeds');
    if (feeds.length === 0) return;

    // Every bot client runs this check; each handles only the servers it is in (a feed for a server
    // this client is not in was fetched and then dropped before any post or cursor update anyway).
    // One bot per server (H-315: core/guild-presence-logic.js pollsGuild).
    const mine = client?.guilds?.cache ? feeds.filter(feed => pollsGuild(client, feed.guild_id, global.botManager)) : feeds;
    for (const feed of mine) {
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
    // Was a direct `new.json` call until Reddit started 403ing unauthenticated JSON
    // requests; utils/reddit.js handles OAuth-or-Atom and hands back one post shape.
    const { posts } = await fetchSubredditPosts(feed.subreddit, { sort: 'new', limit: 5 });

    if (posts.length === 0) return;

    const newPosts = [];
    let latestPostId = feed.last_post_id;

    // Find posts newer than the last one we saw
    for (const post of posts) {
      if (post.id === feed.last_post_id) {
        break; // We've reached the last post we announced
      }
      newPosts.unshift(post); // Add to the beginning to send oldest first
    }

    if (newPosts.length > 0) {
      latestPostId = newPosts[newPosts.length - 1].id;
      const guild = client.guilds.cache.get(feed.guild_id);
      if (!guild) return;

      const channel = await guild.channels.fetch(feed.channel_id).catch(() => null);
      if (!channel) return;

      for (const post of newPosts) {
        // Filtered-out posts are skipped but still move the cursor (latestPostId), so they are
        // never reconsidered.
        if (!redditPostPasses(feed, post)) continue;
        const embed = new EmbedBuilder()
          .setColor('#FF4500')
          .setTitle(post.title.substring(0, 256))
          .setURL(post.permalink)
          .setDescription(post.selftext ? post.selftext.substring(0, 400) : 'No text content.')
          .setAuthor({
            name: `New post in r/${feed.subreddit}`,
            iconURL: 'https://www.redditinc.com/assets/images/site/reddit-logo.png'
          })
          .addFields({ name: 'Author', value: `u/${post.author}`, inline: true })
          .setTimestamp(post.createdAt || new Date());

        // The Atom feed carries no score, so only show the field when we actually
        // have one (i.e. when Reddit OAuth credentials are configured).
        if (post.score !== null) {
          embed.addFields({ name: 'Upvotes', value: post.score.toString(), inline: true });
        }

        if (post.thumbnail) {
          embed.setThumbnail(post.thumbnail);
        }

        // custom_message / ping_role_id empty: no content, exactly as before.
        const { content, allowedMentions } = buildFeedContent({
          template: feed.custom_message,
          pingRoleId: feed.ping_role_id,
          vars: {
            subreddit: `r/${feed.subreddit}`,
            title: post.title,
            author: `u/${post.author}`,
            flair: post.flair || '',
            url: post.permalink,
          },
        });
        await channel.send({ content, allowedMentions, embeds: [embed] });
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
