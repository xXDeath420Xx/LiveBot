/**
 * Enhanced Dashboard Server with Redis Caching
 * This file demonstrates how to integrate the cache middleware with existing routes
 */

import express from 'express';
import {
    initializeRedis,
    getCachedData,
    cacheManagePageData,
    cacheServerList,
    cacheLiveStreams,
    invalidateGuildCache,
    invalidateLiveStreamCache,
    CACHE_TTL,
    getCacheStats
} from './cache-middleware';
import db from '../utils/db';
import logger from '../utils/logger';

// Import the existing getManagePageData function or define it here
async function getManagePageDataWithCache(guildId: string, botGuild: any): Promise<any> {
    const cacheKey = `certifried:manage:${guildId}:full`;

    return getCachedData(
        cacheKey,
        async () => {
            // This is the existing getManagePageData logic
            const data: any = {};
            const queries: Record<string, string> = {
                subscriptions: `SELECT sub.*, s.platform, s.username, s.discord_user_id, s.streamer_id, s.platform_user_id
                    FROM subscriptions sub
                    JOIN streamers s ON sub.streamer_id = s.streamer_id
                    WHERE sub.guild_id = ?
                    ORDER BY s.username, sub.announcement_channel_id`,
                guildSettings: "SELECT * FROM guilds WHERE guild_id = ?",
                teamSubscriptions: "SELECT * FROM twitch_teams WHERE guild_id = ?",
                automodRules: "SELECT * FROM automod_rules WHERE guild_id = ? ORDER BY id",
                heatConfig: "SELECT * FROM automod_heat_config WHERE guild_id = ?",
                backups: "SELECT id, snapshot_name, created_at FROM server_backups WHERE guild_id = ? ORDER BY created_at DESC",
                welcomeSettings: "SELECT * FROM welcome_settings WHERE guild_id = ?",
                customCommands: "SELECT * FROM custom_commands WHERE guild_id = ?",
                ticketConfig: "SELECT * FROM ticket_config WHERE guild_id = ?",
                ticketForms: "SELECT * FROM ticket_forms WHERE guild_id = ?",
                logConfig: "SELECT * FROM log_config WHERE guild_id = ?",
                redditFeeds: "SELECT * FROM reddit_feeds WHERE guild_id = ?",
                youtubeFeeds: "SELECT * FROM youtube_feeds WHERE guild_id = ?",
                twitterFeeds: "SELECT * FROM twitter_feeds WHERE guild_id = ?",
                moderationConfig: "SELECT * FROM moderation_config WHERE guild_id = ?",
                recentInfractions: "SELECT * FROM infractions WHERE guild_id = ? ORDER BY created_at DESC LIMIT 10",
                escalationRules: "SELECT * FROM escalation_rules WHERE guild_id = ? ORDER BY infraction_count ASC",
                roleRewards: "SELECT * FROM role_rewards WHERE guild_id = ? ORDER BY level ASC",
                starboardConfig: "SELECT * FROM starboard_config WHERE guild_id = ?",
                reactionRolePanels: "SELECT * FROM reaction_role_panels WHERE guild_id = ?",
                actionLogs: "SELECT * FROM action_logs WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 50",
                auditLogs: "SELECT * FROM audit_logs WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 50",
                giveaways: "SELECT * FROM giveaways WHERE guild_id = ? ORDER BY ends_at DESC",
                polls: "SELECT * FROM polls WHERE guild_id = ? ORDER BY ends_at DESC",
                musicConfig: "SELECT * FROM music_config WHERE guild_id = ?",
                blacklistedUsers: "SELECT platform, platform_user_id, username FROM blacklisted_users"
            };

            // Execute all queries
            for (const key in queries) {
                try {
                    const [rows] = await db.execute(queries[key], [guildId]);
                    data[key] = rows;
                } catch (e: any) {
                    if (e.code === "ER_NO_SUCH_TABLE") {
                        logger.warn(`[Dashboard] Missing table for query '${key}'. Returning empty set.`, { guildId });
                        data[key] = [];
                    } else {
                        logger.error(`[Dashboard] Failed to execute query for '${key}'`, { guildId, error: e.message });
                        data[key] = [];
                    }
                }
            }

            // Process single-row results (convert arrays to objects)
            const singleRowFields = [
                'guildSettings', 'heatConfig', 'welcomeSettings', 'ticketConfig',
                'logConfig', 'moderationConfig', 'starboardConfig', 'musicConfig'
            ];

            singleRowFields.forEach(field => {
                data[field] = data[field][0] || {};
            });

            return data;
        },
        CACHE_TTL.MANAGE_PAGE_DATA
    );
}

