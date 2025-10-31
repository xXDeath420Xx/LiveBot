/**
 * Example: How to integrate Redis caching into existing server.js
 *
 * This file shows how to modify the existing server.js to use the new caching layer
 * without requiring a full TypeScript migration
 */

const cacheMiddleware = require('./cache-middleware');
const cacheIntegration = require('./cache-integration');

// At the top of server.js, after other requires:
async function initializeCache() {
    try {
        await cacheMiddleware.initializeRedis();
        console.log('✅ Redis cache initialized successfully');

        // Optional: Warm up cache on startup
        await cacheIntegration.warmupCache();
    } catch (error) {
        console.error('⚠️ Redis cache initialization failed, continuing without cache:', error.message);
    }
}

// Modify the existing getManagePageData function to use caching:
async function getManagePageDataCached(guildId, botGuild) {
    const cacheKey = `manage:${guildId}:data`;

    // Try to get from cache first
    return await cacheMiddleware.getCachedData(
        cacheKey,
        async () => {
            // This is your existing getManagePageData logic
            return await getManagePageData(guildId, botGuild);
        },
        cacheMiddleware.CACHE_TTL.MANAGE_PAGE_DATA // 60 seconds TTL
    );
}

// Example: Modify manage page routes to use caching
function setupCachedManageRoutes(app) {
    const managePages = [
        'streamers', 'teams', 'appearance', 'welcome', 'reaction-roles',
        // ... rest of your pages
    ];

    managePages.forEach(page => {
        app.get(`/manage/:guildId/${page}`, checkAuth, checkGuildAdmin, async (req, res) => {
            try {
                // Use cached version instead
                const data = await getManagePageDataCached(req.params.guildId, req.guildObject);
                res.render("manage-modern", {
                    ...data,
                    user: getSanitizedUser(req),
                    guild: sanitizeGuild(req.guildObject),
                    page: page
                });
            } catch (error) {
                logger.error(`[CRITICAL] Error rendering manage page '${page}':`, {
                    guildId: req.params.guildId,
                    error: error.message,
                    stack: error.stack
                });
                res.status(500).render("error", {
                    user: getSanitizedUser(req),
                    error: "Critical error loading server data."
                });
            }
        });
    });
}

// Example: Cache server list data
async function getServerListCached(userId, guilds, botClient) {
    const cacheKey = `servers:${userId}`;

    return await cacheMiddleware.getCachedData(
        cacheKey,
        async () => {
            // Enhanced guild data calculation
            let totalMembers = 0;
            let totalLiveStreams = 0;

            const enhancedGuilds = await Promise.all(guilds.map(async (guild) => {
                try {
                    const botGuild = botClient.guilds.cache.get(guild.id);
                    const memberCount = botGuild ? botGuild.memberCount : 0;
                    totalMembers += memberCount;

                    const [streamerRows] = await db.execute(
                        'SELECT COUNT(*) as count FROM streamers WHERE guild_id = ?',
                        [guild.id]
                    );
                    const streamerCount = streamerRows[0]?.count || 0;

                    const [liveRows] = await db.execute(
                        'SELECT COUNT(*) as count FROM live_announcements WHERE guild_id = ?',
                        [guild.id]
                    );
                    const liveCount = liveRows[0]?.count || 0;
                    totalLiveStreams += liveCount;

                    return {
                        ...guild,
                        memberCount,
                        streamerCount,
                        liveCount
                    };
                } catch (error) {
                    return {
                        ...guild,
                        memberCount: 0,
                        streamerCount: 0,
                        liveCount: 0
                    };
                }
            }));

            return {
                guilds: enhancedGuilds,
                totalMembers,
                totalLiveStreams
            };
        },
        cacheMiddleware.CACHE_TTL.SERVER_LIST // 30 seconds TTL
    );
}

// Example: Modify servers route to use caching
function setupCachedServersRoute(app, botClient) {
    app.get("/servers", checkAuth, async (req, res) => {
        try {
            const manageableGuilds = req.user.guilds.filter(g =>
                new PermissionsBitField(BigInt(g.permissions))
                    .has(PermissionsBitField.Flags.ManageGuild) &&
                botClient.guilds.cache.has(g.id)
            );

            const cachedData = await getServerListCached(
                req.user.id,
                manageableGuilds,
                botClient
            );

            res.render("servers-modern", {
                user: getSanitizedUser(req),
                guilds: cachedData.guilds,
                totalMembers: cachedData.totalMembers,
                totalLiveStreams: cachedData.totalLiveStreams,
                clientId: process.env.DASHBOARD_CLIENT_ID
            });
        } catch (error) {
            logger.error('[Dashboard] Error loading servers page:', error);
            res.status(500).render("error", {
                user: getSanitizedUser(req),
                error: "Failed to load servers"
            });
        }
    });
}

