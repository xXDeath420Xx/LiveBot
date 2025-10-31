"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkRedditFeeds = checkRedditFeeds;
const axios_1 = __importDefault(require("axios"));
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
async function checkRedditFeeds() {
    try {
        const [feeds] = await db_1.default.execute('SELECT * FROM reddit_feeds');
        if (feeds.length === 0)
            return;
        for (const feed of feeds) {
            await processFeed(feed);
        }
    }
    catch (error) {
        logger_1.default.error('[RedditFeed] Error checking feeds:', error);
    }
}
async function processFeed(feed) {
    try {
        const response = await axios_1.default.get(`https://www.reddit.com/r/${feed.subreddit}/new.json?limit=5`);
        const posts = response.data.data.children;
        if (posts.length === 0)
            return;
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
            const guild = global.client.guilds.cache.get(feed.guild_id);
            if (!guild)
                return;
            const channel = await guild.channels.fetch(feed.channel_id).catch(() => null);
            if (!channel)
                return;
            for (const post of newPosts) {
                const embed = new discord_js_1.EmbedBuilder()
                    .setColor('#FF4500')
                    .setTitle(post.title.substring(0, 256))
                    .setURL(`https://www.reddit.com${post.permalink}`)
                    .setDescription(post.selftext.substring(0, 400) || 'No text content.')
                    .setAuthor({ name: `New post in r/${feed.subreddit}`, iconURL: 'https://www.redditinc.com/assets/images/site/reddit-logo.png' })
                    .addFields({ name: 'Author', value: `u/${post.author}`, inline: true }, { name: 'Upvotes', value: post.score.toString(), inline: true })
                    .setTimestamp(post.created_utc * 1000);
                if (post.thumbnail && post.thumbnail.startsWith('http')) {
                    embed.setThumbnail(post.thumbnail);
                }
                await channel.send({ embeds: [embed] });
            }
            await db_1.default.execute('UPDATE reddit_feeds SET last_post_id = ? WHERE id = ?', [latestPostId, feed.id]);
        }
    }
    catch (error) {
        logger_1.default.warn(`[RedditFeed] Failed to fetch subreddit r/${feed.subreddit}:`, error.message);
    }
}
