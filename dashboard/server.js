import express from 'express';
import passport from 'passport';
import { Strategy as DiscordStrategy } from 'passport-discord';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { PermissionsBitField, EmbedBuilder } from 'discord.js';
import * as ejs from 'ejs';
import fs from 'fs';
import multer from 'multer';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { getInstalledVoices } from '../utils/piper-tts.js';
import { isSuperAdmin } from '../utils/constants.js';
import { csrfProtection, csrfToken } from '../utils/csrf-protection.js';
import { createSessionMiddleware, sessionActivityMiddleware } from './config/session.js';
import ebookRecordRouter from './routes/ebook-record.js';
import { invalidateMusicConfigCache } from '../utils/music_helpers.js';

dotenv.config();

/**
 * Get deduplicated server count from all bot clients
 * Used by both landing page and status API for consistency
 */
function getServerStats(mainClient) {
    const allGuildIds = new Set();
    let totalUsers = 0;

    // Add main bot guilds
    if (mainClient && mainClient.guilds) {
        mainClient.guilds.cache.forEach(guild => {
            if (!allGuildIds.has(guild.id)) {
                allGuildIds.add(guild.id);
                if (guild.memberCount) {
                    totalUsers += guild.memberCount;
                }
            }
        });
    }

    // Add custom bot guilds from botManager
    if (global.botManager && global.botManager.clients) {
        for (const [botId, botClient] of global.botManager.clients.entries()) {
            if (botClient && botClient.guilds && botClient.guilds.cache) {
                botClient.guilds.cache.forEach(guild => {
                    if (!allGuildIds.has(guild.id)) {
                        allGuildIds.add(guild.id);
                        if (guild.memberCount) {
                            totalUsers += guild.memberCount;
                        }
                    }
                });
            }
        }
    }

    return { guilds: allGuildIds.size, users: totalUsers };
}

// Make getServerStats available globally for status route
global.getServerStats = getServerStats;

// Configure multer for handling multipart/form-data
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Multer error handler
const handleMulterError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        logger.error('[Multer Error]', { error: err.message });
        return res.status(400).send(`Multer Error: ${err.message}`);
    } else if (err) {
        logger.error('[Upload Error]', { error: err.message });
        return res.status(500).send(`Upload Error: ${err.message}`);
    }
    next();
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.DASHBOARD_PORT || 3001;
let client;

