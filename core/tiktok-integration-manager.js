"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
const discord_js_1 = require("discord.js");
class TikTokIntegrationManager {
    constructor(client) {
        this.client = client;
        this.checkInterval = null;
        this.lastCheckedVideos = new Map();
        logger_1.default.info('[TikTokIntegrationManager] TikTok integration manager initialized');
    }
    startMonitoring() {
        // Check for new TikTok videos every 5 minutes
        this.checkInterval = setInterval(() => {
            this.checkNewVideos();
        }, 5 * 60 * 1000);
        logger_1.default.info('[TikTokIntegrationManager] TikTok monitoring started (5min interval)');
    }
    stopMonitoring() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            logger_1.default.info('[TikTokIntegrationManager] TikTok monitoring stopped');
        }
    }
    async checkNewVideos() {
        try {
            const [subscriptions] = await db_1.default.execute('SELECT * FROM tiktok_subscriptions WHERE enabled = 1');
            if (subscriptions.length === 0)
                return;
            logger_1.default.info(`[TikTokIntegrationManager] Checking ${subscriptions.length} TikTok subscriptions`);
            for (const subscription of subscriptions) {
                await this.checkUserVideos(subscription);
            }
        }
        catch (error) {
            const err = error;
            logger_1.default.error(`[TikTokIntegrationManager] Error checking videos: ${err.message}`);
        }
    }
    async checkUserVideos(subscription) {
        try {
            // Note: TikTok API access is restricted. This is a placeholder implementation.
            // In production, you would need to:
            // 1. Use official TikTok API (requires approval)
            // 2. Use a third-party service like RapidAPI
            // 3. Use web scraping (against ToS, not recommended)
            // Placeholder: Simulating API call
            const videos = await this.fetchUserVideos(subscription.tiktok_username);
            if (!videos || videos.length === 0)
                return;
            // Get latest video
            const latestVideo = videos[0];
            // Check if this is a new video
            if (subscription.last_video_id === latestVideo.id)
                return;
            // Send notification
            await this.sendVideoNotification(subscription, latestVideo);
            // Update last checked video
            await db_1.default.execute('UPDATE tiktok_subscriptions SET last_video_id = ?, last_check = NOW() WHERE id = ?', [latestVideo.id, subscription.id]);
            logger_1.default.info(`[TikTokIntegrationManager] Posted new video from @${subscription.tiktok_username}`, {
                subscriptionId: subscription.id,
                videoId: latestVideo.id
            });
        }
        catch (error) {
            const err = error;
            logger_1.default.error(`[TikTokIntegrationManager] Failed to check user videos: ${err.message}`, {
                username: subscription.tiktok_username
            });
        }
    }
    async fetchUserVideos(username) {
        // Placeholder implementation
        // In production, integrate with TikTok API or third-party service
        try {
            // Example using a hypothetical API endpoint
            // const response = await axios.get(`https://api.tiktok.com/v1/user/@${username}/videos`, {
            //     headers: { 'Authorization': `Bearer ${process.env.TIKTOK_API_KEY}` }
            // });
            // return response.data.videos;
            // For now, return null to indicate API not configured
            logger_1.default.warn(`[TikTokIntegrationManager] TikTok API not configured. Skipping check for @${username}`);
            return null;
        }
        catch (error) {
            const err = error;
            logger_1.default.error(`[TikTokIntegrationManager] API fetch error: ${err.message}`);
            return null;
        }
    }
    async sendVideoNotification(subscription, video) {
        try {
            const guild = this.client.guilds.cache.get(subscription.guild_id);
            if (!guild) {
                logger_1.default.warn(`[TikTokIntegrationManager] Guild not found: ${subscription.guild_id}`);
                await db_1.default.execute('UPDATE tiktok_subscriptions SET enabled = 0 WHERE id = ?', [subscription.id]);
                return;
            }
            const channel = guild.channels.cache.get(subscription.channel_id);
            if (!channel) {
                logger_1.default.warn(`[TikTokIntegrationManager] Channel not found: ${subscription.channel_id}`);
                await db_1.default.execute('UPDATE tiktok_subscriptions SET enabled = 0 WHERE id = ?', [subscription.id]);
                return;
            }
            const embed = new discord_js_1.EmbedBuilder()
                .setColor('#000000')
                .setAuthor({
                name: `@${subscription.tiktok_username} posted a new TikTok!`,
                iconURL: 'https://cdn.worldvectorlogo.com/logos/tiktok-icon-2.svg'
            })
                .setTitle(video.title || 'New TikTok Video')
                .setDescription(video.description || '')
                .setURL(video.url)
                .setImage(video.thumbnail || null)
                .setFooter({ text: `👁️ ${video.views || 0} views • ❤️ ${video.likes || 0} likes` })
                .setTimestamp(new Date(video.created_at));
            await channel.send({
                content: `🎵 **New TikTok from @${subscription.tiktok_username}!**`,
                embeds: [embed]
            });
        }
        catch (error) {
            const err = error;
            logger_1.default.error(`[TikTokIntegrationManager] Failed to send notification: ${err.message}`);
        }
    }
    async addSubscription(guildId, channelId, username) {
        try {
            await db_1.default.execute(`
                INSERT INTO tiktok_subscriptions (guild_id, channel_id, tiktok_username)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE enabled = 1, channel_id = VALUES(channel_id)
            `, [guildId, channelId, username]);
            logger_1.default.info(`[TikTokIntegrationManager] Added TikTok subscription for @${username}`, { guildId });
            return true;
        }
        catch (error) {
            const err = error;
            logger_1.default.error(`[TikTokIntegrationManager] Failed to add subscription: ${err.message}`);
            return false;
        }
    }
    async removeSubscription(guildId, username) {
        try {
            await db_1.default.execute('DELETE FROM tiktok_subscriptions WHERE guild_id = ? AND tiktok_username = ?', [guildId, username]);
            logger_1.default.info(`[TikTokIntegrationManager] Removed TikTok subscription for @${username}`, { guildId });
            return true;
        }
        catch (error) {
            const err = error;
            logger_1.default.error(`[TikTokIntegrationManager] Failed to remove subscription: ${err.message}`);
            return false;
        }
    }
    async getSubscriptions(guildId) {
        try {
            const [subscriptions] = await db_1.default.execute('SELECT * FROM tiktok_subscriptions WHERE guild_id = ? ORDER BY created_at DESC', [guildId]);
            return subscriptions;
        }
        catch (error) {
            const err = error;
            logger_1.default.error(`[TikTokIntegrationManager] Failed to get subscriptions: ${err.message}`);
            return [];
        }
    }
}
module.exports = TikTokIntegrationManager;