// Example: Cache live stream data
async function getLiveStreamsCached() {
    const cacheKey = 'livestreams:all';

    return await cacheMiddleware.getCachedData(
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

            return liveStreamersData.map(stream => ({
                ...stream,
                uptime: calculateUptime(stream.stream_started_at),
                url: getStreamUrl(stream.platform, stream.username)
            }));
        },
        cacheMiddleware.CACHE_TTL.LIVE_STREAMS // 15 seconds TTL
    );
}

// Example: Invalidate cache after data updates
function setupCacheInvalidation(app) {
    // Invalidate guild cache after settings update
    app.post("/manage/:guildId/update-settings", checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;

        try {
            // ... your existing update logic ...

            // Invalidate cache for this guild
            await cacheMiddleware.invalidateGuildCache(guildId);

            res.redirect(`/manage/${guildId}/settings?success=Settings updated.`);
        } catch (error) {
            logger.error('Failed to update settings:', error);
            res.redirect(`/manage/${guildId}/settings?error=Failed to update.`);
        }
    });

    // Invalidate cache after adding streamer
    app.post("/manage/:guildId/add-streamer", checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;

        try {
            // ... your existing add streamer logic ...

            // Invalidate both guild and live stream cache
            await cacheMiddleware.invalidateGuildCache(guildId);
            await cacheMiddleware.invalidateLiveStreamCache();

            res.redirect(`/manage/${guildId}/streamers?success=Streamer added.`);
        } catch (error) {
            logger.error('Failed to add streamer:', error);
            res.redirect(`/manage/${guildId}/streamers?error=Failed to add.`);
        }
    });

    // Invalidate cache after removing streamer
    app.post("/manage/:guildId/remove-streamer", checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;

        try {
            // ... your existing remove streamer logic ...

            // Invalidate both guild and live stream cache
            await cacheMiddleware.invalidateGuildCache(guildId);
            await cacheMiddleware.invalidateLiveStreamCache();

            res.redirect(`/manage/${guildId}/streamers?success=Streamer removed.`);
        } catch (error) {
            logger.error('Failed to remove streamer:', error);
            res.redirect(`/manage/${guildId}/streamers?error=Failed to remove.`);
        }
    });
}

// Example: Add cache statistics endpoint
function setupCacheStatsEndpoint(app) {
    app.get("/api/cache-stats", async (req, res) => {
        try {
            const stats = await cacheMiddleware.getCacheStats();
            res.json({
                success: true,
                cache: stats,
                ttl: cacheMiddleware.CACHE_TTL
            });
        } catch (error) {
            logger.error('Failed to get cache stats:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to get cache statistics'
            });
        }
    });
}

// Example: Graceful shutdown with cache cleanup
function setupGracefulShutdown() {
    process.on('SIGTERM', async () => {
        console.log('SIGTERM received, closing Redis connection...');
        await cacheMiddleware.closeRedis();
        process.exit(0);
    });

    process.on('SIGINT', async () => {
        console.log('SIGINT received, closing Redis connection...');
        await cacheMiddleware.closeRedis();
        process.exit(0);
    });
}

// Integration into main server startup
async function startServerWithCache(app, botClient) {
    // Initialize cache
    await initializeCache();

    // Setup cached routes
    setupCachedManageRoutes(app);
    setupCachedServersRoute(app, botClient);
    setupCacheInvalidation(app);
    setupCacheStatsEndpoint(app);
    setupGracefulShutdown();

    // Start server
    const PORT = process.env.DASHBOARD_PORT || 3000;
    app.listen(PORT, () => {
        console.log(`✅ Dashboard server running on port ${PORT} with Redis caching`);
    });
}

// Helper function to calculate uptime
function calculateUptime(startTime) {
    if (!startTime) return '0m';
    const diff = Date.now() - new Date(startTime).getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
}

// Helper function to get stream URL
function getStreamUrl(platform, username) {
    const platformLower = platform.toLowerCase();
    switch(platformLower) {
        case 'twitch':
            return `https://twitch.tv/${username}`;
        case 'youtube':
            return `https://youtube.com/@${username}`;
        case 'kick':
            return `https://kick.com/${username}`;
        case 'tiktok':
            return `https://tiktok.com/@${username}`;
        case 'trovo':
            return `https://trovo.live/${username}`;
        case 'facebook':
            return `https://facebook.com/${username}/live`;
        case 'instagram':
            return `https://instagram.com/${username}/live`;
        default:
            return '#';
    }
}

module.exports = {
    initializeCache,
    getManagePageDataCached,
    getServerListCached,
    getLiveStreamsCached,
    setupCachedManageRoutes,
    setupCachedServersRoute,
    setupCacheInvalidation,
    setupCacheStatsEndpoint,
    setupGracefulShutdown,
    startServerWithCache
};