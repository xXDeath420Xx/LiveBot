const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const { XMLParser } = require('fast-xml-parser');
const db = require('../utils/db');
const logger = require('../utils/logger');

async function checkYouTubeFeeds() {
    try {
        const [feeds] = await db.execute('SELECT * FROM youtube_feeds');
        if (feeds.length === 0) return;

        for (const feed of feeds) {
            await processYouTubeFeed(feed);
        }
    } catch (error) {
        logger.error('[YouTubeFeed] Error checking YouTube feeds:', error);
    }
}

async function processYouTubeFeed(feed) {
    try {
        const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${feed.youtube_channel_id}`;
        const response = await axios.get(feedUrl);
        
        const parser = new XMLParser({ ignoreAttributes: false });
        const result = parser.parse(response.data);

        const entries = result.feed.entry;
        if (!entries || entries.length === 0) return;

        const latestVideo = Array.isArray(entries) ? entries[0] : entries;
        const latestVideoId = latestVideo['yt:videoId'];
        
        // If it's a new video and not the one we've already posted
        if (latestVideoId && latestVideoId !== feed.last_video_id) {
            const guild = global.client.guilds.cache.get(feed.guild_id);
            if (!guild) return;

            const channel = await guild.channels.fetch(feed.discord_channel_id).catch(() => null);
            if (!channel) return;

            // Update the channel name in the database if it's not set
            let channelName = feed.channel_name;
            if (!channelName) {
                channelName = latestVideo.author.name;
                await db.execute('UPDATE youtube_feeds SET channel_name = ? WHERE id = ?', [channelName, feed.id]);
            }

            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle(latestVideo.title)
                .setURL(latestVideo.link['@_href'])
                .setAuthor({ name: `${channelName} just uploaded a new video!`, iconURL: 'https://i.imgur.com/k2EXDBl.png' })
                .setImage(latestVideo['media:group']['media:thumbnail']['@_url'])
                .setDescription(latestVideo['media:group']['media:description'].substring(0, 250) + '...')
                .setTimestamp(new Date(latestVideo.published));

            await channel.send({ content: `Hey @everyone, a new video from **${channelName}** is out!`, embeds: [embed] });
            
            await db.execute('UPDATE youtube_feeds SET last_video_id = ? WHERE id = ?', [latestVideoId, feed.id]);
        }
    } catch (error) {
        logger.warn(`[YouTubeFeed] Failed to process feed for channel ID ${feed.youtube_channel_id}:`, error.message);
    }
}

module.exports = { checkYouTubeFeeds };