// Function to get server list with caching
async function getServerListWithCache(userId: string, guilds: any[]): Promise<any> {
    const cacheKey = `certifried:servers:${userId}`;

    return getCachedData(
        cacheKey,
        async () => {
            // Enhanced guild data with member counts and streamer counts
            const enhancedGuilds = await Promise.all(guilds.map(async (guild) => {
                try {
                    // Get streamer count for this guild
                    const [streamerRows] = await db.execute(
                        'SELECT COUNT(*) as count FROM streamers WHERE guild_id = ?',
                        [guild.id]
                    );
                    const streamerCount = streamerRows[0]?.count || 0;

                    // Get live stream count for this guild
                    const [liveRows] = await db.execute(
                        'SELECT COUNT(*) as count FROM live_announcements WHERE guild_id = ?',
                        [guild.id]
                    );
                    const liveCount = liveRows[0]?.count || 0;

                    return {
                        ...guild,
                        streamerCount,
                        liveCount
                    };
                } catch (error) {
                    logger.error(`Failed to get stats for guild ${guild.id}:`, error as Record<string, any>);
                    return {
                        ...guild,
                        streamerCount: 0,
                        liveCount: 0
                    };
                }
            }));

            return {
                guilds: enhancedGuilds,
                totalGuilds: enhancedGuilds.length,
                totalStreamers: enhancedGuilds.reduce((sum, g) => sum + g.streamerCount, 0),
                totalLiveStreams: enhancedGuilds.reduce((sum, g) => sum + g.liveCount, 0)
            };
        },
        CACHE_TTL.SERVER_LIST
    );
}

// Function to get live stream data with caching
async function getLiveStreamDataWithCache(): Promise<any> {
    const cacheKey = `certifried:livestreams:all`;

    return getCachedData(
        cacheKey,
        async () => {
            const [liveStreamersData] = await db.execute(`
                SELECT DISTINCT
                    la.platform,
                    la.username,
                    la.stream_title as title,
                    la.game_name,
                    la.viewer_count,
                    la.thumbnail_url,
                    la.stream_started_at,
                    s.profile_image_url
                FROM live_announcements la
                LEFT JOIN streamers s ON s.username = la.username AND s.platform = la.platform
                ORDER BY la.stream_started_at ASC
            `);

            // Get total statistics
            const [totalStreamers] = await db.execute('SELECT COUNT(*) as count FROM streamers');
            const [totalAnnouncements] = await db.execute('SELECT COUNT(*) as count FROM live_announcements');

            return {
                liveStreamers: liveStreamersData,
                stats: {
                    totalLive: liveStreamersData.length,
                    totalStreamers: totalStreamers[0]?.count || 0,
                    totalAnnouncements: totalAnnouncements[0]?.count || 0,
                    lastUpdated: new Date().toISOString()
                }
            };
        },
        CACHE_TTL.LIVE_STREAMS
    );
}

// Example route handlers with caching

