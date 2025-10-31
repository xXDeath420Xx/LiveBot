/**
 * Cache Integration Helper
 * Provides functions to integrate caching with specific dashboard operations
 */

import {
    getCachedData,
    invalidateGuildCache,
    invalidateUserCache,
    invalidateLiveStreamCache,
    CACHE_TTL
} from './cache-middleware';
import db from '../utils/db';
import logger from '../utils/logger';

/**
 * Wrapper for database operations with cache invalidation
 */
export class CachedDatabaseOperations {
    /**
     * Update guild settings with cache invalidation
     */
    static async updateGuildSettings(guildId: string, settings: any): Promise<void> {
        try {
            // Perform database update
            await db.execute(
                'UPDATE guilds SET ? WHERE guild_id = ?',
                [settings, guildId]
            );

            // Invalidate cache for this guild
            await invalidateGuildCache(guildId);

            logger.info('Guild settings updated and cache invalidated', { guildId, category: 'cache' });
        } catch (error) {
            logger.error('Failed to update guild settings:', { _error, guildId, category: 'cache' });
            throw _error;
        }
    }

    /**
     * Add streamer with cache invalidation
     */
    static async addStreamer(guildId: string, streamerData: any): Promise<void> {
        try {
            // Add streamer to database
            await db.execute(
                'INSERT INTO streamers (guild_id, platform, username, ...) VALUES (?, ?, ?, ...)',
                [guildId, streamerData.platform, streamerData.username]
            );

            // Invalidate guild cache
            await invalidateGuildCache(guildId);

            // If this affects live streams, invalidate that too
            if (streamerData.is_live) {
                await invalidateLiveStreamCache();
            }

            logger.info('Streamer added and cache invalidated', { guildId, category: 'cache' });
        } catch (error) {
            logger.error('Failed to add streamer:', { _error, guildId, category: 'cache' });
            throw _error;
        }
    }

    /**
     * Remove streamer with cache invalidation
     */
    static async removeStreamer(guildId: string, streamerId: string): Promise<void> {
        try {
            // Remove streamer from database
            await db.execute(
                'DELETE FROM streamers WHERE guild_id = ? AND streamer_id = ?',
                [guildId, streamerId]
            );

            // Invalidate caches
            await invalidateGuildCache(guildId);
            await invalidateLiveStreamCache();

            logger.info('Streamer removed and cache invalidated', { guildId, streamerId, category: 'cache' });
        } catch (error) {
            logger.error('Failed to remove streamer:', { _error, guildId, streamerId, category: 'cache' });
            throw _error;
        }
    }

    /**
     * Update live stream status with cache invalidation
     */
    static async updateLiveStreamStatus(streamData: any): Promise<void> {
        try {
            if (streamData.isLive) {
                // Add to live announcements
                await db.execute(
                    `INSERT INTO live_announcements
                    (guild_id, platform, username, stream_title, viewer_count, stream_started_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                    stream_title = VALUES(stream_title),
                    viewer_count = VALUES(viewer_count)`,
                    [
                        streamData.guildId,
                        streamData.platform,
                        streamData.username,
                        streamData.title,
                        streamData.viewers,
                        streamData.startedAt
                    ]
                );
            } else {
                // Remove from live announcements
                await db.execute(
                    'DELETE FROM live_announcements WHERE guild_id = ? AND platform = ? AND username = ?',
                    [streamData.guildId, streamData.platform, streamData.username]
                );
            }

            // Always invalidate live stream cache
            await invalidateLiveStreamCache();

            // Also invalidate guild cache if specific guild
            if (streamData.guildId) {
                await invalidateGuildCache(streamData.guildId);
            }

            logger.info('Live stream status updated and cache invalidated', {
                guildId: streamData.guildId,
                platform: streamData.platform,
                username: streamData.username,
                isLive: streamData.isLive,
                category: 'cache'
            });
        } catch (error) {
            logger.error('Failed to update live stream status:', { _error, streamData, category: 'cache' });
            throw _error;
        }
    }
}

/**
 * Cached data fetchers with built-in fallback
 */