function start(botClient) {
    client = botClient;

    // Make client available to API routes via app.locals
    app.locals.client = botClient;

    // Trust proxy for secure cookies behind reverse proxy (nginx/cloudflare)
    app.set('trust proxy', 1);

    // Disable ETag header
    app.set('etag', false);

    // Get real client IP (Cloudflare sets CF-Connecting-IP, bypasses trust proxy hop issues)
    const getClientIp = (req) => req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;

    // Security headers with Helmet
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
                scriptSrcAttr: ["'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
                fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
                imgSrc: ["'self'", "data:", "https:", "blob:"],
                connectSrc: ["'self'", "https://api.twitch.tv", "https://kick.com", "blob:"],
                mediaSrc: ["'self'", "blob:"],
                frameSrc: ["'none'"],
                objectSrc: ["'none'"],
                upgradeInsecureRequests: []
            }
        },
        crossOriginEmbedderPolicy: false, // Allow embedding images from external sources
        hsts: {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true
        }
    }));

    // Global rate limiter - 200 requests per minute per IP (pages only)
    const globalLimiter = rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 200,
        message: { error: 'Too many requests, please try again later' },
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: getClientIp,
        skip: (req) => {
            // Skip static assets and API routes (API has its own dedicated limiter)
            return req.path.startsWith('/css') ||
                   req.path.startsWith('/js') ||
                   req.path.startsWith('/images') ||
                   req.path.startsWith('/ebook') ||
                   req.path.startsWith('/api') ||
                   req.path.startsWith('/tokes-bot/api');
        }
    });
    app.use(globalLimiter);

    // Stricter rate limiter for auth endpoints - 10 requests per 15 minutes
    const authLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 10,
        message: { error: 'Too many authentication attempts, please try again later' },
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: getClientIp
    });
    app.use('/auth', authLimiter);
    app.use('/tokes-bot/auth', authLimiter);

    // API rate limiter - defined here, applied after passport so req.user is available
    const apiLimiter = rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 60,
        message: { error: 'API rate limit exceeded, please slow down' },
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: getClientIp,
        skip: (req) => req.user && isSuperAdmin(req.user.id)
    });

    // Session middleware with MySQL store for persistence and management
    const sessionMiddleware = createSessionMiddleware();
    app.use(sessionMiddleware);

    // Session activity tracking (timeouts, IP/user agent logging)
    app.use(sessionActivityMiddleware);

    // Passport configuration
    passport.serializeUser((user, done) => {
        done(null, user);
    });

    passport.deserializeUser((obj, done) => {
        done(null, obj);
    });

    passport.use(new DiscordStrategy({
        clientID: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID,
        clientSecret: process.env.DASHBOARD_CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET,
        callbackURL: process.env.DASHBOARD_CALLBACK_URL || process.env.DISCORD_CALLBACK_URL,
        scope: ['identify', 'guilds'],
        prompt: 'none'
    }, (accessToken, refreshToken, profile, done) => {
        profile.accessToken = accessToken;
        logger.info(`User ${profile.username} logged in with ${profile.guilds?.length || 0} guilds`);
        return done(null, profile);
    }));

    app.use(passport.initialize());
    app.use(passport.session());

    // Apply API rate limiter after passport so req.user is available for admin bypass
    app.use('/api', apiLimiter);
    app.use('/tokes-bot/api', apiLimiter);
    // Skip body parsing for multipart/form-data routes (handled by multer)
    app.use((req, res, next) => {
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            // Skip body parsing - multer will handle it
            return next();
        }
        // Apply body parsers for other content types
        express.json()(req, res, () => {
            express.urlencoded({ extended: true })(req, res, next);
        });
    });

    // CSRF Protection for state-changing requests
    // Exempt OAuth callbacks, webhooks, and API endpoints that use other auth
    app.use(csrfProtection({
        ignoreMethods: ['GET', 'HEAD', 'OPTIONS'],
        ignorePaths: [
            '/auth/discord/callback',
            '/tokes-bot/auth/twitch/callback',
            '/tokes-bot/auth/kick/callback',
            '/api/webhooks',
            '/api/webhooks/gitlab',
            '/api/status',
            '/api/ebook/record'
        ]
    }));

    // Make CSRF token available to all templates
    app.use(csrfToken);

    // Global request logger for debugging (only logs at debug level)
    app.use((req, res, next) => {
        if (req.method === 'POST') {
            logger.debug('[Dashboard POST]', { method: req.method, path: req.path, bodyKeys: Object.keys(req.body || {}) });
        }
        next();
    });

    // Middleware
    const checkAuth = async (req, res, next) => {
        if (req.isAuthenticated()) {
            // Set isSuperAdmin property for header navigation
            req.user.isSuperAdmin = isSuperAdmin(req.user.id);

            // Check if user has bot creator permissions
            try {
                const [permissions] = await pool.execute(
                    'SELECT can_create_bots, max_bots FROM bot_creator_permissions WHERE user_id = ?',
                    [req.user.id]
                );
                req.user.canCreateBots = permissions.length > 0 && permissions[0].can_create_bots === 1;
                req.user.maxBots = permissions[0]?.max_bots || null;
            } catch (error) {
                logger.error('[checkAuth] Error checking bot creator permissions:', error);
                req.user.canCreateBots = false;
                req.user.maxBots = null;
            }

            return next();
        }
        res.redirect('/auth/discord');
    };

    const checkGuildAdmin = (req, res, next) => {
        try {
            // Super-admin bypass - grant access to any guild
            if (isSuperAdmin(req.user.id)) {
                // Find guild in any bot
                let guildObject = null;
                if (global.botManager) {
                    const botClient = global.botManager.getClientForGuild(req.params.guildId);
                    guildObject = botClient?.guilds.cache.get(req.params.guildId);
                } else {
                    guildObject = client.guilds.cache.get(req.params.guildId);
                }

                if (!guildObject) {
                    return res.status(403).render('error-tailwind', {
                        user: req.user,
                        error: 'The bot is not in this server.'
                    });
                }

                req.guildObject = guildObject;
                req.isSuperAdmin = true;
                logger.info(`[Dashboard] Super-admin ${req.user.username} accessing guild ${guildObject.name} (${req.params.guildId})`);
                return next();
            }

            // Regular user permission check
            const guild = req.user.guilds.find(g => g.id === req.params.guildId);
            if (!guild || !new PermissionsBitField(BigInt(guild.permissions)).has(PermissionsBitField.Flags.ManageGuild)) {
                return res.status(403).render('error-tailwind', {
                    user: req.user,
                    error: 'You do not have permissions for this server.'
                });
            }

            // Check if ANY bot is in this guild
            let guildObject = null;
            if (global.botManager) {
                const botClient = global.botManager.getClientForGuild(req.params.guildId);
                guildObject = botClient?.guilds.cache.get(req.params.guildId);
            } else {
                guildObject = client.guilds.cache.get(req.params.guildId);
            }

            if (!guildObject) {
                return res.status(403).render('error-tailwind', {
                    user: req.user,
                    error: 'The bot is not in this server.'
                });
            }

            req.guildObject = guildObject;
            return next();
        } catch (e) {
            logger.error('[checkGuildAdmin Error]', e);
            res.status(500).render('error-tailwind', {
                user: req.user,
                error: 'An unexpected error occurred while checking permissions.'
            });
        }
    };

    // Serve static files
    app.use(express.static(path.join(__dirname, 'public')));

    // Serve ticket transcripts
    app.use('/transcripts', express.static(path.join(__dirname, '..', 'transcripts')));

    // Set view engine with custom wrapper to provide include function
    const viewsDir = path.join(__dirname, 'views');

    app.engine('ejs', async (filePath, options, callback) => {
        try {
            // Create include function that resolves relative paths from the calling file
            function makeInclude(callerFile) {
                return (templatePath, data = {}) => {
                    const ext = templatePath.endsWith('.ejs') ? '' : '.ejs';
                    const baseDir = callerFile ? path.dirname(callerFile) : viewsDir;
                    const fullPath = path.resolve(baseDir, templatePath + ext);
                    const template = fs.readFileSync(fullPath, 'utf8');
                    return ejs.render(template, { ...options, ...data, filename: fullPath, include: makeInclude(fullPath) });
                };
            }
            const includeFile = makeInclude(filePath);

            // Set required EJS options
            options.filename = filePath;
            options.views = [viewsDir];
            options.include = includeFile;

            const html = await ejs.renderFile(filePath, options);
            callback(null, html);
        } catch (error) {
            callback(error);
        }
    });
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    // Ebook recording upload (no auth required, large file support)
    app.use('/api/ebook', ebookRecordRouter);

    // Routes
    app.get('/', async (req, res) => {
        try {
            // Use shared function for consistent server count across all pages
            const stats = getServerStats(client);

            // Count actual commands
            const commandCount = client?.commands?.size || 0;

            res.render('landing-tailwind', {
                user: req.user,
                clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID,
                serverCount: stats.guilds,
                userCount: stats.users,
                commandCount: commandCount
            });
        } catch (error) {
            logger.error('[Landing Page] Error calculating server count:', error);
            // Fallback to main bot count
            res.render('landing-tailwind', {
                user: req.user,
                clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID,
                serverCount: client?.guilds?.cache?.size || 0,
                userCount: 0,
                commandCount: 0
            });
        }
    });

    app.get('/auth/discord', (req, res, next) => {
        if (req.query.returnTo) {
            req.session.returnTo = req.query.returnTo;
        }
        passport.authenticate('discord')(req, res, next);
    });

    app.get('/auth/discord/callback',
        passport.authenticate('discord', { failureRedirect: '/' }),
        (req, res) => {
            const returnTo = req.session.returnTo;
            delete req.session.returnTo;
            res.redirect(returnTo || '/dashboard');
        }
    );

    app.get('/logout', (req, res) => {
        req.logout(() => {
            res.redirect('/');
        });
    });
    // TikTok Analytics page (public - no auth required)
    app.get('/analytics/:username', async (req, res) => {
        try {
            const username = req.params.username.toLowerCase();

            // Find the streamer in our database
            const [streamers] = await pool.execute(
                `SELECT streamer_id, username, profile_image_url
                 FROM streamers
                 WHERE LOWER(username) = ? AND platform = 'tiktok'`,
                [username]
            );

            if (streamers.length === 0) {
                return res.status(404).render('error-tailwind', {
                    user: req.user || null,
                    error: `TikTok creator "${req.params.username}" not found in our database.`
                });
            }

            const streamer = streamers[0];

            // Get all tracked videos for this streamer
            const [videos] = await pool.execute(
                `SELECT video_id, video_url, title, description, thumbnail_url,
                        view_count, like_count, share_count, comment_count, posted_at
                 FROM tiktok_video_posts
                 WHERE streamer_id = ?
                 ORDER BY posted_at DESC
                 LIMIT 50`,
                [streamer.streamer_id]
            );

            // Calculate statistics
            const stats = {
                totalVideos: videos.length,
                totalViews: videos.reduce((sum, v) => sum + (v.view_count || 0), 0),
                totalLikes: videos.reduce((sum, v) => sum + (v.like_count || 0), 0),
                totalComments: videos.reduce((sum, v) => sum + (v.comment_count || 0), 0),
                totalShares: videos.reduce((sum, v) => sum + (v.share_count || 0), 0),
                avgEngagement: 0
            };

            // Calculate average engagement rate (likes + comments / views * 100)
            if (stats.totalViews > 0) {
                stats.avgEngagement = ((stats.totalLikes + stats.totalComments) / stats.totalViews * 100).toFixed(2);
            }

            // Calculate posting schedule
            const schedule = {
                byDay: [0, 0, 0, 0, 0, 0, 0], // Sun-Sat
                byHour: []
            };

            const hourCounts = {};
            videos.forEach(video => {
                if (video.posted_at) {
                    const date = new Date(video.posted_at);
                    schedule.byDay[date.getDay()]++;
                    const hour = date.getHours();
                    hourCounts[hour] = (hourCounts[hour] || 0) + 1;
                }
            });

            // Convert hour counts to sorted array
            schedule.byHour = Object.entries(hourCounts)
                .map(([hour, count]) => ({ hour: parseInt(hour), count }))
                .sort((a, b) => b.count - a.count);

            // Helper functions for the template
            const formatNumber = (num) => {
                if (!num) return '0';
                if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
                if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
                return num.toString();
            };

            const formatDate = (date) => {
                if (!date) return 'Unknown';
                return new Date(date).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric'
                });
            };

            res.render('tiktok-analytics', {
                user: req.user || null,
                username: streamer.username,
                avatar: streamer.profile_image_url,
                videos,
                stats,
                schedule,
                formatNumber,
                formatDate
            });

        } catch (error) {
            logger.error('[Analytics] Error loading TikTok analytics:', error);
            res.status(500).render('error-tailwind', {
                user: req.user || null,
                error: 'Error loading analytics page. Please try again later.'
            });
        }
    });

    // Bot management page (bot creators)
    app.get('/bot-management', checkAuth, async (req, res) => {
        try {
            // Check if user has bot creator permissions
            const [permissions] = await pool.execute(
                'SELECT can_create_bots FROM bot_creator_permissions WHERE user_id = ?',
                [req.user.id]
            );

            if (permissions.length === 0 || !permissions[0].can_create_bots) {
                return res.status(403).send('You do not have permission to manage custom bots. Contact the bot owner to request access.');
            }

            res.render('bot-management-tailwind', {
                user: req.user
            });
        } catch (error) {
            logger.error('[Bot Management Page] Error:', error);
            res.status(500).send('Error loading bot management page');
        }
    });

    // Profile page
    app.get('/profile', checkAuth, async (req, res) => {
        try {
            // Get user's guilds
            const userGuilds = req.user.guilds || [];
            const manageableGuilds = userGuilds.filter(guild =>
                (parseInt(guild.permissions) & 0x20) === 0x20 || (parseInt(guild.permissions) & 0x8) === 0x8
            );

            // Calculate total members and streamers across manageable guilds
            let totalMembers = 0;
            let totalStreamers = 0;

            for (const guild of manageableGuilds) {
                const botGuild = client.guilds.cache.get(guild.id);
                if (botGuild) {
                    totalMembers += botGuild.memberCount || 0;
                }
                // Count streamers for this guild
                try {
                    const [streamers] = await db.query('SELECT COUNT(*) as count FROM guild_streamers WHERE guild_id = ?', [guild.id]);
                    totalStreamers += streamers[0]?.count || 0;
                } catch (e) {}
            }

            res.render('profile-tailwind', {
                user: req.user,
                guilds: manageableGuilds,
                totalGuilds: manageableGuilds.length,
                totalStreamers,
                totalMembers
            });
        } catch (error) {
            logger.error('[Profile Page] Error:', error);
            res.status(500).send('Error loading profile page');
        }
    });

    // Super Admin page (bot owner only)
    app.get('/super-admin', checkAuth, async (req, res) => {
        try {
            // Only allow super admin (bot owner)
            if (!isSuperAdmin(req.user.id)) {
                return res.status(403).send('Super Admin access required');
            }

            res.render('super-admin-tailwind', {
                user: req.user
            });
        } catch (error) {
            logger.error('[Super Admin Page] Error:', error);
            res.status(500).send('Error loading super admin page');
        }
    });

    // Bot assignment page (bot creators can assign their own bots)
    app.get('/bot-management/assign/:botId', checkAuth, async (req, res) => {
        try {
            // Check if user has bot creator permissions
            const [permissions] = await pool.execute(
                'SELECT can_create_bots FROM bot_creator_permissions WHERE user_id = ?',
                [req.user.id]
            );

            if (permissions.length === 0 || !permissions[0].can_create_bots) {
                return res.status(403).send('You do not have permission to manage custom bots.');
            }

            // Verify user owns this bot
            const { botId } = req.params;
            const [bots] = await pool.execute(
                'SELECT bot_id FROM custom_bots WHERE bot_id = ? AND owner_user_id = ?',
                [botId, req.user.id]
            );

            if (bots.length === 0) {
                return res.status(403).send('You do not own this bot.');
            }

            // Get user's guilds where they have admin permission
            const userGuilds = req.user.guilds.filter(g =>
                new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.Administrator)
            );

            res.render('bot-assignment', {
                user: req.user,
                botId,
                userGuilds
            });
        } catch (error) {
            logger.error('[Bot Assignment Page] Error:', error);
            res.status(500).send('Error loading bot assignment page');
        }
    });

    // Server selection page (dashboard)
    app.get('/dashboard', checkAuth, async (req, res) => {
        try {
            let manageableGuilds;

            // Super-admin gets ALL bot guilds
            if (isSuperAdmin(req.user.id)) {
                manageableGuilds = [];
                const seenGuilds = new Set();

                // Get all guilds from all bots
                if (global.botManager) {
                    for (const [botId, botClient] of global.botManager.clients.entries()) {
                        botClient.guilds.cache.forEach(guild => {
                            // Avoid duplicates
                            if (!seenGuilds.has(guild.id)) {
                                seenGuilds.add(guild.id);
                                manageableGuilds.push({
                                    id: guild.id,
                                    name: guild.name,
                                    icon: guild.icon,
                                    permissions: '32', // Fake MANAGE_GUILD for display
                                    owner: false
                                });
                            }
                        });
                    }
                } else {
                    client.guilds.cache.forEach(guild => {
                        manageableGuilds.push({
                            id: guild.id,
                            name: guild.name,
                            icon: guild.icon,
                            permissions: '32',
                            owner: false
                        });
                    });
                }

                logger.info(`[Dashboard] Super-admin ${req.user.username} viewing ${manageableGuilds.length} total bot guilds`);
            } else {
                // Filter guilds where user has ManageGuild permission AND any bot is present
                manageableGuilds = req.user.guilds.filter(g => {
                    if (!new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild)) {
                        return false;
                    }

                    // Check if ANY bot (default or custom) is in this guild
                    if (global.botManager) {
                        for (const [botId, botClient] of global.botManager.clients.entries()) {
                            if (botClient.guilds.cache.has(g.id)) {
                                return true;
                            }
                        }
                        return false;
                    } else {
                        // Fallback to just checking default client
                        return client.guilds.cache.has(g.id);
                    }
                });
            }

            // Calculate totals
            let totalMembers = 0;
            let totalHumanMembers = 0;
            let totalBots = 0;

            // Get guild details from the appropriate bot
            for (const guildData of manageableGuilds) {
                let botGuild = null;

                // Find which bot is in this guild
                if (global.botManager) {
                    const botClient = global.botManager.getClientForGuild(guildData.id);
                    botGuild = botClient?.guilds.cache.get(guildData.id);
                } else {
                    botGuild = client.guilds.cache.get(guildData.id);
                }

                if (botGuild) {
                    const memberCount = botGuild.memberCount || 0;
                    // Approximate human count - bots are usually a small fraction
                    // Get actual bot count from cache if available
                    const botCount = botGuild.members?.cache?.filter(m => m.user.bot).size || 0;
                    const humanCount = Math.max(0, memberCount - botCount);

                    totalMembers += memberCount;
                    totalHumanMembers += humanCount;
                    totalBots += botCount;

                    guildData.memberCount = humanCount; // Show human members only
                    guildData.totalMemberCount = memberCount;
                    guildData.botCount = botCount;
                }
            }

            // Get live streamers count per guild and total
            let totalLiveStreams = 0;
            let totalStreamersTracked = 0;
            const livePerGuild = new Map();

            try {
                // For super admin, get ALL live streamers and streamers tracked
                if (isSuperAdmin(req.user.id)) {
                    // Get all live counts
                    const [allLive] = await pool.query(`
                        SELECT guild_id, COUNT(DISTINCT COALESCE(discord_user_id, CONCAT(platform, ':', username))) as live_count
                        FROM live_announcements
                        WHERE offline_check_count < 4
                        GROUP BY guild_id
                    `);

                    allLive.forEach(row => {
                        livePerGuild.set(row.guild_id, row.live_count);
                        totalLiveStreams += row.live_count;
                    });

                    // Get total streamers tracked across all guilds
                    const [allStreamers] = await pool.query(`SELECT COUNT(*) as total FROM streamers`);
                    totalStreamersTracked = allStreamers[0]?.total || 0;

                } else if (manageableGuilds.length > 0) {
                    const guildIds = manageableGuilds.map(g => g.id);
                    const placeholders = guildIds.map(() => '?').join(',');

                    // Get live count per guild
                    const [liveByGuild] = await pool.query(`
                        SELECT guild_id, COUNT(DISTINCT COALESCE(discord_user_id, CONCAT(platform, ':', username))) as live_count
                        FROM live_announcements
                        WHERE guild_id IN (${placeholders})
                        AND offline_check_count < 4
                        GROUP BY guild_id
                    `, guildIds);

                    liveByGuild.forEach(row => {
                        livePerGuild.set(row.guild_id, row.live_count);
                        totalLiveStreams += row.live_count;
                    });

                    // Get total streamers tracked
                    const [streamersTracked] = await pool.query(`
                        SELECT COUNT(*) as total
                        FROM streamers
                        WHERE guild_id IN (${placeholders})
                    `, guildIds);
                    totalStreamersTracked = streamersTracked[0]?.total || 0;
                }
            } catch (error) {
                logger.error('[Dashboard] Error fetching live streamers count:', error);
            }

            // Attach live count to each guild
            for (const guildData of manageableGuilds) {
                guildData.liveCount = livePerGuild.get(guildData.id) || 0;
            }

            // Fetch security feature status per guild
            const securityPerGuild = new Map();
            try {
                const [gbRows] = await pool.query('SELECT guild_id FROM global_ban_config WHERE enabled = 1');
                const [rpRows] = await pool.query('SELECT guild_id FROM raid_protection_config WHERE enabled = 1');
                const [arRows] = await pool.query('SELECT guild_id FROM anti_raid_config WHERE is_enabled = 1');
                const [rdRows] = await pool.query('SELECT guild_id FROM raid_detection_config WHERE enabled = 1');

                const gbSet = new Set(gbRows.map(r => r.guild_id));
                const rpSet = new Set(rpRows.map(r => r.guild_id));
                const arSet = new Set(arRows.map(r => r.guild_id));
                const rdSet = new Set(rdRows.map(r => r.guild_id));

                for (const guildData of manageableGuilds) {
                    const features = [];
                    if (gbSet.has(guildData.id)) features.push('Global Ban');
                    if (rpSet.has(guildData.id)) features.push('Raid Protection');
                    if (arSet.has(guildData.id)) features.push('Anti-Raid');
                    if (rdSet.has(guildData.id)) features.push('Raid Detection');
                    guildData.securityFeatures = features;
                    guildData.hasAnySecurity = features.length > 0;
                }
            } catch (error) {
                logger.error('[Dashboard] Error fetching security status:', error);
                for (const guildData of manageableGuilds) {
                    guildData.securityFeatures = [];
                    guildData.hasAnySecurity = false;
                }
            }

            res.render('servers-tailwind', {
                guilds: manageableGuilds,
                manageableGuilds,
                user: req.user,
                totalMembers,
                totalHumanMembers,
                totalBots,
                totalLiveStreams,
                totalStreamersTracked,
                clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID
            });
        } catch (error) {
            logger.error('[/dashboard Error]', error);
            res.render('servers-tailwind', {
                guilds: [],
                manageableGuilds: [],
                user: req.user,
                totalMembers: 0,
                totalHumanMembers: 0,
                totalBots: 0,
                totalLiveStreams: 0,
                totalStreamersTracked: 0,
                clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID
            });
        }
    });

    // Log all POST requests to manage routes (debug level)
    app.use('/manage*', (req, res, next) => {
        if (req.method === 'POST') {
            logger.debug('[Manage POST]', { url: req.originalUrl, contentType: req.headers['content-type'], bodyKeys: Object.keys(req.body || {}) });
        }
        next();
    });

    // Server management page
    app.get('/manage/:guildId', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const guild = req.guildObject;

            // Use cached roles and channels (already loaded by Discord.js)
            const allRoles = guild.roles.cache;
            const allChannels = guild.channels.cache;

            // Fetch channel settings from database
            const [channelSettingsRows] = await pool.execute(
                'SELECT * FROM channel_settings WHERE guild_id = ?',
                [guildId]
            );

            // Create a Map for easy lookup
            const channelSettingsMap = new Map();
            channelSettingsRows.forEach(row => {
                channelSettingsMap.set(row.channel_id, row);
            });

            // Fetch logging configuration
            const [loggingConfigRows] = await pool.execute(
                'SELECT * FROM logging_config WHERE guild_id = ?',
                [guildId]
            );
            const logConfigRaw = loggingConfigRows[0] || {};

            // Fetch log event configs (individual category settings)
            const [logEventConfigRows] = await pool.execute(
                'SELECT * FROM log_event_config WHERE guild_id = ?',
                [guildId]
            );

            // Build category channels map from log_event_config
            const categoryChannels = {};
            logEventConfigRows.forEach(row => {
                if (row.log_channel_id) {
                    categoryChannels[row.event_type] = row.log_channel_id;
                }
            });

            // Format logConfig for the template
            const logConfig = {
                log_channel_id: logConfigRaw.log_channel_id || null,
                enabled_logs: logConfigRaw.enabled_events || '[]',
                log_categories: JSON.stringify(categoryChannels)
            };

            // Fetch analytics data
            const analyticsData = {
                totalMembers: guild.memberCount || 0,
                onlineMembers: 0,
                avgMessagesPerDay: 0,
                totalMessages: 0,
                memberJoins: 0,
                memberLeaves: 0
            };

            // Get online members count (use cache only, no API call)
            try {
                analyticsData.onlineMembers = guild.members.cache.filter(m => m.presence?.status === 'online').size;
            } catch (error) {
                logger.error('Error counting online members:', error);
            }

            // Get message statistics (last 30 days)
            try {
                const [messageStats] = await pool.execute(
                    `SELECT
                        COUNT(DISTINCT log_date) as days_with_activity,
                        SUM(count) as total_messages
                     FROM activity_logs
                     WHERE guild_id = ?
                     AND type = 'message'
                     AND log_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`,
                    [guildId]
                );

                if (messageStats.length > 0 && messageStats[0].total_messages) {
                    analyticsData.totalMessages = parseInt(messageStats[0].total_messages) || 0;
                    const daysWithActivity = parseInt(messageStats[0].days_with_activity) || 1;
                    analyticsData.avgMessagesPerDay = Math.round(analyticsData.totalMessages / Math.max(daysWithActivity, 1));
                }
            } catch (error) {
                logger.error('Error fetching message stats:', error);
            }

            // Get member join/leave statistics (last 30 days)
            try {
                const [memberStats] = await pool.execute(
                    `SELECT
                        event_type,
                        COUNT(*) as count
                     FROM member_logs
                     WHERE guild_id = ?
                     AND timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY)
                     GROUP BY event_type`,
                    [guildId]
                );

                memberStats.forEach(stat => {
                    if (stat.event_type === 'JOIN') {
                        analyticsData.memberJoins = parseInt(stat.count) || 0;
                    } else if (stat.event_type === 'LEAVE') {
                        analyticsData.memberLeaves = parseInt(stat.count) || 0;
                    }
                });
            } catch (error) {
                logger.error('Error fetching member stats:', error);
            }

            // Get daily server stats for charts (last 30 days)
            const serverStats = [];
            try {
                // Get daily message counts
                const [dailyMessages] = await pool.execute(
                    `SELECT
                        log_date as date,
                        SUM(count) as message_count
                     FROM activity_logs
                     WHERE guild_id = ?
                     AND type = 'message'
                     AND log_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                     GROUP BY log_date
                     ORDER BY log_date ASC`,
                    [guildId]
                );

                // Create a map of dates to message counts
                const messageMap = new Map();
                dailyMessages.forEach(row => {
                    messageMap.set(row.date.toISOString().split('T')[0], parseInt(row.message_count) || 0);
                });

                // Generate stats for last 30 days
                const currentMemberCount = guild.memberCount || 0;
                for (let i = 29; i >= 0; i--) {
                    const date = new Date();
                    date.setDate(date.getDate() - i);
                    const dateStr = date.toISOString().split('T')[0];

                    serverStats.push({
                        date: dateStr,
                        total_members: currentMemberCount, // We'll use current count (can be enhanced later with historical tracking)
                        online_members: i === 0 ? analyticsData.onlineMembers : 0, // Only show current online for today
                        message_count: messageMap.get(dateStr) || 0
                    });
                }
            } catch (error) {
                logger.error('Error fetching daily server stats:', error);
            }

            // Load music config from database
            let musicConfig = {};
            try {
                const [musicRows] = await pool.execute(
                    'SELECT * FROM music_config WHERE guild_id = ?',
                    [guildId]
                );
                if (musicRows && musicRows.length > 0) {
                    musicConfig = musicRows[0];
                }
            } catch (error) {
                logger.error('Error loading music config:', error);
            }

            // Fetch streamers and subscriptions
            let consolidatedStreamers = [];
            let totalSubscriptions = 0;
            try {
                const [streamersData] = await pool.execute(
                    `SELECT
                        s.streamer_id, s.platform, s.username, s.platform_user_id, s.discord_user_id,
                        sub.subscription_id, sub.announcement_channel_id, sub.live_role_id,
                        sub.custom_message, sub.delete_on_end, sub.override_nickname, sub.override_avatar_url,
                        sub.team_subscription_id, sub.notify_videos, sub.video_announcement_channel_id,
                        (SELECT COUNT(*) FROM live_announcements WHERE streamer_id = s.streamer_id AND guild_id = ? AND offline_check_count < 4) as is_live
                    FROM subscriptions sub
                    JOIN streamers s ON sub.streamer_id = s.streamer_id
                    WHERE sub.guild_id = ?
                    ORDER BY s.username`,
                    [guildId, guildId]
                );

                // Transform flat data into grouped structure
                // Group by discord_user_id if available, otherwise by streamer_id
                // Display name priority: discord username > twitch > kick > other
                const platformPriority = { twitch: 2, kick: 1 }; // discord resolved separately as 3
                const streamerMap = new Map();
                streamersData.forEach(row => {
                    // Use discord_user_id for grouping if available, otherwise use streamer_id
                    const groupKey = row.discord_user_id || `streamer_${row.streamer_id}`;

                    if (!streamerMap.has(groupKey)) {
                        streamerMap.set(groupKey, {
                            id: row.streamer_id, // Primary streamer ID for this group
                            name: row.username,
                            username: row.username,
                            _namePriority: platformPriority[row.platform] || 0,
                            discord_user_id: row.discord_user_id,
                            platforms: [row.platform],
                            subscriptions: [],
                            is_live: row.is_live > 0,
                            is_blacklisted: false
                        });
                    }
                    const streamer = streamerMap.get(groupKey);
                    if (!streamer.platforms.includes(row.platform)) {
                        streamer.platforms.push(row.platform);
                    }
                    // Update display name if this platform has higher priority
                    const rowPriority = platformPriority[row.platform] || 0;
                    if (rowPriority > streamer._namePriority) {
                        streamer.name = row.username;
                        streamer.username = row.username;
                        streamer._namePriority = rowPriority;
                    }
                    streamer.subscriptions.push({
                        subscription_id: row.subscription_id,
                        streamer_id: row.streamer_id,
                        platform: row.platform,
                        platform_username: row.username, // Add platform-specific username
                        announcement_channel_id: row.announcement_channel_id,
                        live_role_id: row.live_role_id,
                        custom_message: row.custom_message,
                        delete_on_end: row.delete_on_end,
                        override_nickname: row.override_nickname,
                        override_avatar_url: row.override_avatar_url || null,
                        team_subscription_id: row.team_subscription_id,
                        notify_videos: row.notify_videos,
                        video_announcement_channel_id: row.video_announcement_channel_id
                    });
                });

                // Resolve Discord usernames (highest priority) from guild member cache
                for (const streamer of streamerMap.values()) {
                    if (streamer.discord_user_id) {
                        const member = guild.members.cache.get(streamer.discord_user_id);
                        if (member) {
                            streamer.name = member.user.username;
                            streamer.username = member.user.username;
                        }
                    }
                    delete streamer._namePriority;
                }

                consolidatedStreamers = Array.from(streamerMap.values());
                totalSubscriptions = streamersData.length;
            } catch (error) {
                logger.error('Error fetching streamers:', error);
            }

            // Fetch team subscriptions
            let teamSubscriptions = [];
            try {
                const [teamsData] = await pool.execute(
                    `SELECT id, guild_id, team_name, announcement_channel_id, live_role_id,
                            webhook_name, webhook_avatar_url
                     FROM twitch_teams
                     WHERE guild_id = ?
                     ORDER BY team_name`,
                    [guildId]
                );
                teamSubscriptions = teamsData;
            } catch (error) {
                logger.error('Error fetching teams:', error);
            }

            // Fetch guild settings (timezone, prefix, language)
            let guildSettings = {};
            try {
                const [settingsData] = await pool.execute(
                    'SELECT * FROM guild_settings WHERE guild_id = ?',
                    [guildId]
                );
                if (settingsData.length > 0) {
                    guildSettings = settingsData[0];
                }
            } catch (error) {
                logger.error('Error fetching guild settings:', error);
            }

            // Fetch guild config (live_role_id, announcement_channel_id)
            let guildConfig = {};
            try {
                const [configData] = await pool.execute(
                    'SELECT * FROM guilds WHERE guild_id = ?',
                    [guildId]
                );
                if (configData.length > 0) {
                    guildConfig = configData[0];
                }

                // Also load appearance settings from guild_config table
                const [appearanceData] = await pool.execute(
                    'SELECT bot_nickname, bot_avatar_url, embed_color FROM guild_config WHERE guild_id = ?',
                    [guildId]
                );
                if (appearanceData.length > 0) {
                    // Merge appearance settings into guildConfig
                    guildConfig.bot_nickname = appearanceData[0].bot_nickname || guildConfig.bot_nickname;
                    guildConfig.bot_avatar_url = appearanceData[0].bot_avatar_url;
                    guildConfig.embed_color = appearanceData[0].embed_color || '#a78bfa';
                }
            } catch (error) {
                logger.error('Error fetching guild config:', error);
            }

            // Fetch suggestion config
            let suggestionConfig = {};
            try {
                const [suggestionData] = await pool.execute(
                    'SELECT * FROM suggestion_config WHERE guild_id = ?',
                    [guildId]
                );
                if (suggestionData.length > 0) {
                    suggestionConfig = suggestionData[0];
                }
            } catch (error) {
                logger.error('Error fetching suggestion config:', error);
            }

            // Fetch leveling config
            let levelingConfig = {};
            try {
                const [levelingData] = await pool.execute(
                    'SELECT * FROM level_config WHERE guild_id = ?',
                    [guildId]
                );
                if (levelingData.length > 0) {
                    levelingConfig = levelingData[0];
                }
            } catch (error) {
                logger.error('Error fetching leveling config:', error);
            }

            // Fetch suggestions
            let suggestions = [];
            try {
                const [suggestionsData] = await pool.execute(
                    'SELECT * FROM suggestions WHERE guild_id = ? ORDER BY created_at DESC LIMIT 50',
                    [guildId]
                );
                suggestions = suggestionsData;
            } catch (error) {
                logger.error('Error fetching suggestions:', error);
            }

            // Merge settings
            const settings = {
                ...guildSettings,
                live_role_id: guildConfig.live_role_id,
                announcement_channel_id: guildConfig.announcement_channel_id,
                announcement_message: guildConfig.announcement_message,
                use_webhook_persona: guildConfig.use_webhook_persona,
                leveling_enabled: levelingConfig.enabled,
                leveling_xp_rate: levelingConfig.xp_per_message,
                leveling_xp_cooldown: levelingConfig.xp_cooldown_seconds,
                level_up_channel_id: levelingConfig.level_up_channel_id,
                leveling_ignored_channels: levelingConfig.ignored_channels ? JSON.parse(levelingConfig.ignored_channels) : [],
                leveling_ignored_roles: levelingConfig.ignored_roles ? JSON.parse(levelingConfig.ignored_roles) : [],
                // Appearance settings from guild_config
                bot_nickname: guildConfig.bot_nickname,
                bot_avatar_url: guildConfig.bot_avatar_url,
                embed_color: guildConfig.embed_color
            };

            // Fetch Twitch schedule syncs
            let twitchScheduleSyncs = [];
            try {
                const [syncsData] = await pool.execute(
                    'SELECT id, streamer_id, discord_channel_id as channel_id, is_enabled FROM twitch_schedule_sync_config WHERE guild_id = ?',
                    [guildId]
                );
                twitchScheduleSyncs = syncsData;
            } catch (error) {
                logger.error('Error fetching Twitch schedule syncs:', error);
            }

            // Fetch temp channel configuration
            let tempChannelConfig = {};
            try {
                const [tempChannelData] = await pool.execute(
                    'SELECT * FROM temp_channel_config WHERE guild_id = ?',
                    [guildId]
                );
                tempChannelConfig = tempChannelData[0] || {};
                logger.info('[GET /manage/:guildId] Temp channel config:', tempChannelConfig);
            } catch (error) {
                logger.error('Error fetching temp channel config:', error);
            }

            // Fetch ticket panels
            let ticketPanels = [];
            try {
                const [panelsData] = await pool.execute(
                    'SELECT * FROM ticket_panels WHERE guild_id = ? ORDER BY created_at DESC',
                    [guildId]
                );
                ticketPanels = panelsData;
                logger.info('[GET /manage/:guildId] Loaded ticket panels:', ticketPanels.length);
            } catch (error) {
                logger.error('Error fetching ticket panels:', error);
                ticketPanels = [];
            }

            // Fetch polls
            let polls = [];
            try {
                const [pollsData] = await pool.execute(
                    'SELECT * FROM polls WHERE guild_id = ? ORDER BY id DESC',
                    [guildId]
                );
                polls = pollsData;
                logger.info('[GET /manage/:guildId] Loaded polls:', polls.length);
            } catch (error) {
                logger.error('Error fetching polls:', error);
                polls = [];
            }

            // Fetch welcome settings
            let welcomeSettings = {};
            try {
                const [welcomeData] = await pool.execute(
                    'SELECT * FROM welcome_settings WHERE guild_id = ?',
                    [guildId]
                );
                welcomeSettings = welcomeData[0] || {};
            } catch (error) {
                logger.error('Error fetching welcome settings:', error);
            }

            // Fetch autoroles config
            let autorolesConfig = {
                is_enabled: 0,
                roles_to_assign: []
            };
            try {
                const [autorolesData] = await pool.execute(
                    'SELECT * FROM autoroles_config WHERE guild_id = ?',
                    [guildId]
                );
                if (autorolesData.length > 0) {
                    autorolesConfig = autorolesData[0];
                    // Parse roles_to_assign JSON string to array
                    if (autorolesConfig.roles_to_assign) {
                        try {
                            autorolesConfig.roles_to_assign = JSON.parse(autorolesConfig.roles_to_assign);
                        } catch (e) {
                            logger.error('Error parsing autoroles JSON:', e);
                            autorolesConfig.roles_to_assign = [];
                        }
                    } else {
                        autorolesConfig.roles_to_assign = [];
                    }
                } else {
                    // No config found, use defaults
                    autorolesConfig = {
                        is_enabled: 0,
                        roles_to_assign: []
                    };
                }
            } catch (error) {
                logger.error('Error fetching autoroles config:', error);
                autorolesConfig = {
                    is_enabled: 0,
                    roles_to_assign: []
                };
            }

            // Fetch autopublisher config
            let autoPublisherConfig = {
                is_enabled: 0
            };
            try {
                const [autoPublisherData] = await pool.execute(
                    'SELECT * FROM auto_publisher_config WHERE guild_id = ?',
                    [guildId]
                );
                if (autoPublisherData.length > 0) {
                    autoPublisherConfig = autoPublisherData[0];
                } else {
                    autoPublisherConfig = {
                        is_enabled: 0
                    };
                }
            } catch (error) {
                logger.error('Error fetching autopublisher config:', error);
                autoPublisherConfig = {
                    is_enabled: 0
                };
            }

            // Fetch forms with question and submission counts
            let forms = [];
            try {
                const [formsData] = await pool.execute(`
                    SELECT
                        f.*,
                        (SELECT COUNT(*) FROM form_questions WHERE form_id = f.form_id) as question_count,
                        (SELECT COUNT(*) FROM form_submissions WHERE form_id = f.form_id) as submission_count
                    FROM forms f
                    WHERE f.guild_id = ?
                    ORDER BY f.created_at DESC
                `, [guildId]);
                forms = formsData;
            } catch (error) {
                logger.error('Error fetching forms:', error);
                forms = [];
            }

            // Fetch starboard configuration
            let starboardConfig = {};
            try {
                const [starboardData] = await pool.execute(
                    'SELECT * FROM starboard_config WHERE guild_id = ?',
                    [guildId]
                );
                if (starboardData.length > 0) {
                    starboardConfig = starboardData[0];
                    // Map star_threshold to threshold for template compatibility
                    if (starboardConfig.star_threshold !== undefined) {
                        starboardConfig.threshold = starboardConfig.star_threshold;
                    }
                }
            } catch (error) {
                logger.error('Error fetching starboard config:', error);
                starboardConfig = {};
            }

            // Fetch reaction role panels with mappings
            let reactionRolePanels = [];
            try {
                const [panelsData] = await pool.execute(
                    'SELECT * FROM reaction_role_panels WHERE guild_id = ? ORDER BY id DESC',
                    [guildId]
                );

                // Fetch mappings for each panel
                for (const panel of panelsData) {
                    const [mappingsData] = await pool.execute(
                        'SELECT * FROM reaction_role_mappings WHERE panel_id = ? ORDER BY id ASC',
                        [panel.id]
                    );
                    panel.mappings = mappingsData;
                }

                reactionRolePanels = panelsData;
            } catch (error) {
                logger.error('Error fetching reaction role panels:', error);
                reactionRolePanels = [];
            }

            // Fetch Raid Detection config (Sery feature)
            let raidConfig = {};
            try {
                const [raidData] = await pool.execute(
                    'SELECT * FROM raid_detection_config WHERE guild_id = ?',
                    [guildId]
                );
                if (raidData.length > 0) {
                    raidConfig = raidData[0];
                    // Parse JSON fields
                    if (raidConfig.whitelist_roles) {
                        try {
                            raidConfig.whitelist_roles = JSON.parse(raidConfig.whitelist_roles);
                        } catch (e) {
                            raidConfig.whitelist_roles = [];
                        }
                    } else {
                        raidConfig.whitelist_roles = [];
                    }
                }
            } catch (error) {
                logger.error('Error fetching raid detection config:', error);
            }

            // Fetch Raid Incidents (Sery feature)
            let raidIncidents = [];
            try {
                const [incidentsData] = await pool.execute(
                    'SELECT * FROM raid_incidents WHERE guild_id = ? ORDER BY detected_at DESC LIMIT 20',
                    [guildId]
                );
                raidIncidents = incidentsData;
            } catch (error) {
                logger.error('Error fetching raid incidents:', error);
            }

            // Fetch Self-Bot Detection config (Sery feature)
            let selfbotConfig = {};
            try {
                const [selfbotData] = await pool.execute(
                    'SELECT * FROM selfbot_detection_config WHERE guild_id = ?',
                    [guildId]
                );
                if (selfbotData.length > 0) {
                    selfbotConfig = selfbotData[0];
                    // Parse JSON fields
                    if (selfbotConfig.exempt_roles) {
                        try {
                            selfbotConfig.exempt_roles = JSON.parse(selfbotConfig.exempt_roles);
                        } catch (e) {
                            selfbotConfig.exempt_roles = [];
                        }
                    } else {
                        selfbotConfig.exempt_roles = [];
                    }
                }
            } catch (error) {
                logger.error('Error fetching selfbot detection config:', error);
            }

            // Fetch Self-Bot Detections (Sery feature)
            let selfbotDetections = [];
            try {
                const [detectionsData] = await pool.execute(
                    'SELECT * FROM selfbot_detections WHERE guild_id = ? ORDER BY detected_at DESC LIMIT 20',
                    [guildId]
                );
                selfbotDetections = detectionsData;
            } catch (error) {
                logger.error('Error fetching selfbot detections:', error);
            }

            // Fetch Adaptive Spam config (Sery feature)
            let adaptiveSpamConfig = {};
            try {
                const [spamData] = await pool.execute(
                    'SELECT * FROM adaptive_spam_config WHERE guild_id = ?',
                    [guildId]
                );
                if (spamData.length > 0) {
                    adaptiveSpamConfig = spamData[0];
                }
            } catch (error) {
                logger.error('Error fetching adaptive spam config:', error);
            }

            // Fetch giveaways
            let giveaways = [];
            try {
                const [rows] = await pool.execute(
                    'SELECT * FROM giveaways WHERE guild_id = ? ORDER BY ends_at DESC',
                    [guildId]
                );
                giveaways = rows;
            } catch (error) {
                if (error.code !== 'ER_NO_SUCH_TABLE') {
                    logger.error('Error fetching giveaways:', error);
                }
            }

            res.render('manage-tailwind', {
                user: req.user,
                guild: guild,
                page: req.query.page || 'overview',
                roles: Array.from(allRoles.filter(r => !r.managed && r.name !== '@everyone').values()),
                channels: Array.from(allChannels.filter(c => c.isTextBased()).values()),
                voiceChannels: Array.from(allChannels.filter(c => c.isVoiceBased()).values()),
                categories: Array.from(allChannels.filter(c => c.type === 4).values()),
                // Streamers and Teams
                consolidatedStreamers: consolidatedStreamers,
                teamSubscriptions: teamSubscriptions,
                channelsData: {},
                totalSubscriptions: totalSubscriptions,
                // Settings
                settings: settings,
                channelSettings: channelSettingsRows,
                channelSettingsMap: channelSettingsMap,
                // Community Features
                welcomeSettings: welcomeSettings,
                reactionRolePanels: reactionRolePanels,
                starboardConfig: starboardConfig,
                roleRewards: [],
                giveaways: giveaways,
                polls: [],
                suggestions: suggestions,
                suggestionConfig: suggestionConfig,
                suggestionStats: {},
                suggestionTags: [],
                // Music
                musicQueues: [],
                musicConfig: musicConfig,
                nowPlaying: {},
                voiceConnections: {},
                // Moderation
                moderationConfig: await (async () => {
                    try {
                        const [rows] = await pool.execute(
                            'SELECT * FROM moderation_config WHERE guild_id = ?',
                            [guildId]
                        );
                        return rows[0] || {};
                    } catch (error) {
                        logger.error('Error fetching moderation config:', error);
                        return {};
                    }
                })(),
                recentInfractions: await (async () => {
                    try {
                        const [rows] = await pool.execute(
                            'SELECT * FROM infractions WHERE guild_id = ? ORDER BY created_at DESC LIMIT 20',
                            [guildId]
                        );
                        return rows;
                    } catch (error) {
                        logger.error('Error fetching recent infractions:', error);
                        return [];
                    }
                })(),
                escalationRules: await (async () => {
                    try {
                        const [rows] = await pool.execute(
                            'SELECT * FROM escalation_rules WHERE guild_id = ? ORDER BY infraction_count ASC',
                            [guildId]
                        );
                        return rows;
                    } catch (error) {
                        logger.error('Error fetching escalation rules:', error);
                        return [];
                    }
                })(),
                automodRules: await (async () => {
                    try {
                        const [rows] = await pool.execute(
                            'SELECT * FROM automod_rules WHERE guild_id = ? ORDER BY id DESC',
                            [guildId]
                        );
                        return rows.map(rule => ({
                            ...rule,
                            config: typeof rule.config === 'string' ? JSON.parse(rule.config) : rule.config
                        }));
                    } catch (error) {
                        logger.error('Error fetching automod rules:', error);
                        return [];
                    }
                })(),
                heatConfig: {},
                joinGateConfig: await (async () => {
                    try {
                        const [rows] = await pool.execute(
                            'SELECT * FROM join_gate_config WHERE guild_id = ?',
                            [guildId]
                        );
                        if (rows[0]) {
                            return {
                                enabled: rows[0].is_enabled,
                                role_id: rows[0].verification_role_id
                            };
                        }
                        return {};
                    } catch (error) {
                        logger.error('Error fetching join gate config:', error);
                        return {};
                    }
                })(),
                antiRaidConfig: await (async () => {
                    try {
                        const [rows] = await pool.execute(
                            'SELECT * FROM anti_raid_config WHERE guild_id = ?',
                            [guildId]
                        );
                        if (rows[0]) {
                            return {
                                enabled: rows[0].is_enabled,
                                threshold: rows[0].join_limit,
                                time_period: rows[0].time_period_seconds,
                                action: rows[0].action
                            };
                        }
                        return {};
                    } catch (error) {
                        logger.error('Error fetching anti-raid config:', error);
                        return {};
                    }
                })(),
                antiNukeConfig: await (async () => {
                    try {
                        const [rows] = await pool.execute(
                            'SELECT * FROM anti_nuke_config WHERE guild_id = ?',
                            [guildId]
                        );
                        if (rows[0]) {
                            return {
                                enabled: rows[0].enabled
                            };
                        }
                        return {};
                    } catch (error) {
                        logger.error('Error fetching anti-nuke config:', error);
                        return {};
                    }
                })(),
                quarantineConfig: {},
                globalBanConfig: await (async () => {
                    try {
                        const [rows] = await pool.execute(
                            'SELECT * FROM global_ban_config WHERE guild_id = ?',
                            [guildId]
                        );
                        if (rows[0]) {
                            if (rows[0].exempt_roles) {
                                try {
                                    rows[0].exempt_roles = JSON.parse(rows[0].exempt_roles);
                                } catch (e) {
                                    rows[0].exempt_roles = [];
                                }
                            } else {
                                rows[0].exempt_roles = [];
                            }
                            return rows[0];
                        }
                        return {};
                    } catch (error) {
                        logger.error('Error fetching global ban config:', error);
                        return {};
                    }
                })(),
                statroleConfigs: [],
                logConfig: logConfig,
                auditLogs: [],
                // Economy & Games
                economyConfig: {},
                shopItems: [],
                economyStats: {},
                topUsers: [],
                triviaQuestions: [],
                hangmanWords: [],
                countingChannels: [],
                gameStats: {},
                gamblingConfig: {},
                gamblingHistory: [],
                gamblingStats: {},
                topGamblers: [],
                activeTrades: [],
                tradeHistory: [],
                tradeStats: {},
                // RPG
                rpgStats: await (async () => {
                    try {
                        const [[stats]] = await pool.execute(`
                            SELECT
                                COUNT(*) as totalCharacters,
                                COUNT(DISTINCT user_id) as activePlayers
                            FROM dnd_characters
                            WHERE guild_id = ?
                        `, [guildId]);

                        // Battles fought - placeholder for now (could track in separate table)
                        const battlesFought = 0;

                        // Get quests completed (if quest log exists)
                        let questsCompleted = 0;
                        try {
                            const [[questStats]] = await pool.execute(`
                                SELECT COUNT(*) as completed
                                FROM dnd_quest_log
                                WHERE guild_id = ? AND status = 'completed'
                            `, [guildId]);
                            questsCompleted = questStats.completed || 0;
                        } catch (err) {
                            // Quest log table might not exist
                            questsCompleted = 0;
                        }

                        // Get top players for leaderboard
                        let topPlayers = [];
                        try {
                            const [players] = await pool.execute(`
                                SELECT character_name, class, level, experience
                                FROM dnd_characters
                                WHERE guild_id = ?
                                ORDER BY level DESC, experience DESC
                                LIMIT 10
                            `, [guildId]);
                            topPlayers = players;
                        } catch (err) {
                            topPlayers = [];
                        }

                        return {
                            totalCharacters: stats.totalCharacters || 0,
                            activePlayers: stats.activePlayers || 0,
                            questsCompleted,
                            battlesFought,
                            topPlayers
                        };
                    } catch (error) {
                        logger.error('Error fetching RPG stats:', error);
                        return {
                            totalCharacters: 0,
                            activePlayers: 0,
                            questsCompleted: 0,
                            battlesFought: 0,
                            topPlayers: []
                        };
                    }
                })(),
                rpgCharacters: await (async () => {
                    try {
                        const [chars] = await pool.execute(`
                            SELECT * FROM dnd_characters
                            WHERE guild_id = ?
                            ORDER BY level DESC, experience DESC
                            LIMIT 20
                        `, [guildId]);
                        return chars;
                    } catch (error) {
                        logger.error('Error fetching RPG characters:', error);
                        return [];
                    }
                })(),
                // Birthday & Weather
                birthdayUsers: [],
                birthdayStats: {},
                birthdayConfig: {},
                weatherStats: await (async () => {
                    try {
                        const [[userCountResult]] = await pool.execute(
                            'SELECT COUNT(DISTINCT user_id) as count FROM user_alert_zones WHERE guild_id = ?',
                            [guildId]
                        );
                        const [[activeAlertsResult]] = await pool.execute(
                            'SELECT COUNT(*) as count FROM weather_alerts WHERE expires_at > NOW()',
                            []
                        );
                        const [[alertsSentResult]] = await pool.execute(
                            'SELECT COUNT(*) as count FROM weather_alerts WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)',
                            []
                        );
                        return {
                            totalUsers: userCountResult?.count || 0,
                            activeAlerts: activeAlertsResult?.count || 0,
                            alertsSent: alertsSentResult?.count || 0
                        };
                    } catch (error) {
                        logger.error('Error fetching weather stats:', error);
                        return {};
                    }
                })(),
                weatherConfig: await (async () => {
                    try {
                        const [[config]] = await pool.execute(
                            'SELECT * FROM weather_config WHERE guild_id = ?',
                            [guildId]
                        );
                        return config || {};
                    } catch (error) {
                        logger.error('Error fetching weather config:', error);
                        return {};
                    }
                })(),
                // Misc
                events: [],
                backups: [],
                permissionOverrides: [],
                reminders: [],
                tags: [],
                // Additional variables
                twitchScheduleSyncs: twitchScheduleSyncs,
                availableDJVoices: (() => {
                    // Locale to category mapping
                    const localeCategories = {
                        'en_US': 'US English',
                        'en_GB': 'British English',
                        'ar_JO': 'Arabic',
                        'ca_ES': 'Catalan',
                        'cs_CZ': 'Czech',
                        'da_DK': 'Danish',
                        'de_DE': 'German',
                        'el_GR': 'Greek',
                        'es_ES': 'Spanish (Spain)',
                        'es_MX': 'Spanish (Mexico)',
                        'fi_FI': 'Finnish',
                        'fr_FR': 'French',
                        'hu_HU': 'Hungarian',
                        'is_IS': 'Icelandic',
                        'it_IT': 'Italian',
                        'ja_JP': 'Japanese',
                        'ka_GE': 'Georgian',
                        'kk_KZ': 'Kazakh',
                        'ko_KR': 'Korean',
                        'lb_LU': 'Luxembourgish',
                        'ne_NP': 'Nepali',
                        'nl_NL': 'Dutch',
                        'no_NO': 'Norwegian',
                        'pl_PL': 'Polish',
                        'pt_BR': 'Portuguese (Brazil)',
                        'pt_PT': 'Portuguese (Portugal)',
                        'ro_RO': 'Romanian',
                        'ru_RU': 'Russian',
                        'sk_SK': 'Slovak',
                        'sl_SI': 'Slovenian',
                        'sr_RS': 'Serbian',
                        'sv_SE': 'Swedish',
                        'sw_CD': 'Swahili',
                        'tr_TR': 'Turkish',
                        'uk_UA': 'Ukrainian',
                        'vi_VN': 'Vietnamese',
                        'zh_CN': 'Chinese'
                    };

                    // Get only installed voices (voices with actual model files)
                    const installedVoices = getInstalledVoices();

                    // Transform installed voices into dashboard format
                    return Object.entries(installedVoices).map(([voiceId, voiceData]) => {
                        // Capitalize and format voice name
                        const capitalizedName = voiceId
                            .split('_')
                            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                            .join(' ');

                        return {
                            value: voiceId,
                            label: `${voiceData.flag} ${capitalizedName} (${voiceData.quality}, ${voiceData.gender})`,
                            category: localeCategories[voiceData.locale] || voiceData.locale
                        };
                    });
                })(),
                quarantinedUsers: [],
                actionLogs: [],
                analyticsData: analyticsData,
                serverStats: serverStats,
                redditFeeds: [],
                youtubeFeeds: [],
                twitterFeeds: [],
                autoPublisherConfig: autoPublisherConfig,
                autorolesConfig: autorolesConfig,
                tempChannelConfig: tempChannelConfig,
                customCommands: [],
                commandSettings: [],
                forms: forms,
                ticketConfig: {},
                ticketFormsList: [],
                ticketPanels: ticketPanels,
                polls: polls,
                // Sery Bot Features (Advanced Protection)
                raidConfig: raidConfig,
                raidIncidents: raidIncidents,
                selfbotConfig: selfbotConfig,
                selfbotDetections: selfbotDetections,
                adaptiveSpamConfig: adaptiveSpamConfig,
                // Guild Systems (self-promo, community support, stream-ended)
                selfPromoConfig: await (async () => {
                    try {
                        const [rows] = await pool.execute('SELECT * FROM self_promo_config WHERE guild_id = ?', [guildId]);
                        const config = rows[0] || {};
                        if (config.allowed_platforms && typeof config.allowed_platforms === 'string') {
                            try { config.allowed_platforms = JSON.parse(config.allowed_platforms); } catch { config.allowed_platforms = []; }
                        }
                        return config;
                    } catch { return {}; }
                })(),
                communitySupportConfig: await (async () => {
                    try {
                        const [rows] = await pool.execute('SELECT * FROM community_support_config WHERE guild_id = ?', [guildId]);
                        return rows[0] || {};
                    } catch { return {}; }
                })(),
                autoTrackConfigs: await (async () => {
                    try {
                        const [rows] = await pool.execute(
                            'SELECT * FROM guild_streamer_auto_track WHERE guild_id = ? ORDER BY auto_id',
                            [guildId]
                        );
                        return rows;
                    } catch { return []; }
                })(),
                streamEndedSubs: await (async () => {
                    try {
                        const [rows] = await pool.execute(`
                            SELECT sub.subscription_id, s.username, s.platform, sub.edit_on_end, sub.delete_on_end,
                                   COALESCE(sub.announcement_channel_id, ts.announcement_channel_id, gc.announcement_channel_id) AS channel_id
                            FROM subscriptions sub
                            JOIN streamers s ON sub.streamer_id = s.streamer_id
                            LEFT JOIN twitch_teams ts ON sub.team_subscription_id = ts.id
                            LEFT JOIN guild_config gc ON CAST(sub.guild_id AS CHAR) = CAST(gc.guild_id AS CHAR)
                            WHERE sub.guild_id = ?
                            ORDER BY sub.edit_on_end DESC, s.username
                        `, [guildId]);
                        return rows;
                    } catch { return []; }
                })(),
                clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID
            });
        } catch (error) {
            logger.error('[/manage/:guildId Error]', {
                error: error.message,
                stack: error.stack,
                guildId: req.params.guildId,
                page: req.query.page
            });
            res.status(500).render('error-tailwind', {
                user: req.user,
                error: 'Failed to load server management page'
            });
        }
    });

    // POST routes for manage/:guildId feature configurations
    app.post('/manage/:guildId/music/config', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { enabled, djRoleId } = req.body;

            logger.info(`[Music Config] Received: enabled=${enabled}, djRoleId=${djRoleId}`);

            // Upsert music_config
            await pool.execute(`
                INSERT INTO music_config (guild_id, enabled, dj_role_id)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    enabled = VALUES(enabled),
                    dj_role_id = VALUES(dj_role_id)
            `, [guildId, enabled === 'on' ? 1 : 0, djRoleId || null]);

            logger.info(`[Music Config] Saved to DB: enabled=${enabled === 'on' ? 1 : 0}, djRoleId=${djRoleId || null}`);
            invalidateMusicConfigCache(guildId);

            res.redirect(`/manage/${guildId}?page=music&success=config`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/music/config Error]', error);
            res.redirect(`/manage/${guildId}?page=music&error=config`);
        }
    });

    app.post('/manage/:guildId/music/dj', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { djEnabled, djVoice } = req.body;

            logger.info(`[DJ Config] Received: djEnabled=${djEnabled}, djVoice=${djVoice}`);

            // Upsert music_config
            await pool.execute(`
                INSERT INTO music_config (guild_id, dj_enabled, dj_voice)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    dj_enabled = VALUES(dj_enabled),
                    dj_voice = VALUES(dj_voice)
            `, [guildId, djEnabled === 'on' ? 1 : 0, djVoice || 'female']);

            logger.info(`[DJ Config] Saved to DB: djEnabled=${djEnabled === 'on' ? 1 : 0}, djVoice=${djVoice || 'female'}`);
            invalidateMusicConfigCache(guildId);

            res.redirect(`/manage/${guildId}?page=music&success=dj`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/music/dj Error]', error);
            res.redirect(`/manage/${guildId}?page=music&error=dj`);
        }
    });

    // Advanced music features (FlaviBot-style)
    app.post('/manage/:guildId/music/advanced', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { twentyFourSeven, autoplayEnabled, autoplaySource, requestChannelId, voteSkipEnabled, voteSkipPercentage } = req.body;

            logger.info(`[Music Advanced] Received: 24/7=${twentyFourSeven}, autoplay=${autoplayEnabled}, source=${autoplaySource}, requestChannel=${requestChannelId}, voteSkip=${voteSkipEnabled}, percentage=${voteSkipPercentage}`);

            // Upsert music_config with advanced features
            await pool.execute(`
                INSERT INTO music_config (guild_id, twenty_four_seven, autoplay_enabled, autoplay_source, request_channel_id, vote_skip_enabled, vote_skip_percentage)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    twenty_four_seven = VALUES(twenty_four_seven),
                    autoplay_enabled = VALUES(autoplay_enabled),
                    autoplay_source = VALUES(autoplay_source),
                    request_channel_id = VALUES(request_channel_id),
                    vote_skip_enabled = VALUES(vote_skip_enabled),
                    vote_skip_percentage = VALUES(vote_skip_percentage)
            `, [
                guildId,
                twentyFourSeven === 'on' ? 1 : 0,
                autoplayEnabled === 'on' ? 1 : 0,
                autoplaySource || 'youtube',
                requestChannelId || null,
                voteSkipEnabled === 'on' ? 1 : 0,
                parseInt(voteSkipPercentage) || 50
            ]);

            logger.info(`[Music Advanced] Saved to DB for guild ${guildId}`);
            invalidateMusicConfigCache(guildId);

            res.redirect(`/manage/${guildId}?page=music&success=advanced`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/music/advanced Error]', error);
            res.redirect(`/manage/${guildId}?page=music&error=advanced`);
        }
    });

    // Voice preview endpoint - serves pre-generated preview audio files
    app.get('/api/voice-preview/:voiceId', checkAuth, async (req, res) => {
        try {
            const { voiceId } = req.params;
            const previewPath = path.join(__dirname, '..', 'piper_models', 'previews', `${voiceId}.wav`);

            // Security: Validate voice ID (alphanumeric and underscores only)
            if (!/^[a-zA-Z0-9_]+$/.test(voiceId)) {
                return res.status(400).json({ error: 'Invalid voice ID' });
            }

            // Check if preview file exists
            if (!fs.existsSync(previewPath)) {
                return res.status(404).json({ error: 'Voice preview not found' });
            }

            // Serve the audio file
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
            res.sendFile(previewPath);
        } catch (err) {
            logger.error('[Voice Preview] Error serving preview:', err);
            res.status(500).json({ error: 'Failed to load voice preview' });
        }
    });

    app.post('/manage/:guildId/update-channel-webhooks', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const channelWebhooks = req.body.channel_webhooks || {};

            // Process each channel webhook
            for (const [channelId, webhookUrl] of Object.entries(channelWebhooks)) {
                if (webhookUrl && webhookUrl.trim()) {
                    // Insert or update webhook URL
                    await pool.execute(`
                        INSERT INTO channel_settings (channel_id, guild_id, webhook_url)
                        VALUES (?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                            webhook_url = VALUES(webhook_url)
                    `, [channelId, guildId, webhookUrl.trim()]);
                } else {
                    // Remove webhook URL if empty
                    await pool.execute(`
                        UPDATE channel_settings
                        SET webhook_url = NULL
                        WHERE channel_id = ? AND guild_id = ?
                    `, [channelId, guildId]);
                }
            }

            res.redirect(`/manage/${guildId}?page=logging&success=webhooks`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-channel-webhooks Error]', error);
            res.redirect(`/manage/${guildId}?page=logging&error=webhooks`);
        }
    });

    app.post('/manage/:guildId/update-logging', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { log_channel_id, enabled_logs, log_categories } = req.body;

            // Update main logging config
            await pool.execute(`
                INSERT INTO logging_config (guild_id, log_channel_id, enabled_events)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    log_channel_id = VALUES(log_channel_id),
                    enabled_events = VALUES(enabled_events)
            `, [
                guildId,
                log_channel_id || null,
                JSON.stringify(Array.isArray(enabled_logs) ? enabled_logs : (enabled_logs ? [enabled_logs] : []))
            ]);

            // Update log event configs (individual category settings)
            // First, get all enabled log types
            const enabledArray = Array.isArray(enabled_logs) ? enabled_logs : (enabled_logs ? [enabled_logs] : []);
            const categoryOverrides = log_categories || {};

            // Define all possible log categories to ensure we update disabled ones too
            const allCategories = [
                'messageDelete', 'messageUpdate', 'memberUpdate', 'memberLeave', 'memberKick',
                'voiceUpdate', 'channelCreate', 'channelDelete', 'channelUpdate',
                'threadCreate', 'threadDelete', 'threadUpdate', 'guildUpdate',
                'ban', 'unban', 'roleCreate', 'roleDelete', 'roleUpdate',
                'emojiCreate', 'emojiDelete', 'emojiUpdate', 'stickerCreate', 'stickerDelete', 'stickerUpdate',
                'webhookUpdate', 'integrationUpdate', 'moderation', 'join-gate', 'system',
                'xp', 'giveaway', 'poll', 'starboard', 'sticky-roles', 'temp-channels',
                'twitch-schedule', 'auto-publisher', 'autorole', 'tickets', 'backup', 'team-sync', 'http'
            ];

            for (const eventType of allCategories) {
                const isEnabled = enabledArray.includes(eventType);
                const channelOverride = categoryOverrides[eventType] || null;

                await pool.execute(`
                    INSERT INTO log_event_config (guild_id, event_type, enabled, log_channel_id)
                    VALUES (?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        enabled = VALUES(enabled),
                        log_channel_id = VALUES(log_channel_id)
                `, [guildId, eventType, isEnabled ? 1 : 0, channelOverride]);
            }

            res.redirect(`/manage/${guildId}?page=logging&success=config`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-logging Error]', error);
            res.redirect(`/manage/${guildId}?page=logging&error=config`);
        }
    });

    // Suggestions config route
    app.post('/manage/:guildId/suggestions/config', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { enabled, suggestion_channel_id, approval_required, staff_review_channel_id, staff_role_id, allow_comments } = req.body;

            logger.info(`[Suggestions Config] Received for guild ${guildId}:`, {
                enabled,
                suggestion_channel_id,
                approval_required,
                staff_review_channel_id,
                staff_role_id,
                allow_comments
            });

            // Upsert suggestion_config
            await pool.execute(`
                INSERT INTO suggestion_config (guild_id, enabled, suggestions_channel_id, require_approval, staff_review_channel_id, approved_role_id)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    enabled = VALUES(enabled),
                    suggestions_channel_id = VALUES(suggestions_channel_id),
                    require_approval = VALUES(require_approval),
                    staff_review_channel_id = VALUES(staff_review_channel_id),
                    approved_role_id = VALUES(approved_role_id)
            `, [
                guildId,
                enabled === 'on' ? 1 : 0,
                suggestion_channel_id || null,
                approval_required === 'on' ? 1 : 0,
                staff_review_channel_id || null,
                staff_role_id || null
            ]);

            logger.info(`[Suggestions Config] Saved successfully for guild ${guildId}`);

            res.redirect(`/manage/${guildId}?page=suggestions&success=config`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/suggestions/config Error]', error);
            res.redirect(`/manage/${guildId}?page=suggestions&error=config`);
        }
    });

    // Implement suggestion
    app.post('/manage/:guildId/suggestions/implement', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { suggestion_id } = req.body;

            await pool.execute(
                'UPDATE suggestions SET status = ?, implemented_at = NOW() WHERE suggestion_id = ? AND guild_id = ?',
                ['implemented', suggestion_id, guildId]
            );

            logger.info(`[Suggestions] Marked suggestion ${suggestion_id} as implemented`);
            res.redirect(`/manage/${guildId}?page=suggestions&success=implemented`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/suggestions/implement Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=suggestions&error=implement`);
        }
    });

    // Delete suggestion
    app.post('/manage/:guildId/suggestions/delete', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { suggestion_id } = req.body;

            await pool.execute(
                'DELETE FROM suggestions WHERE suggestion_id = ? AND guild_id = ?',
                [suggestion_id, guildId]
            );

            logger.info(`[Suggestions] Deleted suggestion ${suggestion_id}`);
            res.redirect(`/manage/${guildId}?page=suggestions&success=deleted`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/suggestions/delete Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=suggestions&error=delete`);
        }
    });

    // Leveling config route
    app.post('/manage/:guildId/update-leveling', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { leveling_enabled, leveling_xp_rate, leveling_xp_cooldown, level_up_channel_id, leveling_ignored_channels, leveling_ignored_roles } = req.body;

            logger.info(`[Leveling Config] Received for guild ${guildId}:`, {
                leveling_enabled,
                leveling_xp_rate,
                leveling_xp_cooldown
            });

            // Prepare arrays for ignored channels and roles
            const ignoredChannels = Array.isArray(leveling_ignored_channels)
                ? leveling_ignored_channels
                : (leveling_ignored_channels ? [leveling_ignored_channels] : []);

            const ignoredRoles = Array.isArray(leveling_ignored_roles)
                ? leveling_ignored_roles
                : (leveling_ignored_roles ? [leveling_ignored_roles] : []);

            // Update leveling config
            await pool.execute(`
                INSERT INTO level_config (guild_id, enabled, xp_per_message, xp_cooldown_seconds, level_up_channel_id, ignored_channels, ignored_roles)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    enabled = VALUES(enabled),
                    xp_per_message = VALUES(xp_per_message),
                    xp_cooldown_seconds = VALUES(xp_cooldown_seconds),
                    level_up_channel_id = VALUES(level_up_channel_id),
                    ignored_channels = VALUES(ignored_channels),
                    ignored_roles = VALUES(ignored_roles)
            `, [
                guildId,
                leveling_enabled ? 1 : 0,
                parseInt(leveling_xp_rate) || 15,
                parseInt(leveling_xp_cooldown) || 60,
                level_up_channel_id || null,
                JSON.stringify(ignoredChannels),
                JSON.stringify(ignoredRoles)
            ]);

            logger.info(`[Leveling Config] Saved successfully for guild ${guildId}`);

            res.redirect(`/manage/${guildId}?page=leveling&success=config`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-leveling Error]', error);
            res.redirect(`/manage/${guildId}?page=leveling&error=config`);
        }
    });

    // Core settings route
    app.post('/manage/:guildId/update-core-settings', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { timezone, live_role_id } = req.body;

            // Update guild_settings (timezone)
            await pool.execute(
                `INSERT INTO guild_settings (guild_id, timezone) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE timezone = VALUES(timezone)`,
                [guildId, timezone || 'UTC']
            );

            // Update guilds (live_role_id)
            await pool.execute(
                `INSERT INTO guilds (guild_id, live_role_id) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE live_role_id = VALUES(live_role_id)`,
                [guildId, live_role_id || null]
            );

            res.redirect(`/manage/${guildId}?page=core&success=updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-core-settings Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=core&error=update`);
        }
    });

    // Update Tickets
    app.post('/manage/:guildId/update-tickets', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const {
                panel_channel_id,
                ticket_category_id,
                support_role_id,
                log_channel_id,
                auto_close_hours,
                use_threads,
                thread_parent_channel_id
            } = req.body;

            // Check if config exists
            const [existing] = await pool.execute(
                'SELECT * FROM ticket_config WHERE guild_id = ?',
                [guildId]
            );

            if (existing.length === 0) {
                // Insert new config
                await pool.execute(
                    `INSERT INTO ticket_config (
                        guild_id, panel_channel_id, ticket_category_id,
                        support_role_id, log_channel_id, auto_close_hours,
                        use_threads, thread_parent_channel_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        guildId,
                        panel_channel_id || null,
                        ticket_category_id || null,
                        support_role_id || null,
                        log_channel_id || null,
                        auto_close_hours || null,
                        use_threads ? 1 : 0,
                        thread_parent_channel_id || null
                    ]
                );
            } else {
                // Update existing config
                await pool.execute(
                    `UPDATE ticket_config SET
                        panel_channel_id = ?,
                        ticket_category_id = ?,
                        support_role_id = ?,
                        log_channel_id = ?,
                        auto_close_hours = ?,
                        use_threads = ?,
                        thread_parent_channel_id = ?
                    WHERE guild_id = ?`,
                    [
                        panel_channel_id || null,
                        ticket_category_id || null,
                        support_role_id || null,
                        log_channel_id || null,
                        auto_close_hours || null,
                        use_threads ? 1 : 0,
                        thread_parent_channel_id || null,
                        guildId
                    ]
                );
            }

            res.redirect(`/manage/${guildId}?page=tickets&success=updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-tickets Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=tickets&error=update`);
        }
    });

    // Anti-Raid Configuration
    app.post('/manage/:guildId/security/antiraid', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { enabled, threshold, timePeriod, action } = req.body;

            // Check if config exists
            const [existing] = await pool.execute(
                'SELECT * FROM anti_raid_config WHERE guild_id = ?',
                [guildId]
            );

            if (existing.length === 0) {
                // Insert new config (using correct column names)
                await pool.execute(
                    `INSERT INTO anti_raid_config (guild_id, is_enabled, join_limit, time_period_seconds, action)
                     VALUES (?, ?, ?, ?, ?)`,
                    [guildId, enabled ? 1 : 0, threshold || 10, timePeriod || 10, action || 'kick']
                );
            } else {
                // Update existing config
                await pool.execute(
                    `UPDATE anti_raid_config
                     SET is_enabled = ?, join_limit = ?, time_period_seconds = ?, action = ?
                     WHERE guild_id = ?`,
                    [enabled ? 1 : 0, threshold || 10, timePeriod || 10, action || 'kick', guildId]
                );
            }

            res.redirect(`/manage/${guildId}?page=security&success=antiraid`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/security/antiraid Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=security&error=antiraid`);
        }
    });

    // Anti-Nuke Configuration
    app.post('/manage/:guildId/security/antinuke', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { enabled } = req.body;

            // Check if config exists
            const [existing] = await pool.execute(
                'SELECT * FROM anti_nuke_config WHERE guild_id = ?',
                [guildId]
            );

            if (existing.length === 0) {
                // Insert new config with default thresholds (using correct column names)
                await pool.execute(
                    `INSERT INTO anti_nuke_config
                     (guild_id, enabled, max_channel_deletes, max_role_deletes, max_kick_bans, action_on_trigger)
                     VALUES (?, ?, 3, 3, 5, 'ban')`,
                    [guildId, enabled ? 1 : 0]
                );
            } else {
                // Update existing config
                await pool.execute(
                    `UPDATE anti_nuke_config SET enabled = ? WHERE guild_id = ?`,
                    [enabled ? 1 : 0, guildId]
                );
            }

            res.redirect(`/manage/${guildId}?page=security&success=antinuke`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/security/antinuke Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=security&error=antinuke`);
        }
    });

    // Join Gate Configuration
    app.post('/manage/:guildId/security/joingate', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { enabled, roleId } = req.body;

            // Check if config exists
            const [existing] = await pool.execute(
                'SELECT * FROM join_gate_config WHERE guild_id = ?',
                [guildId]
            );

            if (existing.length === 0) {
                // Insert new config (using correct column names)
                await pool.execute(
                    `INSERT INTO join_gate_config (guild_id, is_enabled, verification_enabled, verification_role_id)
                     VALUES (?, ?, ?, ?)`,
                    [guildId, enabled ? 1 : 0, enabled ? 1 : 0, roleId || null]
                );
            } else {
                // Update existing config
                await pool.execute(
                    `UPDATE join_gate_config SET is_enabled = ?, verification_enabled = ?, verification_role_id = ? WHERE guild_id = ?`,
                    [enabled ? 1 : 0, enabled ? 1 : 0, roleId || null, guildId]
                );
            }

            res.redirect(`/manage/${guildId}?page=security&success=joingate`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/security/joingate Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=security&error=joingate`);
        }
    });

    // ==========================================
    // Sery Bot Features - Advanced Protection
    // ==========================================

    // Raid Detection Configuration
    app.post('/manage/:guildId/advanced-protection/raid', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const {
                enabled,
                join_threshold,
                join_timeframe_seconds,
                new_account_age_hours,
                new_account_ratio,
                action,
                alert_channel_id,
                mute_duration_minutes,
                purge_messages
            } = req.body;

            // Check if config exists
            const [existing] = await pool.execute(
                'SELECT * FROM raid_detection_config WHERE guild_id = ?',
                [guildId]
            );

            // Convert ratio from percentage (70) to decimal (0.70)
            const ratioDecimal = (parseInt(new_account_ratio) || 70) / 100;

            if (existing.length === 0) {
                // Insert new config
                await pool.execute(
                    `INSERT INTO raid_detection_config
                     (guild_id, enabled, join_threshold, join_timeframe_seconds, new_account_age_hours,
                      new_account_ratio, action, alert_channel_id, mute_duration_minutes, purge_messages)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        guildId,
                        enabled ? 1 : 0,
                        parseInt(join_threshold) || 10,
                        parseInt(join_timeframe_seconds) || 30,
                        parseInt(new_account_age_hours) || 24,
                        ratioDecimal,
                        action || 'alert',
                        alert_channel_id || null,
                        parseInt(mute_duration_minutes) || 60,
                        purge_messages ? 1 : 0
                    ]
                );
            } else {
                // Update existing config
                await pool.execute(
                    `UPDATE raid_detection_config
                     SET enabled = ?, join_threshold = ?, join_timeframe_seconds = ?,
                         new_account_age_hours = ?, new_account_ratio = ?, action = ?,
                         alert_channel_id = ?, mute_duration_minutes = ?, purge_messages = ?
                     WHERE guild_id = ?`,
                    [
                        enabled ? 1 : 0,
                        parseInt(join_threshold) || 10,
                        parseInt(join_timeframe_seconds) || 30,
                        parseInt(new_account_age_hours) || 24,
                        ratioDecimal,
                        action || 'alert',
                        alert_channel_id || null,
                        parseInt(mute_duration_minutes) || 60,
                        purge_messages ? 1 : 0,
                        guildId
                    ]
                );
            }

            logger.info(`[Raid Detection] Config updated for guild ${guildId}: enabled=${enabled}`);
            res.redirect(`/manage/${guildId}?page=advanced-protection&success=raid`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/advanced-protection/raid Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=advanced-protection&error=raid`);
        }
    });

    // Self-Bot Detection Configuration
    app.post('/manage/:guildId/advanced-protection/selfbot', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const {
                enabled,
                min_response_time_ms,
                message_burst_threshold,
                message_burst_window_ms,
                pattern_threshold,
                action,
                alert_channel_id,
                exempt_roles
            } = req.body;

            // Parse exempt roles
            let rolesArray = [];
            if (exempt_roles) {
                rolesArray = Array.isArray(exempt_roles) ? exempt_roles : [exempt_roles];
            }

            // Check if config exists
            const [existing] = await pool.execute(
                'SELECT * FROM selfbot_detection_config WHERE guild_id = ?',
                [guildId]
            );

            if (existing.length === 0) {
                // Insert new config
                await pool.execute(
                    `INSERT INTO selfbot_detection_config
                     (guild_id, enabled, min_response_time_ms, message_burst_threshold,
                      message_burst_window_ms, pattern_threshold, action, alert_channel_id, exempt_roles)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        guildId,
                        enabled ? 1 : 0,
                        parseInt(min_response_time_ms) || 50,
                        parseInt(message_burst_threshold) || 20,
                        parseInt(message_burst_window_ms) || 1000,
                        parseInt(pattern_threshold) || 3,
                        action || 'alert',
                        alert_channel_id || null,
                        JSON.stringify(rolesArray)
                    ]
                );
            } else {
                // Update existing config
                await pool.execute(
                    `UPDATE selfbot_detection_config
                     SET enabled = ?, min_response_time_ms = ?, message_burst_threshold = ?,
                         message_burst_window_ms = ?, pattern_threshold = ?, action = ?,
                         alert_channel_id = ?, exempt_roles = ?
                     WHERE guild_id = ?`,
                    [
                        enabled ? 1 : 0,
                        parseInt(min_response_time_ms) || 50,
                        parseInt(message_burst_threshold) || 20,
                        parseInt(message_burst_window_ms) || 1000,
                        parseInt(pattern_threshold) || 3,
                        action || 'alert',
                        alert_channel_id || null,
                        JSON.stringify(rolesArray),
                        guildId
                    ]
                );
            }

            logger.info(`[Self-Bot Detection] Config updated for guild ${guildId}: enabled=${enabled}`);
            res.redirect(`/manage/${guildId}?page=advanced-protection&success=selfbot`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/advanced-protection/selfbot Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=advanced-protection&error=selfbot`);
        }
    });

    // Adaptive Spam Configuration
    app.post('/manage/:guildId/advanced-protection/adaptive-spam', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const {
                enabled,
                cross_channel_threshold,
                cross_channel_timeframe_minutes,
                deviation_multiplier,
                new_account_multiplier_7d,
                new_account_multiplier_24h,
                action,
                alert_channel_id
            } = req.body;

            // Check if config exists
            const [existing] = await pool.execute(
                'SELECT * FROM adaptive_spam_config WHERE guild_id = ?',
                [guildId]
            );

            if (existing.length === 0) {
                // Insert new config
                await pool.execute(
                    `INSERT INTO adaptive_spam_config
                     (guild_id, enabled, cross_channel_threshold, cross_channel_timeframe_minutes,
                      deviation_multiplier, new_account_multiplier_7d, new_account_multiplier_24h,
                      action, alert_channel_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        guildId,
                        enabled ? 1 : 0,
                        parseInt(cross_channel_threshold) || 3,
                        parseInt(cross_channel_timeframe_minutes) || 5,
                        parseFloat(deviation_multiplier) || 2.0,
                        parseFloat(new_account_multiplier_7d) || 1.5,
                        parseFloat(new_account_multiplier_24h) || 2.0,
                        action || 'alert',
                        alert_channel_id || null
                    ]
                );
            } else {
                // Update existing config
                await pool.execute(
                    `UPDATE adaptive_spam_config
                     SET enabled = ?, cross_channel_threshold = ?, cross_channel_timeframe_minutes = ?,
                         deviation_multiplier = ?, new_account_multiplier_7d = ?,
                         new_account_multiplier_24h = ?, action = ?, alert_channel_id = ?
                     WHERE guild_id = ?`,
                    [
                        enabled ? 1 : 0,
                        parseInt(cross_channel_threshold) || 3,
                        parseInt(cross_channel_timeframe_minutes) || 5,
                        parseFloat(deviation_multiplier) || 2.0,
                        parseFloat(new_account_multiplier_7d) || 1.5,
                        parseFloat(new_account_multiplier_24h) || 2.0,
                        action || 'alert',
                        alert_channel_id || null,
                        guildId
                    ]
                );
            }

            logger.info(`[Adaptive Spam] Config updated for guild ${guildId}: enabled=${enabled}`);
            res.redirect(`/manage/${guildId}?page=advanced-protection&success=adaptive-spam`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/advanced-protection/adaptive-spam Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=advanced-protection&error=adaptive-spam`);
        }
    });

    // Quarantine Configuration
    app.post('/manage/:guildId/update-quarantine', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { is_enabled, quarantine_role_id } = req.body;

            // Check if config exists
            const [existing] = await pool.execute(
                'SELECT * FROM quarantine_config WHERE guild_id = ?',
                [guildId]
            );

            if (existing.length === 0) {
                // Insert new config
                await pool.execute(
                    `INSERT INTO quarantine_config (guild_id, is_enabled, quarantine_role_id)
                     VALUES (?, ?, ?)`,
                    [guildId, is_enabled ? 1 : 0, quarantine_role_id || null]
                );
            } else {
                // Update existing config
                await pool.execute(
                    `UPDATE quarantine_config SET is_enabled = ?, quarantine_role_id = ? WHERE guild_id = ?`,
                    [is_enabled ? 1 : 0, quarantine_role_id || null, guildId]
                );
            }

            res.redirect(`/manage/${guildId}?page=quarantine&success=updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-quarantine Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=quarantine&error=update`);
        }
    });

    // Release User from Quarantine
    app.post('/manage/:guildId/release-quarantine', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { userId } = req.body;

            if (!userId) {
                return res.redirect(`/manage/${guildId}?page=quarantine&error=no_user`);
            }

            // Remove from quarantine table
            await pool.execute(
                'DELETE FROM quarantined_users WHERE guild_id = ? AND user_id = ?',
                [guildId, userId]
            );

            // Get guild and remove quarantine role
            const guild = client.guilds.cache.get(guildId);
            if (guild) {
                try {
                    const member = await guild.members.fetch(userId);

                    // Get quarantine config to find the role
                    const [config] = await pool.execute(
                        'SELECT quarantine_role_id FROM quarantine_config WHERE guild_id = ?',
                        [guildId]
                    );

                    if (config.length > 0 && config[0].quarantine_role_id) {
                        const quarantineRole = guild.roles.cache.get(config[0].quarantine_role_id);
                        if (quarantineRole && member.roles.cache.has(quarantineRole.id)) {
                            await member.roles.remove(quarantineRole);
                        }
                    }

                    // Restore previous roles if they were saved
                    const [savedRoles] = await pool.execute(
                        'SELECT previous_roles FROM quarantined_users WHERE guild_id = ? AND user_id = ?',
                        [guildId, userId]
                    );

                    if (savedRoles.length > 0 && savedRoles[0].previous_roles) {
                        const roleIds = JSON.parse(savedRoles[0].previous_roles);
                        const rolesToAdd = roleIds
                            .map(id => guild.roles.cache.get(id))
                            .filter(role => role && role.id !== guild.id);

                        if (rolesToAdd.length > 0) {
                            await member.roles.add(rolesToAdd);
                        }
                    }
                } catch (err) {
                    logger.warn('[Release Quarantine] Could not modify member roles:', err.message);
                }
            }

            res.redirect(`/manage/${guildId}?page=quarantine&success=released`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/release-quarantine Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=quarantine&error=release`);
        }
    });

    // Bot Appearance
    app.post('/manage/:guildId/update-bot-appearance', upload.fields([
        { name: 'bot_avatar_file', maxCount: 1 }
    ]), handleMulterError, checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { bot_nickname, bot_avatar_url, reset_bot_avatar, embed_color } = req.body;

            // Check if a file was uploaded
            const uploadedFile = req.files?.bot_avatar_file?.[0];

            logger.info('[Appearance Update]', {
                guildId,
                bot_nickname,
                bot_avatar_url,
                reset_bot_avatar,
                embed_color,
                hasUploadedFile: !!uploadedFile
            });

            // Determine final avatar URL: uploaded file takes precedence, then URL field
            let finalAvatarUrl = bot_avatar_url || null;

            // TODO: Handle file upload - would need to upload to CDN/storage and get URL
            // For now, just use the URL field
            if (uploadedFile) {
                logger.warn('[POST /manage/:guildId/update-bot-appearance] File upload not yet implemented - using URL field instead');
            }

            await pool.execute(`
                INSERT INTO guild_config (guild_id, bot_nickname, bot_avatar_url, embed_color)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    bot_nickname = VALUES(bot_nickname),
                    bot_avatar_url = VALUES(bot_avatar_url),
                    embed_color = VALUES(embed_color)
            `, [
                guildId,
                bot_nickname === 'reset' ? null : (bot_nickname || null),
                reset_bot_avatar ? null : finalAvatarUrl,
                embed_color || '#a78bfa'
            ]);

            // Apply nickname to the bot in this guild
            try {
                const guild = client.guilds.cache.get(guildId);
                if (guild && guild.members.me) {
                    const finalNickname = (bot_nickname === 'reset' || !bot_nickname) ? null : bot_nickname;
                    await guild.members.me.setNickname(finalNickname);
                    logger.info('[POST /manage/:guildId/update-bot-appearance] Bot nickname updated in guild', {
                        guildId,
                        nickname: finalNickname
                    });
                }
            } catch (nicknameError) {
                logger.error('[POST /manage/:guildId/update-bot-appearance] Failed to update bot nickname:', nicknameError);
                // Don't fail the whole request if nickname update fails
            }

            res.redirect(`/manage/${guildId}?page=appearance&success=updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-bot-appearance Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=appearance&error=update`);
        }
    });

    // Autopublisher
    app.post('/manage/:guildId/update-autopublisher', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { is_enabled } = req.body;

            logger.info('[POST /manage/:guildId/update-autopublisher] Updating:', {
                guildId,
                is_enabled: Boolean(is_enabled)
            });

            await pool.execute(`
                INSERT INTO auto_publisher_config (guild_id, is_enabled)
                VALUES (?, ?)
                ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled)
            `, [guildId, is_enabled ? 1 : 0]);

            res.redirect(`/manage/${guildId}?page=utilities&success=updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-autopublisher Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=utilities&error=update`);
        }
    });

    // Announcements
    app.post('/manage/:guildId/update-announcements', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { announcement_channel_id, live_role_id, announcement_message, use_webhook_persona } = req.body;
            const webhookPersona = use_webhook_persona === '1' ? 1 : 0;

            logger.info('[POST /manage/:guildId/update-announcements] Updating:', {
                guildId,
                announcement_channel_id,
                live_role_id,
                use_webhook_persona: webhookPersona,
                announcement_message: announcement_message ? announcement_message.substring(0, 50) + '...' : null
            });

            // Check if this guild previously had no announcement channel
            const [prevConfig] = await pool.execute(
                'SELECT announcement_channel_id FROM guilds WHERE guild_id = ?',
                [guildId]
            );
            const hadChannel = prevConfig.length > 0 && prevConfig[0].announcement_channel_id;

            // Save to guilds table (where stream-manager reads from)
            await pool.execute(`
                INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id, announcement_message, use_webhook_persona)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    announcement_channel_id = VALUES(announcement_channel_id),
                    live_role_id = VALUES(live_role_id),
                    announcement_message = VALUES(announcement_message),
                    use_webhook_persona = VALUES(use_webhook_persona)
            `, [guildId, announcement_channel_id || null, live_role_id || null, announcement_message || null, webhookPersona]);

            // If a channel was just set (wasn't configured before), cross-pollinate existing streamers
            if (announcement_channel_id && !hadChannel) {
                import('../utils/streamer-cross-pollinate.js').then(({ crossPollinateGuild }) => {
                    crossPollinateGuild(guildId, announcement_channel_id).catch(err => {
                        logger.error('[CrossPollinate:Guild] Background error:', { error: err.message, guildId, category: 'streams' });
                    });
                }).catch(() => {});
            }

            // Determine redirect page from referer
            const referer = req.get('Referer') || '';
            const redirectPage = referer.includes('page=streamers') ? 'streamers' : 'announcements';
            res.redirect(`/manage/${guildId}?page=${redirectPage}&success=updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-announcements Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=streamers&error=update`);
        }
    });

    // Welcome & Farewell Settings
    app.post('/manage/:guildId/update-welcome', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const {
                channel_id,
                message,
                banner_enabled,
                card_title_text,
                card_subtitle_text,
                card_background_url,
                goodbye_enabled,
                goodbye_channel_id,
                goodbye_message
            } = req.body;

            logger.info('[POST /manage/:guildId/update-welcome] Updating:', {
                guildId,
                channel_id,
                banner_enabled: Boolean(banner_enabled),
                goodbye_enabled: Boolean(goodbye_enabled)
            });

            await pool.execute(`
                INSERT INTO welcome_settings (
                    guild_id,
                    channel_id,
                    message,
                    banner_enabled,
                    card_title_text,
                    card_subtitle_text,
                    card_background_url,
                    goodbye_enabled,
                    goodbye_channel_id,
                    goodbye_message
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    channel_id = VALUES(channel_id),
                    message = VALUES(message),
                    banner_enabled = VALUES(banner_enabled),
                    card_title_text = VALUES(card_title_text),
                    card_subtitle_text = VALUES(card_subtitle_text),
                    card_background_url = VALUES(card_background_url),
                    goodbye_enabled = VALUES(goodbye_enabled),
                    goodbye_channel_id = VALUES(goodbye_channel_id),
                    goodbye_message = VALUES(goodbye_message)
            `, [
                guildId,
                channel_id || null,
                message || null,
                banner_enabled ? 1 : 0,
                card_title_text || null,
                card_subtitle_text || null,
                card_background_url || null,
                goodbye_enabled ? 1 : 0,
                goodbye_channel_id || null,
                goodbye_message || null
            ]);

            res.redirect(`/manage/${guildId}?page=welcome&success=updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-welcome Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=welcome&error=update`);
        }
    });

    // Create Poll
    app.post('/manage/:guildId/create-poll', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { question, options, channel_id, duration, allow_multiple, anonymous, allow_write_in } = req.body;

            logger.info('[POST /manage/:guildId/create-poll] Creating poll:', {
                guildId,
                question,
                channel_id,
                duration,
                duration_type: typeof duration
            });

            // Validate inputs
            if (!question || !options || !channel_id) {
                return res.redirect(`/manage/${guildId}?page=polls&error=missing_fields`);
            }

            // Parse options (comma or semicolon-separated or array)
            const optionsArray = Array.isArray(options)
                ? options
                : options.split(/[,;]/).map(opt => opt.trim()).filter(opt => opt.length > 0);

            if (optionsArray.length < 2 || optionsArray.length > 10) {
                return res.redirect(`/manage/${guildId}?page=polls&error=invalid_options`);
            }

            // Parse duration (e.g., "30m", "2h", "1d") into seconds
            let durationSeconds = null;
            if (duration && duration.trim()) {
                const trimmedDuration = duration.trim();
                const match = trimmedDuration.match(/^(\d+)(s|m|h|d)$/);
                if (match) {
                    const value = parseInt(match[1]);
                    const unit = match[2];
                    switch (unit) {
                        case 's': durationSeconds = value; break;
                        case 'm': durationSeconds = value * 60; break;
                        case 'h': durationSeconds = value * 60 * 60; break;
                        case 'd': durationSeconds = value * 24 * 60 * 60; break;
                    }
                    logger.info('[Create Poll] Duration parsed:', {
                        input: trimmedDuration,
                        value,
                        unit,
                        durationSeconds
                    });
                } else {
                    logger.warn('[Create Poll] Invalid duration format:', { duration: trimmedDuration });
                }
            }

            // Use PollsManager from the bot client
            const pollsManager = global.botManager ?
                (global.botManager.getClientForGuild(guildId)?.pollsManager || global.pollsManager) :
                global.pollsManager;

            if (!pollsManager) {
                logger.error('[Create Poll] PollsManager not available');
                return res.redirect(`/manage/${guildId}?page=polls&error=system_unavailable`);
            }

            logger.info('[Create Poll] Attempting to create poll with:', {
                guildId,
                channel_id,
                creator_id: req.user.id,
                question,
                options: optionsArray,
                duration: durationSeconds,
                allow_multiple,
                anonymous,
                allow_write_in
            });

            // Create the poll
            const result = await pollsManager.createPoll(
                guildId,
                channel_id,
                req.user.id,
                question,
                optionsArray,
                durationSeconds,
                Boolean(allow_multiple),
                Boolean(anonymous),
                Boolean(allow_write_in)
            );

            logger.info('[Create Poll] Poll created successfully:', result);

            res.redirect(`/manage/${guildId}?page=polls&success=created`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/create-poll Error]', {
                error: error.message,
                stack: error.stack,
                guildId: req.params.guildId,
                userId: req.user?.id
            });
            res.redirect(`/manage/${req.params.guildId}?page=polls&error=creation_failed`);
        }
    });

    // End Poll
    app.post('/manage/:guildId/end-poll', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { pollId } = req.body;

            if (!pollId) {
                return res.redirect(`/manage/${guildId}?page=polls&error=missing_poll_id`);
            }

            // Get PollsManager
            const pollsManager = global.botManager ?
                (global.botManager.getClientForGuild(guildId)?.pollsManager || global.pollsManager) :
                global.pollsManager;

            if (!pollsManager) {
                logger.error('[End Poll] PollsManager not available');
                return res.redirect(`/manage/${guildId}?page=polls&error=system_unavailable`);
            }

            // End the poll
            const success = await pollsManager.endPoll(parseInt(pollId), 'Ended manually from dashboard');

            if (success) {
                logger.info('[POST /manage/:guildId/end-poll] Poll ended successfully:', { pollId });
                res.redirect(`/manage/${guildId}?page=polls&success=ended`);
            } else {
                res.redirect(`/manage/${guildId}?page=polls&error=end_failed`);
            }
        } catch (error) {
            logger.error('[POST /manage/:guildId/end-poll Error]', error);
            res.redirect(`/manage/${guildId}?page=polls&error=end_failed`);
        }
    });

    // Delete Poll
    app.post('/manage/:guildId/delete-poll', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { pollId } = req.body;

            if (!pollId) {
                return res.redirect(`/manage/${guildId}?page=polls&error=missing_poll_id`);
            }

            // Get the poll to find the message ID
            const [[poll]] = await pool.execute(
                'SELECT * FROM polls WHERE id = ? AND guild_id = ?',
                [pollId, guildId]
            );

            if (!poll) {
                return res.redirect(`/manage/${guildId}?page=polls&error=poll_not_found`);
            }

            // Get bot client
            const botClient = global.botManager ?
                global.botManager.getClientForGuild(guildId) :
                global.botClient;

            // Try to delete the Discord message
            if (botClient && poll.message_id && poll.channel_id) {
                try {
                    const guild = botClient.guilds.cache.get(guildId);
                    if (guild) {
                        const channel = guild.channels.cache.get(poll.channel_id);
                        if (channel) {
                            const message = await channel.messages.fetch(poll.message_id).catch(() => null);
                            if (message) {
                                await message.delete();
                            }
                        }
                    }
                } catch (error) {
                    logger.warn('[Delete Poll] Could not delete Discord message:', error.message);
                    // Continue anyway - we'll still delete from database
                }
            }

            // Delete from database
            await pool.execute('DELETE FROM polls WHERE id = ? AND guild_id = ?', [pollId, guildId]);

            logger.info('[POST /manage/:guildId/delete-poll] Poll deleted successfully:', { pollId });
            res.redirect(`/manage/${guildId}?page=polls&success=deleted`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/delete-poll Error]', error);
            res.redirect(`/manage/${guildId}?page=polls&error=delete_failed`);
        }
    });

    // Autoroles Config
    app.post('/manage/:guildId/update-autoroles', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { is_enabled, roles_to_assign } = req.body;

            logger.info('[POST /manage/:guildId/update-autoroles] Updating:', {
                guildId,
                is_enabled: Boolean(is_enabled),
                roles: roles_to_assign
            });

            // Convert roles array to JSON string
            const rolesJson = Array.isArray(roles_to_assign)
                ? JSON.stringify(roles_to_assign)
                : (roles_to_assign ? JSON.stringify([roles_to_assign]) : JSON.stringify([]));

            await pool.execute(`
                INSERT INTO autoroles_config (guild_id, is_enabled, roles_to_assign)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    is_enabled = VALUES(is_enabled),
                    roles_to_assign = VALUES(roles_to_assign)
            `, [
                guildId,
                is_enabled ? 1 : 0,
                rolesJson
            ]);

            res.redirect(`/manage/${guildId}?page=autoroles&success=updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-autoroles Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=autoroles&error=update`);
        }
    });

    // Weather Config
    app.post('/manage/:guildId/weather/config', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { enabled, alert_channel_id, monitor_regions, alert_types } = req.body;

            logger.info('[POST /manage/:guildId/weather/config] Updating:', {
                guildId,
                enabled: Boolean(enabled)
            });

            await pool.execute(`
                INSERT INTO weather_config (guild_id, enabled, alert_channel_id, monitor_regions, alert_types)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    enabled = VALUES(enabled),
                    alert_channel_id = VALUES(alert_channel_id),
                    monitor_regions = VALUES(monitor_regions),
                    alert_types = VALUES(alert_types)
            `, [
                guildId,
                enabled ? 1 : 0,
                alert_channel_id || null,
                monitor_regions || null,
                alert_types || null
            ]);

            res.redirect(`/manage/${guildId}?page=weather&success=updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/weather/config Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=weather&error=update`);
        }
    });

    // Economy Config
    app.post('/manage/:guildId/economy/config', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const {
                enabled,
                currency_name,
                currency_emoji,
                starting_balance,
                daily_amount,
                weekly_amount
            } = req.body;

            logger.info('[POST /manage/:guildId/economy/config] Updating:', {
                guildId,
                enabled: Boolean(enabled)
            });

            await pool.execute(`
                INSERT INTO economy_config (guild_id, enabled, currency_name, currency_emoji, starting_balance, daily_amount, weekly_amount)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    enabled = VALUES(enabled),
                    currency_name = VALUES(currency_name),
                    currency_emoji = VALUES(currency_emoji),
                    starting_balance = VALUES(starting_balance),
                    daily_amount = VALUES(daily_amount),
                    weekly_amount = VALUES(weekly_amount)
            `, [
                guildId,
                enabled ? 1 : 0,
                currency_name || 'coins',
                currency_emoji || '💰',
                parseInt(starting_balance) || 1000,
                parseInt(daily_amount) || 500,
                parseInt(weekly_amount) || 3500
            ]);

            res.redirect(`/manage/${guildId}?page=economy&success=updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/economy/config Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=economy&error=update`);
        }
    });

    // Birthday Config
    app.post('/manage/:guildId/birthday/config', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { enabled, announcement_channel_id, message_template } = req.body;

            logger.info('[POST /manage/:guildId/birthday/config] Updating:', {
                guildId,
                enabled: Boolean(enabled)
            });

            await pool.execute(`
                INSERT INTO birthday_config (guild_id, enabled, announcement_channel_id, message_template)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    enabled = VALUES(enabled),
                    announcement_channel_id = VALUES(announcement_channel_id),
                    message_template = VALUES(message_template)
            `, [
                guildId,
                enabled ? 1 : 0,
                announcement_channel_id || null,
                message_template || null
            ]);

            res.redirect(`/manage/${guildId}?page=birthday&success=updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/birthday/config Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=birthday&error=update`);
        }
    });

    // Moderation Config
    app.post('/manage/:guildId/update-moderation', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { mod_log_channel_id, muted_role_id } = req.body;

            logger.info('[POST /manage/:guildId/update-moderation] Updating:', {
                guildId,
                mod_log_channel_id,
                muted_role_id
            });

            await pool.execute(`
                INSERT INTO moderation_config (guild_id, mod_log_channel_id, muted_role_id)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    mod_log_channel_id = VALUES(mod_log_channel_id),
                    muted_role_id = VALUES(muted_role_id)
            `, [guildId, mod_log_channel_id || null, muted_role_id || null]);

            res.redirect(`/manage/${guildId}?page=moderation&success=updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-moderation Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=moderation&error=update`);
        }
    });

    // Add Escalation Rule
    app.post('/manage/:guildId/add-escalation-rule', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { infraction_count, time_period_hours, action } = req.body;

            logger.info('[POST /manage/:guildId/add-escalation-rule] Adding rule:', {
                guildId,
                infraction_count,
                time_period_hours,
                action
            });

            // Validate action
            const validActions = ['timeout', 'mute', 'kick', 'ban'];
            const normalizedAction = action === 'timeout' ? 'mute' : action;
            if (!validActions.includes(action)) {
                return res.redirect(`/manage/${guildId}?page=moderation&error=invalid_action`);
            }

            await pool.execute(`
                INSERT INTO escalation_rules (guild_id, infraction_count, time_period_hours, action)
                VALUES (?, ?, ?, ?)
            `, [guildId, parseInt(infraction_count), parseInt(time_period_hours), normalizedAction]);

            res.redirect(`/manage/${guildId}?page=moderation&success=rule_added`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/add-escalation-rule Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=moderation&error=add_rule`);
        }
    });

    // Remove Escalation Rule
    app.post('/manage/:guildId/remove-escalation-rule', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { ruleId } = req.body;

            logger.info('[POST /manage/:guildId/remove-escalation-rule] Removing rule:', {
                guildId,
                ruleId
            });

            await pool.execute(
                'DELETE FROM escalation_rules WHERE id = ? AND guild_id = ?',
                [ruleId, guildId]
            );

            res.redirect(`/manage/${guildId}?page=moderation&success=rule_removed`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/remove-escalation-rule Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=moderation&error=remove_rule`);
        }
    });

    // Add AutoMod Rule
    app.post('/manage/:guildId/add-automod-rule', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const {
                filter_type,
                action,
                action_duration_minutes,
                config_banned_words,
                config_massMention_limit,
                config_allCaps_limit,
                config_antiSpam_message_limit,
                config_antiSpam_time_period
            } = req.body;

            logger.info('[POST /manage/:guildId/add-automod-rule] Adding rule:', {
                guildId,
                filter_type,
                action
            });

            // Map form filter types to database enum values
            const filterTypeMap = {
                'bannedWords': 'banned_words',
                'massMention': 'mass_mentions',
                'allCaps': 'all_caps',
                'antiSpam': 'anti_spam'
            };
            const dbFilterType = filterTypeMap[filter_type] || filter_type;

            // Build config JSON based on filter type
            let config = {};
            switch (filter_type) {
                case 'bannedWords':
                    config = {
                        words: config_banned_words ? config_banned_words.split(',').map(w => w.trim().toLowerCase()).filter(w => w) : []
                    };
                    break;
                case 'massMention':
                    config = {
                        limit: parseInt(config_massMention_limit) || 5
                    };
                    break;
                case 'allCaps':
                    config = {
                        limit: parseInt(config_allCaps_limit) || 70
                    };
                    break;
                case 'antiSpam':
                    config = {
                        message_limit: parseInt(config_antiSpam_message_limit) || 5,
                        time_period: parseInt(config_antiSpam_time_period) || 10
                    };
                    break;
            }

            await pool.execute(`
                INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled)
                VALUES (?, ?, ?, ?, ?, TRUE)
            `, [
                guildId,
                dbFilterType,
                JSON.stringify(config),
                action,
                action === 'mute' ? (parseInt(action_duration_minutes) || 10) : null
            ]);

            res.redirect(`/manage/${guildId}?page=automod&success=rule_added`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/add-automod-rule Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=automod&error=add_rule`);
        }
    });

    // Remove AutoMod Rule
    app.post('/manage/:guildId/remove-automod-rule', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { ruleId } = req.body;

            logger.info('[POST /manage/:guildId/remove-automod-rule] Removing rule:', {
                guildId,
                ruleId
            });

            await pool.execute(
                'DELETE FROM automod_rules WHERE id = ? AND guild_id = ?',
                [ruleId, guildId]
            );

            res.redirect(`/manage/${guildId}?page=automod&success=rule_removed`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/remove-automod-rule Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=automod&error=remove_rule`);
        }
    });

    // Toggle AutoMod Rule
    app.post('/manage/:guildId/toggle-automod-rule', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { ruleId, enabled } = req.body;

            await pool.execute(
                'UPDATE automod_rules SET is_enabled = ? WHERE id = ? AND guild_id = ?',
                [enabled === 'true' || enabled === '1', ruleId, guildId]
            );

            res.redirect(`/manage/${guildId}?page=automod&success=rule_updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/toggle-automod-rule Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=automod&error=toggle_rule`);
        }
    });

    // Update AutoMod Rule
    app.post('/manage/:guildId/update-automod-rule', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const {
                ruleId,
                filter_type,
                action,
                action_duration_minutes,
                config_banned_words,
                config_massMention_limit,
                config_allCaps_limit,
                config_antiSpam_message_limit,
                config_antiSpam_time_period
            } = req.body;

            logger.info('[POST /manage/:guildId/update-automod-rule] Updating rule:', {
                guildId,
                ruleId,
                filter_type,
                action
            });

            // Build config based on filter type
            let config = {};
            if (filter_type === 'bannedWords' || filter_type === 'banned_words') {
                config = {
                    words: config_banned_words ? config_banned_words.split(',').map(w => w.trim()).filter(w => w) : []
                };
            } else if (filter_type === 'massMention' || filter_type === 'mass_mention') {
                config = { limit: parseInt(config_massMention_limit) || 5 };
            } else if (filter_type === 'allCaps' || filter_type === 'all_caps') {
                config = { limit: parseInt(config_allCaps_limit) || 70 };
            } else if (filter_type === 'antiSpam' || filter_type === 'anti_spam') {
                config = {
                    message_limit: parseInt(config_antiSpam_message_limit) || 5,
                    time_period: parseInt(config_antiSpam_time_period) || 10
                };
            }

            await pool.execute(
                'UPDATE automod_rules SET action = ?, action_duration_minutes = ?, config = ? WHERE id = ? AND guild_id = ?',
                [
                    action,
                    action === 'mute' ? (parseInt(action_duration_minutes) || null) : null,
                    JSON.stringify(config),
                    ruleId,
                    guildId
                ]
            );

            res.redirect(`/manage/${guildId}?page=automod&success=rule_updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-automod-rule Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=automod&error=update_rule`);
        }
    });

    // Streamer management routes
    app.post('/manage/:guildId/add-streamer', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { platform, username, discord_user_id, announcement_channel_id, override_nickname, custom_message, keep_summary } = req.body;

            logger.info('[POST /manage/:guildId/add-streamer] Received data:', {
                guildId,
                platform,
                username,
                discord_user_id,
                announcement_channel_id,
                override_nickname,
                custom_message,
                keep_summary
            });

            // Get or create streamer
            let streamerId;
            const [existingStreamer] = await pool.execute(
                'SELECT streamer_id FROM streamers WHERE platform = ? AND LOWER(username) = LOWER(?)',
                [platform, username]
            );

            if (existingStreamer.length > 0) {
                streamerId = existingStreamer[0].streamer_id;
                logger.info('[POST /manage/:guildId/add-streamer] Found existing streamer:', { streamerId });
                // Update discord_user_id if provided
                if (discord_user_id) {
                    await pool.execute(
                        'UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ?',
                        [discord_user_id, streamerId]
                    );
                    logger.info('[POST /manage/:guildId/add-streamer] Updated Discord ID:', { streamerId, discord_user_id });
                }
            } else {
                // Insert new streamer with temporary platform_user_id (will be updated by stream manager)
                // Use temp_{username}_{timestamp} to ensure uniqueness until real ID is fetched
                const tempPlatformUserId = `temp_${username}_${Date.now()}`;
                const [result] = await pool.execute(
                    'INSERT INTO streamers (platform, username, platform_user_id, discord_user_id) VALUES (?, ?, ?, ?)',
                    [platform, username, tempPlatformUserId, discord_user_id || null]
                );
                streamerId = result.insertId;
                logger.info('[POST /manage/:guildId/add-streamer] Created new streamer:', { streamerId, tempPlatformUserId });
            }

            // Check if subscription already exists
            const [existingSub] = await pool.execute(
                'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
                [guildId, streamerId]
            );

            if (existingSub.length > 0) {
                logger.warn('[POST /manage/:guildId/add-streamer] Subscription already exists:', { guildId, streamerId });
                return res.redirect(`/manage/${guildId}?page=streamers&error=exists`);
            }

            // Parse announcement_channel_id (can be multiple from select multiple)
            let channelId = null;
            if (announcement_channel_id) {
                if (Array.isArray(announcement_channel_id)) {
                    channelId = announcement_channel_id[0]; // Take first if multiple
                } else {
                    channelId = announcement_channel_id;
                }
            }

            logger.info('[POST /manage/:guildId/add-streamer] Creating subscription:', {
                guildId,
                streamerId,
                channelId,
                override_nickname,
                custom_message,
                delete_on_end: keep_summary ? 0 : 1
            });

            // Create subscription
            const [subResult] = await pool.execute(
                `INSERT INTO subscriptions
                (guild_id, streamer_id, announcement_channel_id, override_nickname, custom_message, delete_on_end)
                VALUES (?, ?, ?, ?, ?, ?)`,
                [guildId, streamerId, channelId || null, override_nickname || null, custom_message || null, keep_summary ? 0 : 1]
            );

            logger.info('[POST /manage/:guildId/add-streamer] Subscription created successfully:', {
                subscriptionId: subResult.insertId,
                affectedRows: subResult.affectedRows
            });

            res.redirect(`/manage/${guildId}?page=streamers&success=added`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/add-streamer Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=streamers&error=add`);
        }
    });

    app.post('/manage/:guildId/edit-consolidated-streamer', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { consolidated_streamer_id, discord_user_id, subscriptions } = req.body;

            logger.info('[POST /manage/:guildId/edit-consolidated-streamer] Received data:', {
                guildId,
                consolidated_streamer_id,
                discord_user_id,
                subscriptionsKeys: subscriptions ? Object.keys(subscriptions) : 'none',
                bodyKeys: Object.keys(req.body)
            });

            // Update Discord user ID link for the streamer
            if (consolidated_streamer_id) {
                logger.info('[POST /manage/:guildId/edit-consolidated-streamer] Updating Discord link:', {
                    streamer_id: consolidated_streamer_id,
                    discord_user_id: discord_user_id || 'null'
                });

                const [result] = await pool.execute(
                    'UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ?',
                    [discord_user_id || null, consolidated_streamer_id]
                );

                logger.info('[POST /manage/:guildId/edit-consolidated-streamer] Discord link update result:', {
                    affectedRows: result.affectedRows,
                    changedRows: result.changedRows
                });
            }

            // Update each subscription
            if (subscriptions && typeof subscriptions === 'object') {
                for (const [subId, subData] of Object.entries(subscriptions)) {
                    let channelId = null;
                    if (subData.announcement_channel_id) {
                        channelId = Array.isArray(subData.announcement_channel_id)
                            ? subData.announcement_channel_id[0]
                            : subData.announcement_channel_id;
                    }

                    logger.info('[POST /manage/:guildId/edit-consolidated-streamer] Updating subscription:', {
                        subId,
                        channelId,
                        live_role_id: subData.live_role_id,
                        delete_on_end: subData.keep_summary ? 0 : 1
                    });

                    // Handle video announcement channel (could be array or string)
                    let videoChannelId = null;
                    if (subData.video_announcement_channel_id) {
                        videoChannelId = Array.isArray(subData.video_announcement_channel_id)
                            ? subData.video_announcement_channel_id[0]
                            : subData.video_announcement_channel_id;
                    }

                    const [result] = await pool.execute(
                        `UPDATE subscriptions
                        SET announcement_channel_id = ?,
                            live_role_id = ?,
                            override_nickname = ?,
                            override_avatar_url = ?,
                            custom_message = ?,
                            delete_on_end = ?,
                            notify_videos = ?,
                            video_announcement_channel_id = ?
                        WHERE subscription_id = ? AND guild_id = ?`,
                        [
                            channelId || null,
                            subData.live_role_id || null,
                            subData.override_nickname || null,
                            subData.override_avatar_url || null,
                            subData.custom_message || null,
                            subData.keep_summary ? 0 : 1,
                            subData.notify_videos ? 1 : 0,
                            videoChannelId || null,
                            subId,
                            guildId
                        ]
                    );

                    logger.info('[POST /manage/:guildId/edit-consolidated-streamer] Subscription update result:', {
                        subId,
                        affectedRows: result.affectedRows,
                        changedRows: result.changedRows
                    });
                }
            }

            res.redirect(`/manage/${guildId}?page=streamers&success=updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/edit-consolidated-streamer Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=streamers&error=update`);
        }
    });

    app.post('/manage/:guildId/delete-subscription', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { subscriptionId } = req.body;

            logger.info('[POST /manage/:guildId/delete-subscription] Deleting subscription:', { guildId, subscriptionId });

            // Get streamer ID before deleting subscription
            const [sub] = await pool.execute(
                'SELECT streamer_id FROM subscriptions WHERE subscription_id = ? AND guild_id = ?',
                [subscriptionId, guildId]
            );

            if (sub.length === 0) {
                return res.status(404).json({ success: false, error: 'Subscription not found' });
            }

            // Delete subscription
            await pool.execute(
                'DELETE FROM subscriptions WHERE subscription_id = ? AND guild_id = ?',
                [subscriptionId, guildId]
            );

            // Delete associated live announcements
            await pool.execute(
                'DELETE FROM live_announcements WHERE guild_id = ? AND streamer_id = ?',
                [guildId, sub[0].streamer_id]
            );

            logger.info('[POST /manage/:guildId/delete-subscription] Successfully deleted subscription');
            res.json({ success: true });
        } catch (error) {
            logger.error('[POST /manage/:guildId/delete-subscription Error]', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/manage/:guildId/delete-streamer', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { subscriptionId } = req.body;

            // Get streamer ID before deleting subscription
            const [sub] = await pool.execute(
                'SELECT streamer_id FROM subscriptions WHERE subscription_id = ? AND guild_id = ?',
                [subscriptionId, guildId]
            );

            // Delete subscription
            await pool.execute(
                'DELETE FROM subscriptions WHERE subscription_id = ? AND guild_id = ?',
                [subscriptionId, guildId]
            );

            // Delete associated live announcements
            if (sub.length > 0) {
                await pool.execute(
                    'DELETE FROM live_announcements WHERE guild_id = ? AND streamer_id = ?',
                    [guildId, sub[0].streamer_id]
                );
            }

            res.redirect(`/manage/${guildId}?page=streamers&success=deleted`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/delete-streamer Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=streamers&error=delete`);
        }
    });

    // Team management routes
    app.post('/manage/:guildId/add-team', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { teamName, announcementChannelId, liveRoleId } = req.body;

            // Check if team already exists for this guild
            const [existingTeam] = await pool.execute(
                'SELECT id FROM twitch_teams WHERE guild_id = ? AND team_name = ?',
                [guildId, teamName]
            );

            if (existingTeam.length > 0) {
                return res.redirect(`/manage/${guildId}?page=teams&error=exists`);
            }

            // Insert team
            const [result] = await pool.execute(
                `INSERT INTO twitch_teams (guild_id, team_name, announcement_channel_id, live_role_id)
                VALUES (?, ?, ?, ?)`,
                [guildId, teamName, announcementChannelId || null, liveRoleId || null]
            );

            // Trigger team sync
            const { syncTwitchTeam } = await import('../core/team-sync.js');
            if (syncTwitchTeam) {
                await syncTwitchTeam(result.insertId, client);
            }

            res.redirect(`/manage/${guildId}?page=teams&success=added`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/add-team Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=teams&error=add`);
        }
    });

    app.post('/manage/:guildId/update-team', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { teamId, announcementChannelId, liveRoleId, webhookName, webhookAvatarUrl } = req.body;

            await pool.execute(
                `UPDATE twitch_teams
                SET announcement_channel_id = ?, live_role_id = ?, webhook_name = ?, webhook_avatar_url = ?
                WHERE id = ? AND guild_id = ?`,
                [
                    announcementChannelId || null,
                    liveRoleId || null,
                    webhookName || null,
                    webhookAvatarUrl || null,
                    teamId,
                    guildId
                ]
            );

            res.redirect(`/manage/${guildId}?page=teams&success=updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-team Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=teams&error=update`);
        }
    });

    app.post('/manage/:guildId/delete-team', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { teamId } = req.body;

            // Get all streamer IDs associated with this team before deleting
            const [streamers] = await pool.execute(
                'SELECT streamer_id FROM subscriptions WHERE team_subscription_id = ?',
                [teamId]
            );

            const streamerIds = streamers.map(s => s.streamer_id);

            // Delete all subscriptions associated with this team
            await pool.execute(
                'DELETE FROM subscriptions WHERE team_subscription_id = ?',
                [teamId]
            );

            // Delete associated live announcements for those streamers in this guild
            if (streamerIds.length > 0) {
                const placeholders = streamerIds.map(() => '?').join(',');
                await pool.execute(
                    `DELETE FROM live_announcements WHERE guild_id = ? AND streamer_id IN (${placeholders})`,
                    [guildId, ...streamerIds]
                );
            }

            // Delete team
            await pool.execute(
                'DELETE FROM twitch_teams WHERE id = ? AND guild_id = ?',
                [teamId, guildId]
            );

            res.redirect(`/manage/${guildId}?page=teams&success=deleted`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/delete-team Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=teams&error=delete`);
        }
    });

    // Twitch Schedule Sync routes
    app.post('/manage/:guildId/twitch-schedules/sync', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { streamerId, channelId } = req.body;

            if (!streamerId || !channelId) {
                return res.redirect(`/manage/${guildId}?page=twitch-schedules&error=missing_fields`);
            }

            // Check if sync already exists
            const [existing] = await pool.execute(
                'SELECT id FROM twitch_schedule_sync_config WHERE guild_id = ? AND streamer_id = ? AND discord_channel_id = ?',
                [guildId, streamerId, channelId]
            );

            if (existing.length > 0) {
                return res.redirect(`/manage/${guildId}?page=twitch-schedules&error=duplicate`);
            }

            // Create new sync
            await pool.execute(
                'INSERT INTO twitch_schedule_sync_config (guild_id, streamer_id, discord_channel_id, is_enabled) VALUES (?, ?, ?, 1)',
                [guildId, streamerId, channelId]
            );

            res.redirect(`/manage/${guildId}?page=twitch-schedules&success=created`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/twitch-schedules/sync Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=twitch-schedules&error=create`);
        }
    });

    app.post('/manage/:guildId/twitch-schedules/delete', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { syncId } = req.body;

            if (!syncId) {
                return res.redirect(`/manage/${guildId}?page=twitch-schedules&error=missing_id`);
            }

            // Delete sync
            await pool.execute(
                'DELETE FROM twitch_schedule_sync_config WHERE id = ? AND guild_id = ?',
                [syncId, guildId]
            );

            res.redirect(`/manage/${guildId}?page=twitch-schedules&success=deleted`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/twitch-schedules/delete Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=twitch-schedules&error=delete`);
        }
    });

    app.post('/manage/:guildId/update-tempchannels', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { creator_channel_id, category_id, naming_template } = req.body;

            logger.info('[POST /manage/:guildId/update-tempchannels] Received:', { guildId, creator_channel_id, category_id, naming_template });

            if (!creator_channel_id || !category_id) {
                return res.redirect(`/manage/${guildId}?tab=utilities&error=missing_fields`);
            }

            // Check if config exists
            const [existing] = await pool.execute(
                'SELECT * FROM temp_channel_config WHERE guild_id = ?',
                [guildId]
            );

            if (existing.length === 0) {
                // Insert new config
                await pool.execute(
                    `INSERT INTO temp_channel_config (guild_id, creator_channel_id, category_id, naming_template)
                     VALUES (?, ?, ?, ?)`,
                    [guildId, creator_channel_id, category_id, naming_template || "{user}'s Channel"]
                );
            } else {
                // Update existing config
                await pool.execute(
                    `UPDATE temp_channel_config
                     SET creator_channel_id = ?, category_id = ?, naming_template = ?
                     WHERE guild_id = ?`,
                    [creator_channel_id, category_id, naming_template || "{user}'s Channel", guildId]
                );
                logger.info('[POST /manage/:guildId/update-tempchannels] Updated config successfully');
            }

            res.redirect(`/manage/${guildId}?tab=utilities&success=true`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-tempchannels Error]', error);
            res.redirect(`/manage/${req.params.guildId}?tab=utilities&error=update`);
        }
    });

    // ===== GAMES MANAGEMENT ROUTES =====

    // Add trivia question
    app.post('/manage/:guildId/games/trivia/add', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { question, category, difficulty, correct_answer, incorrect_answers, points_value } = req.body;

            // Validate inputs
            if (!question || !category || !difficulty || !correct_answer || !incorrect_answers) {
                return res.redirect(`/manage/${guildId}?page=games&error=missing_fields`);
            }

            // Parse incorrect answers
            const incorrectAnswersArray = incorrect_answers.split(',').map(a => a.trim()).filter(a => a.length > 0);
            if (incorrectAnswersArray.length !== 3) {
                return res.redirect(`/manage/${guildId}?page=games&error=invalid_answers`);
            }

            // Insert trivia question
            await pool.execute(`
                INSERT INTO trivia_questions (guild_id, category, difficulty, question, correct_answer, incorrect_answers, points_value)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [
                guildId,
                category,
                difficulty,
                question,
                correct_answer,
                JSON.stringify(incorrectAnswersArray),
                points_value || 10
            ]);

            logger.info(`[Trivia] Added question for guild ${guildId}: ${question.substring(0, 50)}...`);
            res.redirect(`/manage/${guildId}?page=games&success=trivia_added`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/games/trivia/add Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=games&error=trivia_add`);
        }
    });

    // Delete trivia question
    app.post('/manage/:guildId/games/trivia/delete', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { question_id } = req.body;

            await pool.execute('DELETE FROM trivia_questions WHERE question_id = ? AND guild_id = ?', [question_id, guildId]);

            logger.info(`[Trivia] Deleted question ${question_id} from guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=games&success=trivia_deleted`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/games/trivia/delete Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=games&error=trivia_delete`);
        }
    });

    // Add hangman word
    app.post('/manage/:guildId/games/hangman/add', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { word, difficulty, category, hint } = req.body;

            // Validate inputs
            if (!word || !difficulty || !category) {
                return res.redirect(`/manage/${guildId}?page=games&error=missing_fields`);
            }

            // Sanitize word (remove non-letter characters and uppercase)
            const sanitizedWord = word.toUpperCase().replace(/[^A-Z]/g, '');
            if (sanitizedWord.length === 0) {
                return res.redirect(`/manage/${guildId}?page=games&error=invalid_word`);
            }

            // Insert hangman word
            await pool.execute(`
                INSERT INTO hangman_words (guild_id, word, difficulty, category, hint)
                VALUES (?, ?, ?, ?, ?)
            `, [
                guildId,
                sanitizedWord,
                difficulty,
                category,
                hint || null
            ]);

            logger.info(`[Hangman] Added word for guild ${guildId}: ${sanitizedWord}`);
            res.redirect(`/manage/${guildId}?page=games&success=hangman_added`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/games/hangman/add Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=games&error=hangman_add`);
        }
    });

    // Delete hangman word
    app.post('/manage/:guildId/games/hangman/delete', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { word_id } = req.body;

            await pool.execute('DELETE FROM hangman_words WHERE word_id = ? AND guild_id = ?', [word_id, guildId]);

            logger.info(`[Hangman] Deleted word ${word_id} from guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=games&success=hangman_deleted`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/games/hangman/delete Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=games&error=hangman_delete`);
        }
    });

    // Reset counting channel
    app.post('/manage/:guildId/games/counting/reset', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { channel_id } = req.body;

            await pool.execute(`
                UPDATE counting_channels
                SET current_count = 0, last_user_id = NULL
                WHERE channel_id = ? AND guild_id = ?
            `, [channel_id, guildId]);

            logger.info(`[Counting] Reset channel ${channel_id} in guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=games&success=counting_reset`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/games/counting/reset Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=games&error=counting_reset`);
        }
    });

    // ===== FORMS MANAGEMENT ROUTES =====

    // Create form
    app.post('/manage/:guildId/forms/create', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { form_name, form_description, submit_channel_id } = req.body;

            if (!form_name) {
                return res.redirect(`/manage/${guildId}?page=forms&error=missing_name`);
            }

            await pool.execute(`
                INSERT INTO forms (guild_id, form_name, form_description, submit_channel_id)
                VALUES (?, ?, ?, ?)
            `, [guildId, form_name, form_description || null, submit_channel_id || null]);

            logger.info(`[Forms] Created form for guild ${guildId}: ${form_name}`);
            res.redirect(`/manage/${guildId}?page=forms&success=form_created`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/create Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=forms&error=create_failed`);
        }
    });

    // Edit form
    app.post('/manage/:guildId/forms/edit/:formId', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const formId = req.params.formId;
            const { form_name, form_description, submit_channel_id } = req.body;

            if (!form_name) {
                return res.redirect(`/manage/${guildId}?page=forms&error=missing_name`);
            }

            await pool.execute(`
                UPDATE forms
                SET form_name = ?, form_description = ?, submit_channel_id = ?
                WHERE form_id = ? AND guild_id = ?
            `, [form_name, form_description || null, submit_channel_id || null, formId, guildId]);

            logger.info(`[Forms] Updated form ${formId} for guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=forms&success=form_updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/edit/:formId Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=forms&error=edit_failed`);
        }
    });

    // Delete form
    app.post('/manage/:guildId/forms/delete/:formId', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const formId = req.params.formId;

            await pool.execute('DELETE FROM forms WHERE form_id = ? AND guild_id = ?', [formId, guildId]);

            logger.info(`[Forms] Deleted form ${formId} from guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=forms&success=form_deleted`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/delete/:formId Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=forms&error=delete_failed`);
        }
    });

    // Get form questions (API endpoint)
    app.get('/manage/:guildId/forms/:formId/questions', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const formId = req.params.formId;

            const [questions] = await pool.execute(
                'SELECT * FROM form_questions WHERE form_id = ? ORDER BY question_order ASC, question_id ASC',
                [formId]
            );

            res.json(questions);
        } catch (error) {
            logger.error('[GET /manage/:guildId/forms/:formId/questions Error]', error);
            res.status(500).json({ error: 'Failed to fetch questions' });
        }
    });

    // Delete form question
    app.post('/manage/:guildId/forms/questions/delete/:questionId', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const questionId = req.params.questionId;

            await pool.execute('DELETE FROM form_questions WHERE question_id = ?', [questionId]);

            logger.info(`[Forms] Deleted question ${questionId}`);
            res.redirect(`/manage/${guildId}?page=forms&success=question_deleted`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/questions/delete/:questionId Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=forms&error=question_delete_failed`);
        }
    });

    // Get form submissions (API endpoint)
    app.get('/manage/:guildId/forms/:formId/submissions', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const formId = req.params.formId;

            const [submissions] = await pool.execute(
                'SELECT * FROM form_submissions WHERE form_id = ? ORDER BY submitted_at DESC',
                [formId]
            );

            res.json(submissions);
        } catch (error) {
            logger.error('[GET /manage/:guildId/forms/:formId/submissions Error]', error);
            res.status(500).json({ error: 'Failed to fetch submissions' });
        }
    });

    // Export streamer subscriptions as CSV
    app.get('/manage/:guildId/export', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;

            // Get all stream notifications for this guild
            const [subscriptions] = await pool.execute(
                `SELECT streamer_name, platform, channel_id, role_id, message, created_at
                 FROM stream_notifications
                 WHERE guild_id = ?
                 ORDER BY platform, streamer_name`,
                [guildId]
            );

            // Create CSV content
            const csvHeaders = ['Streamer Name', 'Platform', 'Channel ID', 'Role ID', 'Message', 'Created At'];
            const csvRows = subscriptions.map(sub => [
                sub.streamer_name || '',
                sub.platform || '',
                sub.channel_id || '',
                sub.role_id || '',
                (sub.message || '').replace(/"/g, '""'), // Escape quotes
                sub.created_at ? new Date(sub.created_at).toISOString() : ''
            ]);

            // Build CSV string
            const csvContent = [
                csvHeaders.join(','),
                ...csvRows.map(row => row.map(cell => `"${cell}"`).join(','))
            ].join('\n');

            // Send as downloadable file
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="subscriptions_${guildId}.csv"`);
            res.send(csvContent);

        } catch (error) {
            logger.error('[GET /manage/:guildId/export Error]', error);
            res.status(500).send('Failed to export subscriptions');
        }
    });

    // Create form panel
    app.post('/manage/:guildId/forms/create-panel', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { form_id, channel_id, panel_title, panel_description, button_text } = req.body;

            if (!form_id || !channel_id) {
                return res.redirect(`/manage/${guildId}?page=forms&error=missing_fields`);
            }

            // Get the bot client
            const bot = getBotForGuild(guildId);
            if (!bot) {
                return res.redirect(`/manage/${guildId}?page=forms&error=bot_not_found`);
            }

            // Get form details
            const [forms] = await pool.execute('SELECT * FROM forms WHERE form_id = ? AND guild_id = ?', [form_id, guildId]);
            if (forms.length === 0) {
                return res.redirect(`/manage/${guildId}?page=forms&error=form_not_found`);
            }

            const form = forms[0];
            const channel = await bot.channels.fetch(channel_id);

            if (!channel) {
                return res.redirect(`/manage/${guildId}?page=forms&error=channel_not_found`);
            }

            // Create embed
            const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(panel_title || form.form_name)
                .setDescription(panel_description || form.form_description || 'Click the button below to fill out this form')
                .setTimestamp();

            // Create button
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`form_open_${form_id}`)
                        .setLabel(button_text || 'Open Form')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('📝')
                );

            await channel.send({ embeds: [embed], components: [row] });

            logger.info(`[Forms] Created panel for form ${form_id} in channel ${channel_id}`);
            res.redirect(`/manage/${guildId}?page=forms&success=panel_created`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/create-panel Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=forms&error=panel_failed`);
        }
    });

    // ===== STARBOARD CONFIGURATION ROUTES =====

    // Save starboard configuration
    app.post('/manage/:guildId/starboard/config', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { enabled, channelId, threshold } = req.body;

            const starThreshold = parseInt(threshold) || 5;
            const starChannelId = channelId || null;

            // Check if config exists
            const [existing] = await pool.execute(
                'SELECT guild_id FROM starboard_config WHERE guild_id = ?',
                [guildId]
            );

            if (existing.length === 0) {
                // Insert new config
                await pool.execute(
                    `INSERT INTO starboard_config (guild_id, channel_id, star_threshold)
                     VALUES (?, ?, ?)`,
                    [guildId, starChannelId, starThreshold]
                );
            } else {
                // Update existing config
                await pool.execute(
                    `UPDATE starboard_config
                     SET channel_id = ?, star_threshold = ?
                     WHERE guild_id = ?`,
                    [starChannelId, starThreshold, guildId]
                );
            }

            logger.info(`[Starboard] Config updated for guild ${guildId} - Threshold: ${starThreshold}`);
            res.redirect(`/manage/${guildId}?page=starboard&success=config_saved`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/starboard/config Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=starboard&error=save_failed`);
        }
    });

    // ===== REACTION ROLE MANAGEMENT ROUTES =====

    // Create reaction role panel
    app.post('/manage/:guildId/create-rr-panel', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { panel_name, channel_id, description, embed_color, thumbnail_url, image_url, panel_mode, interaction_type } = req.body;

            if (!panel_name || !channel_id) {
                return res.redirect(`/manage/${guildId}?page=reaction-roles&error=missing_fields`);
            }

            // Insert panel into database with PENDING message_id
            const [result] = await pool.execute(
                `INSERT INTO reaction_role_panels (
                    guild_id, channel_id, message_id, panel_name, description,
                    embed_color, thumbnail_url, image_url, panel_mode, interaction_type
                ) VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)`,
                [
                    guildId,
                    channel_id,
                    panel_name,
                    description || null,
                    embed_color || '#a78bfa',
                    thumbnail_url || null,
                    image_url || null,
                    panel_mode || 'normal',
                    interaction_type || 'button'
                ]
            );

            logger.info(`[Reaction Roles] Panel created in database for guild ${guildId}: ${panel_name} (ID: ${result.insertId})`);

            // Note: Panel is created with message_id = 'PENDING'
            // User needs to add roles and then "post" the panel via the dashboard
            res.redirect(`/manage/${guildId}?page=reaction-roles&success=panel_created&note=add_roles_then_post`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/create-rr-panel Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=reaction-roles&error=create_failed`);
        }
    });

    // Delete reaction role panel
    app.post('/manage/:guildId/delete-rr-panel', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { panelId } = req.body;

            // Get panel info to delete Discord message
            const [panelRows] = await pool.execute(
                'SELECT channel_id, message_id FROM reaction_role_panels WHERE id = ? AND guild_id = ?',
                [panelId, guildId]
            );

            // Delete the Discord message if it exists
            if (panelRows.length > 0) {
                const panel = panelRows[0];
                try {
                    // Get the appropriate bot client for this guild
                    const client = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient();

                    if (client && panel.channel_id && panel.message_id) {
                        const channel = await client.channels.fetch(panel.channel_id).catch(() => null);
                        if (channel) {
                            await channel.messages.delete(panel.message_id).catch(err => {
                                logger.warn(`[Reaction Roles] Could not delete message ${panel.message_id}: ${err.message}`);
                            });
                            logger.info(`[Reaction Roles] Deleted Discord message ${panel.message_id} in channel ${panel.channel_id}`);
                        }
                    }
                } catch (discordError) {
                    logger.warn(`[Reaction Roles] Error deleting Discord message for panel ${panelId}:`, discordError);
                    // Continue with database deletion even if Discord deletion fails
                }
            }

            // Delete mappings first (if not handled by CASCADE)
            await pool.execute(
                'DELETE FROM reaction_role_mappings WHERE panel_id = ?',
                [panelId]
            );

            // Delete panel
            await pool.execute(
                'DELETE FROM reaction_role_panels WHERE id = ? AND guild_id = ?',
                [panelId, guildId]
            );

            logger.info(`[Reaction Roles] Panel deleted for guild ${guildId}: ${panelId}`);
            res.redirect(`/manage/${guildId}?page=reaction-roles&success=panel_deleted`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/delete-rr-panel Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=reaction-roles&error=delete_failed`);
        }
    });

    // Add reaction role mapping
    app.post('/manage/:guildId/add-rr-mapping', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { panelId, emoji_id, role_id } = req.body;

            if (!panelId || !emoji_id || !role_id) {
                return res.redirect(`/manage/${guildId}?page=reaction-roles&error=missing_fields`);
            }

            // Verify panel exists and belongs to this guild
            const [panels] = await pool.execute(
                'SELECT * FROM reaction_role_panels WHERE id = ? AND guild_id = ?',
                [panelId, guildId]
            );

            if (panels.length === 0) {
                return res.redirect(`/manage/${guildId}?page=reaction-roles&error=panel_not_found`);
            }

            const panel = panels[0];

            // Insert mapping
            await pool.execute(
                'INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)',
                [panelId, role_id, emoji_id]
            );

            // Get the bot client for this guild
            const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient() || client;

            // Add reaction to the message
            try {
                const channel = await botClient.channels.fetch(panel.channel_id);
                const message = await channel.messages.fetch(panel.message_id);
                await message.react(emoji_id);
            } catch (error) {
                logger.warn(`[Reaction Roles] Failed to add reaction to message: ${error.message}`);
            }

            logger.info(`[Reaction Roles] Mapping added for panel ${panelId}: ${emoji_id} -> ${role_id}`);
            res.redirect(`/manage/${guildId}?page=reaction-roles&success=mapping_added`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/add-rr-mapping Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=reaction-roles&error=add_mapping_failed`);
        }
    });

    // Remove reaction role mapping
    app.post('/manage/:guildId/remove-rr-mapping', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { mappingId } = req.body;

            // Get mapping details before deleting
            const [mappings] = await pool.execute(
                `SELECT rrm.*, rrp.guild_id, rrp.channel_id, rrp.message_id
                 FROM reaction_role_mappings rrm
                 JOIN reaction_role_panels rrp ON rrm.panel_id = rrp.id
                 WHERE rrm.id = ? AND rrp.guild_id = ?`,
                [mappingId, guildId]
            );

            if (mappings.length === 0) {
                return res.redirect(`/manage/${guildId}?page=reaction-roles&error=mapping_not_found`);
            }

            const mapping = mappings[0];

            // Delete mapping
            await pool.execute(
                'DELETE FROM reaction_role_mappings WHERE id = ?',
                [mappingId]
            );

            // Try to remove reaction from message
            try {
                // Get the bot client for this guild
                const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient() || client;

                const channel = await botClient.channels.fetch(mapping.channel_id);
                const message = await channel.messages.fetch(mapping.message_id);
                const reaction = message.reactions.cache.get(mapping.emoji_id);
                if (reaction) {
                    await reaction.users.remove(botClient.user.id);
                }
            } catch (error) {
                logger.warn(`[Reaction Roles] Failed to remove reaction from message: ${error.message}`);
            }

            logger.info(`[Reaction Roles] Mapping removed: ${mappingId}`);
            res.redirect(`/manage/${guildId}?page=reaction-roles&success=mapping_removed`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/remove-rr-mapping Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=reaction-roles&error=remove_mapping_failed`);
        }
    });

    // API route to post reaction role panel to Discord
    app.post('/api/guilds/:guildId/reaction-roles/:panelId/post', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, panelId } = req.params;

            // Fetch panel from database
            const [panels] = await pool.execute(
                'SELECT * FROM reaction_role_panels WHERE id = ? AND guild_id = ?',
                [panelId, guildId]
            );

            if (panels.length === 0) {
                return res.json({ success: false, error: 'Panel not found' });
            }

            const panel = panels[0];

            // Check if panel already posted
            if (panel.message_id && panel.message_id !== 'PENDING') {
                return res.json({ success: false, error: 'Panel already posted to Discord. Delete and recreate to post again.' });
            }

            // Fetch all mappings for this panel
            const [mappings] = await pool.execute(
                'SELECT * FROM reaction_role_mappings WHERE panel_id = ? ORDER BY id ASC',
                [panelId]
            );

            if (mappings.length === 0) {
                return res.json({ success: false, error: 'No role mappings found. Add at least one role mapping before posting.' });
            }

            // Get the correct bot client for this guild
            const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient() || client;

            if (!botClient) {
                return res.json({ success: false, error: 'Bot client not available' });
            }

            // Fetch channel
            const channel = await botClient.channels.fetch(panel.channel_id).catch(() => null);
            if (!channel || !channel.isTextBased()) {
                return res.json({ success: false, error: 'Channel not found or is not a text channel' });
            }

            // Build embed
            const embed = new EmbedBuilder()
                .setTitle(panel.panel_name)
                .setColor(panel.embed_color || '#a78bfa');

            if (panel.description) {
                embed.setDescription(panel.description);
            }

            if (panel.thumbnail_url) {
                embed.setThumbnail(panel.thumbnail_url);
            }

            if (panel.image_url) {
                embed.setImage(panel.image_url);
            }

            // Add role mappings to embed as fields
            let rolesText = '';
            for (const mapping of mappings) {
                const role = await botClient.guilds.cache.get(guildId)?.roles.fetch(mapping.role_id).catch(() => null);
                const roleName = role ? role.name : 'Unknown Role';
                rolesText += `${mapping.emoji_id} - <@&${mapping.role_id}> (${roleName})\n`;
            }

            if (rolesText) {
                embed.addFields({ name: 'Available Roles', value: rolesText, inline: false });
            }

            // Post message to Discord
            const message = await channel.send({ embeds: [embed] });

            // Add reactions for each mapping
            for (const mapping of mappings) {
                try {
                    await message.react(mapping.emoji_id);
                } catch (reactionError) {
                    logger.warn(`[Reaction Roles] Failed to add reaction ${mapping.emoji_id}: ${reactionError.message}`);
                }
            }

            // Update database with message_id
            await pool.execute(
                'UPDATE reaction_role_panels SET message_id = ? WHERE id = ?',
                [message.id, panelId]
            );

            logger.info(`[Reaction Roles] Panel ${panelId} posted to Discord in channel ${channel.id} as message ${message.id}`);

            res.json({
                success: true,
                message_id: message.id,
                channel_id: channel.id
            });
        } catch (error) {
            logger.error(`[POST /api/guilds/:guildId/reaction-roles/:panelId/post Error]`, error);
            res.json({
                success: false,
                error: error.message || 'Failed to post panel to Discord'
            });
        }
    });

    app.get('/servers', checkAuth, (req, res) => res.redirect('/dashboard'));
    app.get('/manage', checkAuth, (req, res) => res.redirect('/dashboard'));

    // Global Ban Appeal page (public - no auth required to view)
    app.get('/appeal', (req, res) => {
        res.render('appeal-tailwind', {
            user: req.user || null,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID
        });
    });

    // Appeal API: get ban status and appeal history
    app.get('/api/appeal/status', checkAuth, async (req, res) => {
        try {
            if (!client.globalBanManager) {
                return res.json({ success: false, message: 'Global ban system is not available.' });
            }

            const userId = req.user.id;

            // Get active ban entry
            const [entries] = await pool.execute(
                'SELECT id, severity, category, reason, created_at FROM global_ban_entries WHERE user_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1',
                [userId]
            );

            // Get appeal history
            const [appeals] = await pool.execute(
                'SELECT id, status, reason, evidence, reviewer_response, created_at, reviewed_at FROM global_ban_appeals WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
                [userId]
            );

            res.json({
                success: true,
                activeEntry: entries[0] || null,
                appeals
            });
        } catch (error) {
            logger.error('[Appeal API] Error fetching status', { error: error.message, userId: req.user.id });
            res.json({ success: false, message: 'Failed to fetch ban status.' });
        }
    });

    // Appeal API: submit an appeal
    app.post('/api/appeal', checkAuth, async (req, res) => {
        try {
            if (!client.globalBanManager) {
                return res.json({ success: false, message: 'Global ban system is not available.' });
            }

            const { reason, evidence } = req.body;

            if (!reason || reason.trim().length < 20) {
                return res.json({ success: false, message: 'Appeal reason must be at least 20 characters.' });
            }

            const result = await client.globalBanManager.submitAppeal(req.user.id, reason.trim(), evidence || null);
            res.json(result);
        } catch (error) {
            logger.error('[Appeal API] Error submitting appeal', { error: error.message, userId: req.user.id });
            res.json({ success: false, message: 'Failed to submit appeal.' });
        }
    });

    // Public Report page (no auth required to view)
    app.get('/report', (req, res) => {
        res.render('report-tailwind', {
            user: req.user || null,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID
        });
    });

    // Report API: submit a report
    app.post('/api/report', checkAuth, async (req, res) => {
        try {
            if (!client.globalBanManager) {
                return res.json({ success: false, message: 'Global ban system is not available.' });
            }

            const { target_user_id, category, severity, reason, evidence } = req.body;

            // Validate user ID
            if (!target_user_id || !/^\d{17,20}$/.test(target_user_id.trim())) {
                return res.json({ success: false, message: 'Invalid Discord User ID. Must be 17-20 digits.' });
            }

            // Cannot report yourself
            if (target_user_id.trim() === req.user.id) {
                return res.json({ success: false, message: 'You cannot report yourself.' });
            }

            if (!reason || reason.trim().length < 20) {
                return res.json({ success: false, message: 'Reason must be at least 20 characters.' });
            }

            const validCategories = ['phishing', 'scam', 'spam', 'raid', 'harassment', 'selfbot', 'mass_dm', 'impersonation', 'other'];
            const validSeverities = ['critical', 'high', 'medium', 'low'];

            const result = await client.globalBanManager.reportUser(
                req.user.id,
                'website',
                target_user_id.trim(),
                validCategories.includes(category) ? category : 'other',
                validSeverities.includes(severity) ? severity : 'medium',
                evidence || null,
                reason.trim()
            );

            res.json(result);
        } catch (error) {
            logger.error('[Report API] Error submitting report', { error: error.message, userId: req.user.id });
            res.json({ success: false, message: 'Failed to submit report.' });
        }
    });

    // Commands page
    app.get('/commands', (req, res) => {
        const commands = [];
        const categoriesSet = new Set();

        if (client && client.commands) {
            client.commands.forEach(cmd => {
                const category = cmd.category || 'General';
                categoriesSet.add(category);
                commands.push({
                    name: cmd.data ? cmd.data.name : cmd.name,
                    description: cmd.data ? cmd.data.description : cmd.description,
                    category: category,
                    usage: cmd.usage || '',
                    examples: cmd.examples || []
                });
            });
        }

        const categories = Array.from(categoriesSet).sort();
        res.render('commands-tailwind', {
            user: req.user,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID,
            commands: commands,
            categories: categories
        });
    });

    // Status page
    app.get('/status', async (req, res) => {
        try {
            const uptime = process.uptime();

            // Use shared function for consistent server count (from live bot caches)
            const serverStats = getServerStats(client);
            const totalGuilds = serverStats.guilds;
            const totalMembers = serverStats.users;

            // Fetch live streamers and deduplicate by unique identifier
            const [announcements] = await pool.query(`
                SELECT
                    la.username,
                    la.platform,
                    la.discord_user_id,
                    s.profile_image_url,
                    MIN(la.stream_started_at) as earliest_start
                FROM live_announcements la
                LEFT JOIN streamers s ON la.streamer_id = s.streamer_id
                WHERE la.offline_check_count < 4
                GROUP BY
                    COALESCE(la.discord_user_id, CONCAT(la.platform, ':', la.username)),
                    la.platform
                ORDER BY earliest_start DESC
            `);

            // Group by unique streamer (same discord_user_id or username)
            const streamerMap = new Map();

            for (const ann of announcements) {
                // Use discord_user_id as primary identifier, fall back to username
                const key = ann.discord_user_id || ann.username.toLowerCase();

                if (!streamerMap.has(key)) {
                    streamerMap.set(key, {
                        username: ann.username,
                        display_name: ann.username,
                        discord_user_id: ann.discord_user_id,
                        profile_image_url: ann.profile_image_url,
                        thumbnail_url: ann.profile_image_url,
                        platform: ann.platform, // Primary platform
                        allPlatforms: [ann.platform],
                        stream_started_at: ann.earliest_start,
                        viewer_count: 0,
                        discord_avatar_url: null // Will be populated below
                    });
                } else {
                    // Add this platform if not already added
                    const streamer = streamerMap.get(key);
                    if (!streamer.allPlatforms.includes(ann.platform)) {
                        streamer.allPlatforms.push(ann.platform);
                    }
                }
            }

            // Fetch Discord avatars for users with discord_user_id
            const liveStreamers = Array.from(streamerMap.values());
            for (const streamer of liveStreamers) {
                if (streamer.discord_user_id) {
                    try {
                        const discordUser = await client.users.fetch(streamer.discord_user_id);
                        if (discordUser) {
                            streamer.discord_avatar_url = discordUser.displayAvatarURL({ size: 512, extension: 'png' });
                        }
                    } catch (error) {
                        logger.error(`[/status] Failed to fetch Discord avatar for ${streamer.discord_user_id}:`, error);
                    }
                }
            }

            res.render('status-tailwind', {
                user: req.user,
                clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID,
                stats: {
                    guilds: totalGuilds,
                    members: totalMembers,
                    uptime: uptime,
                    ping: client.ws.ping
                },
                liveStreamers: liveStreamers
            });
        } catch (error) {
            logger.error('[/status Error]', error);
            res.status(500).render('error-tailwind', {
                user: req.user,
                error: 'Failed to load status page'
            });
        }
    });

    // Helper function to generate platform URLs
    function getPlatformUrl(platform, username) {
        const urls = {
            twitch: `https://twitch.tv/${username}`,
            youtube: `https://youtube.com/@${username}`,
            kick: `https://kick.com/${username}`,
            trovo: `https://trovo.live/${username}`,
            tiktok: `https://tiktok.com/@${username}`,
            facebook: `https://facebook.com/${username}`
        };
        return urls[platform.toLowerCase()] || `#`;
    }

    // Donate page
    app.get('/donate', (req, res) => {
        res.render('donate-tailwind', {
            user: req.user,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID
        });
    });

    // Settings page
    app.get('/settings', checkAuth, (req, res) => {
        res.render('settings-tailwind', {
            user: req.user,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID
        });
    });

    // Docs page
    app.get('/docs', (req, res) => {
        res.render('docs-tailwind', {
            user: req.user,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID
        });
    });

    // RPG Guide page
    app.get('/docs/rpg', (req, res) => {
        res.render('docs-rpg', {
            user: req.user,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID
        });
    });

    // JWT Tools page
    app.get('/tools/jwt', (req, res) => {
        res.render('tools-jwt', {
            user: req.user,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID
        });
    });

    // Terms of Service page
    app.get('/terms', (req, res) => {
        res.render('terms-tailwind', {
            user: req.user,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID
        });
    });

    // Privacy Policy page
    app.get('/privacy', (req, res) => {
        res.render('privacy-tailwind', {
            user: req.user,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID
        });
    });

    // GitLab webhook (no auth, before CSRF)
    import('./routes/gitlab-webhook.js').then(({ default: gitlabRouter }) => {
        app.use('/', gitlabRouter);
    }).catch(err => {
        logger.error('Failed to load gitlab-webhook routes:', err);
    });

    // Import API routes
    import('./routes/api.js').then(({ default: apiRouter }) => {
        app.use('/api', apiRouter);
    });

    // Import feature API routes (giveaways, moderation, leveling, etc.)
    import('./routes/api/index.js').then(({ default: featureApiRouter }) => {
        app.use('/api', featureApiRouter);
    }).catch(err => {
        logger.error('Failed to load feature API routes:', err);
    });

    import('./routes/voice-preview.js').then(({ default: voicePreviewRouter }) => {
        app.use('/', voicePreviewRouter);
    }).catch(err => {
        logger.error('Failed to load voice-preview routes:', err);
    });

    import('./routes/guilds.js').then(({ default: guildsRouter }) => {
        app.use('/api/guilds', guildsRouter);
    });

    import('./routes/status.js').then(({ default: statusRouter }) => {
        app.use('/api/status', statusRouter);
    }).catch(err => {
        logger.error('Failed to load status routes:', err);
    });

    import('./routes/bots.js').then(({ default: botsRouter }) => {
        app.use('/', botsRouter);
    }).catch(err => {
        logger.error('Failed to load bots routes:', err);
    });

    import('./routes/super-admin.js').then(({ default: superAdminRouter }) => {
        app.use('/', superAdminRouter);
    }).catch(err => {
        logger.error('Failed to load super-admin routes:', err);
    });

    import('./routes/features/ticket-panels.js').then(({ default: ticketPanelsRouter }) => {
        app.use('/manage', ticketPanelsRouter);
    }).catch(err => {
        logger.error('Failed to load ticket-panels routes:', err);
    });

    // New feature routes
    import('./routes/features/confessions.js').then(({ default: confessionsRouter }) => {
        app.use('/', confessionsRouter);
    }).catch(err => {
        logger.error('Failed to load confessions routes:', err);
    });

    import('./routes/features/achievements.js').then(({ default: achievementsRouter }) => {
        app.use('/', achievementsRouter);
    }).catch(err => {
        logger.error('Failed to load achievements routes:', err);
    });

    import('./routes/features/statistics.js').then(({ default: statisticsRouter }) => {
        app.use('/', statisticsRouter);
    }).catch(err => {
        logger.error('Failed to load statistics routes:', err);
    });

    import('./routes/features/content-management.js').then(({ default: contentRouter }) => {
        app.use('/', contentRouter);
    }).catch(err => {
        logger.error('Failed to load content-management routes:', err);
    });

    import('./routes/features/weather.js').then(({ default: weatherRouter }) => {
        app.use('/', weatherRouter);
    }).catch(err => {
        logger.error('Failed to load weather routes:', err);
    });

    import('./routes/features/schedule.js').then(({ default: scheduleRouter }) => {
        app.use('/', scheduleRouter);
    }).catch(err => {
        logger.error('Failed to load schedule routes:', err);
    });

    import('./routes/public-schedule.js').then(({ default: publicScheduleRouter }) => {
        app.use('/', publicScheduleRouter);
    }).catch(err => {
        logger.error('Failed to load public schedule routes:', err);
    });

    import('./routes/auth-twitch.js').then(({ default: authTwitchRouter }) => {
        app.use('/', authTwitchRouter);
    }).catch(err => {
        logger.error('Failed to load Twitch auth routes:', err);
    });

    import('./routes/user-schedule.js').then(({ default: userScheduleRouter }) => {
        app.use('/', userScheduleRouter);
    }).catch(err => {
        logger.error('Failed to load user schedule routes:', err);
    });

    // Tokes Bot routes
    import('./routes/auth-tokes-bot.js').then(({ default: authTokesBotRouter }) => {
        app.use('/', authTokesBotRouter);
    }).catch(err => {
        logger.error('Failed to load Tokes Bot auth routes:', err);
    });

    import('./routes/tokes-bot.js').then(({ default: tokesBotRouter }) => {
        app.use('/', tokesBotRouter);
    }).catch(err => {
        logger.error('Failed to load Tokes Bot routes:', err);
    });

    import('./routes/tokes-admin-api.js').then(({ default: tokesAdminRouter }) => {
        app.use('/', tokesAdminRouter);
    }).catch(err => {
        logger.error('Failed to load Tokes Bot admin routes:', err);
    });

    // Public leaderboard page
    import('./routes/public-leaderboard.js').then(({ default: publicLeaderboardRouter }) => {
        app.use('/', publicLeaderboardRouter);
    }).catch(err => {
        logger.error('Failed to load public leaderboard routes:', err);
    });

    // Community support leaderboard page
    import('./routes/community-support.js').then(({ default: communitySupportRouter }) => {
        app.use('/', communitySupportRouter);
    }).catch(err => {
        logger.error('Failed to load community support routes:', err);
    });

    // E-Book reader route
    app.get('/E-Book1', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'ebook', 'index.html'));
    });

    // Error handling
    app.use((err, req, res, next) => {
        logger.error('Express error:', err);
        res.status(500).render('error-tailwind', {
            user: req.user,
            error: 'Internal server error'
        });
    });

    // Start server with error handling for port conflicts
    const server = app.listen(port, () => {
        logger.info(`Dashboard server running on port ${port}`);
        logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
        logger.info(`Dashboard URL: http://localhost:${port}`);
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            logger.warn(`[Dashboard] Port ${port} already in use - dashboard will not start, but bot continues`);
            // Don't crash the bot, just log and continue
        } else {
            logger.error(`[Dashboard] Server error: ${err.message}`);
        }
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
        logger.info('Shutting down dashboard server...');
        process.exit(0);
    });
}

export default { start };