export function setupCachedRoutes(app: express.Application, botClient: any) {
    // Initialize Redis on startup
    initializeRedis().catch(err => {
        logger.error('Failed to initialize Redis cache:', err as Record<string, any>);
    });

    // Manage page routes with caching
    app.get('/manage/:guildId/:page', cacheManagePageData(), async (req, res) => {
        const { guildId, page } = req.params;

        try {
            const data = await getManagePageDataWithCache(guildId, req.guildObject);
            res.render('manage-modern', {
                ...data,
                user: req.user,
                guild: req.guildObject,
                page
            });
        } catch (error) {
            logger.error(`Error loading manage page ${page}:`, error as Record<string, any>);
            res.status(500).render('error', { error: 'Failed to load page data' });
        }
    });

    // Server list with caching
    app.get('/servers', cacheServerList(), async (req, res) => {
        try {
            const data = await getServerListWithCache(req.user.id, req.user.guilds);
            res.render('servers-modern', data);
        } catch (error) {
            logger.error('Error loading server list:', error as Record<string, any>);
            res.status(500).render('error', { error: 'Failed to load servers' });
        }
    });

    // Live streams API with caching
    app.get('/api/livestreams', cacheLiveStreams(), async (req, res) => {
        try {
            const data = await getLiveStreamDataWithCache();
            res.json(data);
        } catch (error) {
            logger.error('Error loading live streams:', error as Record<string, any>);
            res.status(500).json({ _error: 'Failed to load live streams' });
        }
    });

    // Cache statistics endpoint
    app.get('/api/cache-stats', async (req, res) => {
        try {
            const stats = await getCacheStats();
            res.json(stats);
        } catch (error) {
            logger.error('Error getting cache stats:', error as Record<string, any>);
            res.status(500).json({ _error: 'Failed to get cache stats' });
        }
    });

    // Cache invalidation endpoints (admin only)
    app.post('/api/cache/invalidate/guild/:guildId', async (req, res) => {
        try {
            await invalidateGuildCache(req.params.guildId);
            res.json({ success: true, message: 'Guild cache invalidated' });
        } catch (error) {
            logger.error('Error invalidating guild cache:', error as Record<string, any>);
            res.status(500).json({ _error: 'Failed to invalidate cache' });
        }
    });

    app.post('/api/cache/invalidate/livestreams', async (req, res) => {
        try {
            await invalidateLiveStreamCache();
            res.json({ success: true, message: 'Live stream cache invalidated' });
        } catch (error) {
            logger.error('Error invalidating live stream cache:', error as Record<string, any>);
            res.status(500).json({ _error: 'Failed to invalidate cache' });
        }
    });

    // Automatically invalidate cache on data updates
    app.use((req, res, next) => {
        // Store original send/json functions
        const originalSend = res.send.bind(res);
        const originalJson = res.json.bind(res);
        const originalRedirect = res.redirect.bind(res);

        // Check if this is a POST/PUT/DELETE request that modifies data
        if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
            // Override response methods to invalidate cache after successful updates
            res.send = function(data: any) {
                // Check for successful response
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    // Invalidate relevant caches based on route
                    const path = req.path;

                    if (path.includes('/manage/')) {
                        const guildId = req.params.guildId;
                        if (guildId) {
                            invalidateGuildCache(guildId).catch(err => {
                                logger.error('Failed to invalidate guild cache after update:', err as Record<string, any>);
                            });
                        }
                    }

                    if (path.includes('/livestream') || path.includes('/stream')) {
                        invalidateLiveStreamCache().catch(err => {
                            logger.error('Failed to invalidate live stream cache after update:', err as Record<string, any>);
                        });
                    }
                }

                return originalSend(data);
            };

            res.json = function(data: any) {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    const path = req.path;

                    if (path.includes('/manage/')) {
                        const guildId = req.params.guildId;
                        if (guildId) {
                            invalidateGuildCache(guildId).catch(err => {
                                logger.error('Failed to invalidate guild cache after update:', err as Record<string, any>);
                            });
                        }
                    }

                    if (path.includes('/livestream') || path.includes('/stream')) {
                        invalidateLiveStreamCache().catch(err => {
                            logger.error('Failed to invalidate live stream cache after update:', err as Record<string, any>);
                        });
                    }
                }

                return originalJson(data);
            };

            res.redirect = function(url: string | number, status?: any) {
                // Invalidate cache before redirecting after POST requests
                const path = req.path;

                if (path.includes('/manage/')) {
                    const guildId = req.params.guildId;
                    if (guildId) {
                        invalidateGuildCache(guildId).catch(err => {
                            logger.error('Failed to invalidate guild cache after redirect:', err as Record<string, any>);
                        });
                    }
                }

                if (typeof url === 'string') {
                    return originalRedirect(url);
                } else {
                    return originalRedirect(url, status);
                }
            };
        }

        next();
    });
}

export default {
    getManagePageDataWithCache,
    getServerListWithCache,
    getLiveStreamDataWithCache,
    setupCachedRoutes
};