export class CachedDataFetchers {
    /**
     * Get guild statistics with caching
     */
    static async getGuildStats(guildId: string): Promise<any> {
        const cacheKey = `certifried:guildstats:${guildId}`;

        return getCachedData(
            cacheKey,
            async () => {
                const stats: any = {};

                // Get streamer count
                const [streamerCount] = await db.execute(
                    'SELECT COUNT(*) as count FROM streamers WHERE guild_id = ?',
                    [guildId]
                );
                stats.totalStreamers = streamerCount[0]?.count || 0;

                // Get live stream count
                const [liveCount] = await db.execute(
                    'SELECT COUNT(*) as count FROM live_announcements WHERE guild_id = ?',
                    [guildId]
                );
                stats.liveStreams = liveCount[0]?.count || 0;

                // Get subscription count
                const [subCount] = await db.execute(
                    'SELECT COUNT(*) as count FROM subscriptions WHERE guild_id = ?',
                    [guildId]
                );
                stats.totalSubscriptions = subCount[0]?.count || 0;

                // Get team count
                const [teamCount] = await db.execute(
                    'SELECT COUNT(*) as count FROM twitch_teams WHERE guild_id = ?',
                    [guildId]
                );
                stats.totalTeams = teamCount[0]?.count || 0;

                // Get recent activity
                const [recentActivity] = await db.execute(
                    `SELECT COUNT(*) as count
                     FROM action_logs
                     WHERE guild_id = ?
                     AND timestamp > DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
                    [guildId]
                );
                stats.recentActions = recentActivity[0]?.count || 0;

                stats.lastUpdated = new Date().toISOString();

                return stats;
            },
            CACHE_TTL.SERVER_LIST // Use 30 second TTL for stats
        );
    }

    /**
     * Get platform statistics with caching
     */
    static async getPlatformStats(): Promise<any> {
        const cacheKey = 'certifried:platformstats:all';

        return getCachedData(
            cacheKey,
            async () => {
                const [platformData] = await db.execute(`
                    SELECT
                        platform,
                        COUNT(DISTINCT username) as streamers,
                        COUNT(DISTINCT guild_id) as guilds,
                        SUM(CASE WHEN is_live = 1 THEN 1 ELSE 0 END) as live_count
                    FROM streamers
                    GROUP BY platform
                `);

                const [totalStats] = await db.execute(`
                    SELECT
                        COUNT(DISTINCT username) as total_streamers,
                        COUNT(DISTINCT guild_id) as total_guilds,
                        SUM(CASE WHEN is_live = 1 THEN 1 ELSE 0 END) as total_live
                    FROM streamers
                `);

                return {
                    platforms: platformData,
                    totals: totalStats[0],
                    lastUpdated: new Date().toISOString()
                };
            },
            CACHE_TTL.LIVE_STREAMS // Use 15 second TTL for live data
        );
    }

    /**
     * Get user-specific dashboard data with caching
     */
    static async getUserDashboard(userId: string): Promise<any> {
        const cacheKey = `certifried:userdash:${userId}`;

        return getCachedData(
            cacheKey,
            async () => {
                // Get all guilds where user has manage permissions
                const [managedGuilds] = await db.execute(`
                    SELECT g.guild_id, g.guild_name, g.icon_url,
                           COUNT(DISTINCT s.streamer_id) as streamer_count,
                           COUNT(DISTINCT la.id) as live_count
                    FROM guilds g
                    LEFT JOIN streamers s ON g.guild_id = s.guild_id
                    LEFT JOIN live_announcements la ON g.guild_id = la.guild_id
                    WHERE g.guild_id IN (
                        SELECT guild_id FROM guild_admins WHERE user_id = ?
                    )
                    GROUP BY g.guild_id
                `, [userId]);

                // Get recent actions by this user
                const [recentActions] = await db.execute(`
                    SELECT action_type, guild_id, timestamp
                    FROM action_logs
                    WHERE user_id = ?
                    ORDER BY timestamp DESC
                    LIMIT 10
                `, [userId]);

                return {
                    managedGuilds,
                    recentActions,
                    totalGuilds: managedGuilds.length,
                    lastUpdated: new Date().toISOString()
                };
            },
            CACHE_TTL.USER_SPECIFIC // Use 2 minute TTL for user data
        );
    }
}

/**
 * Batch cache operations for efficiency
 */
export class BatchCacheOperations {
    /**
     * Prefetch and cache data for multiple guilds
     */
    static async prefetchGuildData(guildIds: string[]): Promise<void> {
        const promises = guildIds.map(async (guildId) => {
            try {
                // Prefetch guild stats
                await CachedDataFetchers.getGuildStats(guildId);
                logger.debug('Prefetched guild data', { guildId, category: 'cache' });
            } catch (error) {
                logger.error('Failed to prefetch guild data:', { _error, guildId, category: 'cache' });
            }
        });

        await Promise.all(promises);
        logger.info('Batch prefetch completed', { count: guildIds.length, category: 'cache' });
    }

    /**
     * Invalidate cache for multiple guilds
     */
    static async invalidateMultipleGuilds(guildIds: string[]): Promise<void> {
        const promises = guildIds.map(guildId => invalidateGuildCache(guildId));
        await Promise.all(promises);
        logger.info('Batch cache invalidation completed', { count: guildIds.length, category: 'cache' });
    }
}

/**
 * Cache warming on startup
 */
export async function warmupCache(): Promise<void> {
    try {
        logger.info('Starting cache warmup...', { category: 'cache' });

        // Warm up platform stats
        await CachedDataFetchers.getPlatformStats();

        // Get active guilds and warm up their data
        const [activeGuilds] = await db.execute(`
            SELECT DISTINCT guild_id
            FROM streamers
            WHERE is_live = 1
            LIMIT 10
        `);

        if (activeGuilds.length > 0) {
            const guildIds = activeGuilds.map((g: any) => g.guild_id);
            await BatchCacheOperations.prefetchGuildData(guildIds);
        }

        logger.info('Cache warmup completed', { category: 'cache' });
    } catch (error) {
        logger.error('Cache warmup failed:', { _error, category: 'cache' });
    }
}

export default {
    CachedDatabaseOperations,
    CachedDataFetchers,
    BatchCacheOperations,
    warmupCache
};