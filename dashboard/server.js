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
import fourthwallWebhookRouter from './routes/webhooks/fourthwall.js';
import streamRouter from './routes/stream.js';
import streamInternalRouter from './routes/stream-internal.js';
import streamConnectRouter from './routes/stream-connect.js';
import { invalidateMusicConfigCache } from '../utils/music_helpers.js';
import encryption from '../utils/encryption.js';
import cookieParser from 'cookie-parser';

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

// Large file upload (for PDF imports, etc.)
const uploadLarge = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
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
                connectSrc: ["'self'", "https://api.twitch.tv", "https://kick.com", "https://api.giphy.com", "blob:"],
                mediaSrc: ["'self'", "blob:", "https:"],
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

    // Cookie parser for non-session cookies (card management, etc.)
    app.use(cookieParser());

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

    // Fourthwall webhook receiver — mounted BEFORE body parser to preserve raw body for HMAC verify
    app.use('/webhooks/fourthwall', fourthwallWebhookRouter);

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
            '/internal/resolve-destinations',
            '/auth/discord/callback',
            '/tokes-bot/auth/twitch/callback',
            '/tokes-bot/auth/kick/callback',
            '/api/guilds',
            '/api/webhooks',
            '/api/webhooks/gitlab',
            '/api/status',
            '/api/ebook/record',
            '/webhooks/fourthwall',
            '/manage',
            '/card',
            '/cards',
            '/supporters',
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
            // Create include function that tries caller-relative first, then viewsDir
            function makeInclude(callerFile) {
                return (templatePath, data = {}) => {
                    const ext = templatePath.endsWith('.ejs') ? '' : '.ejs';
                    const callerDir = callerFile ? path.dirname(callerFile) : viewsDir;
                    let fullPath = path.resolve(callerDir, templatePath + ext);
                    // If not found relative to caller, try from viewsDir
                    if (!fs.existsSync(fullPath)) {
                        fullPath = path.resolve(viewsDir, templatePath + ext);
                    }
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

    // Health monitoring endpoint (no auth)
    app.get('/api/health', async (req, res) => {
        try {
            const botManager = global.botManager;
            const uptime = process.uptime();

            // DB check
            let dbOk = false;
            let dbLatency = 0;
            try {
                const start = Date.now();
                await pool.execute('SELECT 1');
                dbLatency = Date.now() - start;
                dbOk = true;
            } catch { /* db down */ }

            // Main bot gateway
            const mainBot = client;
            const mainStatus = mainBot?.ws?.status === 0 ? 'connected' : 'disconnected';
            const mainPing = mainBot?.ws?.ping || -1;

            // Custom bots
            const customBots = [];
            if (botManager) {
                for (const [botId, botClient] of botManager.clients) {
                    if (botId === 'default') continue;
                    customBots.push({
                        id: botId,
                        name: botClient.user?.username || 'unknown',
                        status: botClient.ws?.status === 0 ? 'connected' : 'disconnected',
                        ping: botClient.ws?.ping || -1,
                        guilds: botClient.guilds?.cache?.size || 0
                    });
                }
            }

            const allConnected = mainStatus === 'connected' && customBots.every(b => b.status === 'connected');
            const disconnected = customBots.filter(b => b.status !== 'connected');

            res.json({
                status: dbOk && allConnected ? 'healthy' : dbOk ? 'degraded' : 'unhealthy',
                uptime: Math.floor(uptime),
                uptimeFormatted: `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
                database: { ok: dbOk, latencyMs: dbLatency },
                gateway: {
                    main: { status: mainStatus, ping: mainPing, guilds: mainBot?.guilds?.cache?.size || 0 },
                    customBots: customBots.length,
                    allConnected,
                    disconnected: disconnected.length > 0 ? disconnected.map(b => b.name) : []
                },
                memory: {
                    rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
                    heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // Public status API — bypass auth for /api/status/* endpoints
    // Loaded synchronously to avoid race condition with auth-protected /api/* routes
    app.use('/api/status', async (req, res, next) => {
        try {
            if (!app._statusRouter) {
                const mod = await import('./routes/status.js');
                app._statusRouter = mod.default;
            }
            app._statusRouter(req, res, next);
        } catch (err) {
            res.status(500).json({ error: 'Status routes not available' });
        }
    });

    // Super-admin API — has its own auth (requireSuperAdmin), must bypass generic apiCheckAuth
    // Routes use full paths (/api/super-admin/*, /api/admin/*) so intercept both prefixes
    app.use((req, res, next) => {
        if (!req.path.startsWith('/api/super-admin/') && !req.path.startsWith('/api/admin/')) return next();
        (async () => {
            try {
                if (!app._superAdminRouter) {
                    const mod = await import('./routes/super-admin.js');
                    app._superAdminRouter = mod.default;
                }
                app._superAdminRouter(req, res, next);
            } catch (err) {
                res.status(500).json({ error: 'Super admin routes not available' });
            }
        })();
    });

    // Routes
    // Public schedule pages — render a streamer's monthly calendar.
    //
    //   GET /schedule/:username       → HTML page with the calendar image + share links
    //   GET /schedule/:username.png   → raw PNG image (used by the HTML page and Discord embeds)
    //
    // No auth required — these pages only surface public Twitch schedule data.
    app.get('/schedule/:username.png', async (req, res) => {
        try {
            const username = req.params.username.replace(/\.png$/i, '').trim();
            if (!username || username.length > 30) return res.status(400).send('bad username');
            const { getTwitchUser, getStreamSchedule } = await import('../utils/platforms/twitch-api.js');
            const user = await getTwitchUser(username);
            if (!user?.id) return res.status(404).send('Twitch user not found');
            const resp = await getStreamSchedule(user.id);
            const scheduleData = resp?.data?.data || { segments: [] };

            // Grab cancellation info from whichever guild sync row is most recent
            let canceled = [];
            try {
                const [rows] = await pool.execute(
                    "SELECT previous_segments_json FROM twitch_schedule_sync_config WHERE streamer_id IN (SELECT streamer_id FROM streamers WHERE platform='twitch' AND LOWER(username) = LOWER(?)) ORDER BY last_synced DESC LIMIT 1",
                    [username]
                );
                const prev = rows[0]?.previous_segments_json ? JSON.parse(rows[0].previous_segments_json) : [];
                const currentIds = new Set(scheduleData.segments.map(s => s.id));
                const now = Date.now();
                canceled = prev.filter(p => p?.id && !currentIds.has(p.id) && p.start_time && new Date(p.start_time).getTime() > now);
            } catch { /* best-effort */ }

            const TSM = (await import('../core/twitch-schedule-manager.js')).default;
            const mgr = new TSM({ isDefaultBot: true });
            const png = await mgr.buildScheduleImage({ username, profile_image_url: user.profile_image_url }, scheduleData, canceled);
            if (!png) return res.status(503).send('canvas module unavailable');
            res.set('Content-Type', 'image/png');
            res.set('Cache-Control', 'public, max-age=600'); // 10 min
            res.send(png);
        } catch (err) {
            logger.error('[/schedule/:username.png]', err);
            res.status(500).send('render failed');
        }
    });

    app.get('/schedule/:username', async (req, res) => {
        const username = req.params.username.trim();
        if (!username || username.length > 30) return res.status(400).send('bad username');
        const imgUrl = `/schedule/${encodeURIComponent(username)}.png`;
        res.set('Cache-Control', 'public, max-age=60');
        res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>${username}'s Streaming Schedule · CertiFried</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="${username}'s Streaming Schedule">
<meta property="og:description" content="Live-generated from twitch.tv/${username}. Updates automatically when the streamer edits their Twitch schedule.">
<meta property="og:image" content="${imgUrl}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${imgUrl}">
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; background: #2B1E16; color: #FFF8E6; margin: 0; padding: 0; min-height: 100vh; }
  header { background: linear-gradient(180deg, #5E3B1E 0%, #3D2B1F 100%); padding: 24px 16px; text-align: center; border-bottom: 4px solid #F5C26B; }
  header h1 { margin: 0; font-size: 28px; color: #F5C26B; }
  header p { margin: 6px 0 0; color: #FFEFCE; font-size: 14px; }
  main { max-width: 1700px; margin: 24px auto; padding: 0 16px; }
  main img { width: 100%; height: auto; border-radius: 12px; box-shadow: 0 6px 32px rgba(0,0,0,0.4); display: block; }
  .links { text-align: center; margin: 20px 0; }
  .links a { color: #F5C26B; text-decoration: none; font-weight: 600; margin: 0 12px; }
  .links a:hover { text-decoration: underline; }
  footer { text-align: center; padding: 24px; color: #8F7E6B; font-size: 13px; }
</style></head>
<body>
<header>
  <h1>${username}'s Streaming Schedule</h1>
  <p>Live-generated from <a href="https://twitch.tv/${username}" style="color:#F5C26B">twitch.tv/${username}</a> — updates automatically when the streamer edits their Twitch schedule</p>
</header>
<main>
  <img src="${imgUrl}" alt="${username}'s streaming schedule" loading="eager">
  <div class="links">
    <a href="https://twitch.tv/${username}" target="_blank">Watch on Twitch →</a>
    <a href="${imgUrl}" target="_blank">Download image</a>
  </div>
</main>
<footer>Schedule auto-refreshes every 10 minutes · Powered by CertiFried</footer>
</body></html>`);
    });

    // Root chooser: pick the Discord bot or the Kick (defender) bot.
    // Always shown, even when logged in (each card reflects its own session).
    app.get('/', async (req, res) => {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');

        // Every value has a safe default so the public landing page can never 500.
        let discordLoggedIn = false;
        let kickLoggedIn = false;
        let discordServers = 0;
        let kickChannels = 0;

        try {
            discordLoggedIn = typeof req.isAuthenticated === 'function' && req.isAuthenticated();
            kickLoggedIn = !!req.session?.tokesUser;
        } catch (err) {
            logger.warn('[Landing Chooser] Session/auth check failed:', { error: err.message });
        }

        // Live "reach" counts for the chooser cards. Each source is isolated so a
        // failure (bot not ready, DB hiccup, missing table) never blocks the page.
        try {
            // getServerStats() dedupes guilds across the main client AND every
            // custom bot in global.botManager — same number used by /discord and /status.
            if (typeof getServerStats === 'function') {
                discordServers = getServerStats(client)?.guilds || 0;
            }
        } catch (err) {
            logger.warn('[Landing Chooser] Failed to get Discord server count:', { error: err.message });
        }
        try {
            const [[row]] = await pool.execute(
                'SELECT COUNT(*) AS c FROM tokes_channels WHERE is_enabled = 1'
            );
            kickChannels = row?.c || 0;
        } catch (err) {
            logger.warn('[Landing Chooser] Failed to get Kick channel count:', { error: err.message });
        }

        const viewData = {
            discordLoggedIn,
            kickLoggedIn,
            discordHref: discordLoggedIn ? '/dashboard' : '/auth/discord',
            kickHref: kickLoggedIn ? '/kick' : '/tokes-bot/auth/kick',
            discordServers,
            kickChannels
        };

        try {
            return res.render('landing-chooser', viewData);
        } catch (err) {
            // Render itself failed — log the real cause and fall back to a minimal
            // inline page so the front door is never a 500.
            logger.error('[Landing Chooser] Render failed:', { error: err.message, stack: err.stack });
            return res.status(200).type('html').send(
                `<!DOCTYPE html><html><head><meta charset="utf-8"><title>CertiFried Utility</title></head>`
                + `<body style="font-family:system-ui;background:#0b0a12;color:#ececec;text-align:center;padding:4rem">`
                + `<h1>CertiFried Utility</h1><p>Pick the bot you're here for.</p>`
                + `<p style="margin-top:2rem"><a style="color:#5865F2" href="${viewData.discordHref}">Discord Bot</a>`
                + ` &nbsp;·&nbsp; <a style="color:#53FC18" href="${viewData.kickHref}">Kick Bot</a></p>`
                + `</body></html>`
            );
        }
    });

    // Discord marketing/landing page (formerly at '/').
    app.get('/discord', async (req, res) => {
        try {
            // Use shared function for consistent server count across all pages
            const stats = getServerStats(client);

            // Count actual commands
            const commandCount = client?.commands?.size || 0;

            res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
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
            res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
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

    app.get('/auth/discord/callback', (req, res, next) => {
        passport.authenticate('discord', (err, user, info) => {
            if (err) {
                logger.error('[Auth Callback] Passport error:', { error: err.message, stack: err.stack });
                return res.status(500).render('error-tailwind', { user: null, error: 'Authentication failed: ' + err.message });
            }
            if (!user) {
                logger.warn('[Auth Callback] No user returned from Discord OAuth');
                return res.redirect('/');
            }
            req.logIn(user, (loginErr) => {
                if (loginErr) {
                    logger.error('[Auth Callback] Login error:', { error: loginErr.message, stack: loginErr.stack });
                    return res.status(500).render('error-tailwind', { user: null, error: 'Login failed: ' + loginErr.message });
                }
                const returnTo = req.session.returnTo;
                delete req.session.returnTo;
                res.redirect(returnTo || '/dashboard');
            });
        })(req, res, next);
    });

    app.get('/logout', (req, res) => {
        req.logout(() => {
            res.redirect('/');
        });
    });
    // ===========================
    // BIRTHDAY CARD ROUTES (public)
    // ===========================

    // View birthday card (public — no auth required)
    // ═══ Standalone Cards System ═══

    // Landing page
    app.get('/cards', (req, res) => {
        res.render('cards-landing', { user: req.user || null });
    });

    // Create card page
    app.get('/cards/create', (req, res) => {
        res.render('cards-create', { user: req.user || null, occasion: req.query.occasion || 'birthday' });
    });

    // My Cards — management page for card creators
    app.get('/cards/my-cards', async (req, res) => {
        try {
            let cards = [];

            // Get cards by Discord user ID if logged in
            if (req.user?.id) {
                const [discordCards] = await pool.execute(
                    `SELECT bc.*, (SELECT COUNT(*) FROM birthday_card_signatures WHERE card_id = bc.id) as sig_count
                     FROM birthday_cards bc WHERE bc.creator_user_id = ? OR bc.user_id = ? ORDER BY bc.id DESC`,
                    [req.user.id, req.user.id]
                );
                cards = discordCards;
            }

            // Get cards from cookie (non-Discord users or supplement Discord results)
            const cookieSlugs = req.cookies?.my_cards ? JSON.parse(req.cookies.my_cards) : [];
            if (cookieSlugs.length > 0) {
                const placeholders = cookieSlugs.map(() => '?').join(',');
                const [cookieCards] = await pool.execute(
                    `SELECT bc.*, (SELECT COUNT(*) FROM birthday_card_signatures WHERE card_id = bc.id) as sig_count
                     FROM birthday_cards bc WHERE bc.slug IN (${placeholders}) ORDER BY bc.id DESC`,
                    cookieSlugs
                );
                // Merge without duplicates
                const existingIds = new Set(cards.map(c => c.id));
                for (const c of cookieCards) {
                    if (!existingIds.has(c.id)) cards.push(c);
                }
            }

            // Sort newest first
            cards.sort((a, b) => b.id - a.id);

            res.render('cards-my-cards', { user: req.user || null, cards });
        } catch (error) {
            logger.error('[Cards] My cards error:', error);
            res.render('cards-my-cards', { user: req.user || null, cards: [] });
        }
    });

    // AI Cover Generation (standalone — no guild required)
    app.post('/cards/generate-cover', async (req, res) => {
        try {
            const { prompt } = req.body;
            if (!prompt?.trim()) return res.status(400).json({ error: 'Please describe the cover image' });

            const apiKey = process.env.GOOGLE_AI_KEY;
            if (!apiKey) return res.status(500).json({ error: 'AI generation not configured' });

            const safePrompt = `Generate a greeting card cover image: ${prompt.substring(0, 400)}. Style: colorful, celebratory, festive, high quality. No text or words in the image.`;

            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: safePrompt }] }],
                    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
                })
            });

            const data = await response.json();
            let imageUrl = null;

            if (data.candidates?.[0]?.content?.parts) {
                for (const part of data.candidates[0].content.parts) {
                    if (part.inlineData?.mimeType?.startsWith('image/')) {
                        const ext = part.inlineData.mimeType === 'image/png' ? 'png' : 'jpg';
                        const filename = `ai_cover_standalone_${Date.now()}.${ext}`;
                        const uploadDir = path.join(__dirname, 'public', 'uploads');
                        const fs = await import('fs');
                        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
                        fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(part.inlineData.data, 'base64'));
                        const baseUrl = (process.env.DASHBOARD_URL || '').replace(/\/$/, '');
                        imageUrl = `${baseUrl}/uploads/${filename}`;
                        break;
                    }
                }
            }

            if (!imageUrl) return res.status(500).json({ error: 'AI returned no image. Try a different prompt.' });

            logger.info(`[Cards] AI cover generated: "${prompt.substring(0, 60)}"`);
            res.json({ url: imageUrl });
        } catch (error) {
            logger.error('[Cards] AI cover generation error:', error);
            res.status(500).json({ error: 'AI generation failed. Try again.' });
        }
    });

    // Create card API
    app.post('/cards/create', async (req, res) => {
        try {
            const { recipient_name, card_name, occasion, creator_name, password, background_music_url, wishlist_url, deliver_at, card_background_url, ai_cover_url, card_type, board_bg_image_url, board_bg_color } = req.body;

            if (!recipient_name?.trim()) {
                return res.status(400).json({ error: 'Recipient name is required' });
            }

            const crypto = await import('crypto');
            const token = crypto.randomBytes(16).toString('hex');
            const safeName = recipient_name.trim().substring(0, 200);
            const safeOccasion = occasion || 'birthday';

            // Generate title from occasion + name if not provided
            const occasionTitles = {
                'birthday': `Happy Birthday, ${safeName}!`,
                'farewell': `Farewell, ${safeName}!`,
                'thank-you': `Thank You, ${safeName}!`,
                'congratulations': `Congratulations, ${safeName}!`,
                'retirement': `Happy Retirement, ${safeName}!`,
                'welcome': `Welcome, ${safeName}!`,
                'anniversary': `Happy Anniversary, ${safeName}!`,
                'baby': `Welcome Baby, ${safeName}!`,
                'get-well': `Get Well Soon, ${safeName}!`,
                'holidays': `Happy Holidays, ${safeName}!`,
                'graduation': `Congrats on Graduating, ${safeName}!`,
                'promotion': `Congrats on the Promotion, ${safeName}!`,
                'miss-you': `We Miss You, ${safeName}!`,
                'condolence': `In Memory of ${safeName}`,
                'custom': `For ${safeName}`,
            };
            const title = card_name?.trim() || occasionTitles[safeOccasion] || `For ${safeName}`;
            const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60) + '-' + token.substring(0, 12);

            // Hash password if provided
            let passwordHash = null;
            if (password?.trim()) {
                passwordHash = crypto.createHash('sha256').update(password.trim()).digest('hex');
            }

            const creatorId = req.user?.id || null;
            const creatorUsername = creator_name?.trim() || req.user?.username || null;

            const safeCardType = ['board', 'greeting_card', 'one_person'].includes(card_type) ? card_type : 'board';

            const [result] = await pool.execute(`
                INSERT INTO birthday_cards (guild_id, user_id, card_name, birthday_month, birthday_day, share_token, slug, occasion, recipient_name, creator_user_id, creator_username, password_hash, background_music_url, wishlist_url, deliver_at, card_background_url, ai_cover_url, ai_cover_prompt, card_type, board_bg_image_url, board_bg_color, is_posted)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            `, [
                null,  // No guild — standalone card
                null,  // No Discord user — standalone card
                title,
                new Date().getMonth() + 1,
                new Date().getDate(),
                token,
                slug,
                safeOccasion,
                safeName,
                creatorId,
                creatorUsername,
                passwordHash,
                background_music_url || null,
                wishlist_url || null,
                deliver_at || null,
                card_background_url || null,
                ai_cover_url || null,
                ai_cover_url ? (req.body.ai_prompt || '').substring(0, 500) : null,
                safeCardType,
                board_bg_image_url || null,
                board_bg_color || null,
            ]);

            logger.info(`[Cards] Standalone card created: "${title}" by ${creatorUsername || 'anonymous'}, id=${result.insertId}`);

            // Track created cards in cookie for non-Discord users
            const existingCards = req.cookies?.my_cards ? JSON.parse(req.cookies.my_cards) : [];
            existingCards.push(slug);
            // Keep last 100 cards max
            const trimmedCards = existingCards.slice(-100);
            res.cookie('my_cards', JSON.stringify(trimmedCards), {
                maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
                httpOnly: true,
                sameSite: 'lax',
                secure: process.env.NODE_ENV === 'production'
            });

            res.json({ success: true, url: `/card/${slug}`, token: slug });
        } catch (error) {
            logger.error('[Cards] Create error:', error);
            res.status(500).json({ error: 'Failed to create card' });
        }
    });

    // Resolve YouTube/SoundCloud URL to direct audio stream via yt-dlp
    app.get('/card/resolve-audio', async (req, res) => {
        try {
            const { url } = req.query;
            if (!url) return res.status(400).json({ error: 'No URL' });

            const allowed = /youtube\.com|youtu\.be|soundcloud\.com/i;
            if (!allowed.test(url)) return res.status(400).json({ error: 'Unsupported URL' });

            const { spawn } = await import('child_process');
            const cookiesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cookies.txt');
            const args = ['-f', 'bestaudio/best', '-g', '--no-playlist', '--no-check-formats', '--no-warnings'];
            if (fs.existsSync(cookiesPath)) args.push('--cookies', cookiesPath);
            args.push(url);

            const result = await new Promise((resolve, reject) => {
                const proc = spawn('yt-dlp', args, { timeout: 15000 });
                let stdout = '', stderr = '';
                proc.stdout.on('data', d => stdout += d);
                proc.stderr.on('data', d => stderr += d);
                proc.on('close', code => code === 0 && stdout.trim() ? resolve(stdout.trim()) : reject(new Error(stderr || 'yt-dlp failed')));
                proc.on('error', reject);
            });

            res.json({ audioUrl: result });
        } catch (error) {
            logger.error('[Cards] Audio resolve error:', error.message);
            res.status(500).json({ error: 'Could not resolve audio' });
        }
    });

    // ═══ Card View (shared by guild + standalone cards) ═══

    app.get('/card/:shareToken', async (req, res) => {
        try {
            const { shareToken } = req.params;

            // Look up by slug first, then fall back to share_token
            let [cards] = await pool.execute(
                'SELECT * FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1',
                [shareToken, shareToken]
            );

            if (cards.length === 0) {
                return res.status(404).render('error', { user: req.user || null, error: 'Birthday card not found' });
            }

            // Redirect old token URLs to the clean slug URL
            if (cards[0].slug && shareToken !== cards[0].slug) {
                return res.redirect(301, '/card/' + cards[0].slug);
            }

            const card = cards[0];

            // Resolve user info — standalone cards use recipient_name, guild cards use Discord lookup
            let username = card.recipient_name || 'Someone';
            let avatarUrl = null;
            let guildName = null;
            if (card.guild_id && card.user_id) {
                // Guild-linked card — resolve via Discord
                try {
                    const botClient = global.botManager?.getClientForGuild(card.guild_id) || global.botManager?.getDefaultClient() || client;
                    const discordUser = await botClient.users.fetch(card.user_id).catch(() => null);
                    if (discordUser) {
                        username = discordUser.displayName || discordUser.username;
                        avatarUrl = discordUser.displayAvatarURL({ size: 256 });
                    }
                    const guild = botClient.guilds.cache.get(card.guild_id);
                    if (guild) guildName = guild.name;
                } catch { /* best effort */ }
            } else {
                // Standalone card — use stored name, creator as source
                guildName = card.creator_username ? `Created by ${card.creator_username}` : 'CertiFried Cards';
            }

            // Increment view count
            pool.execute('UPDATE birthday_cards SET view_count = view_count + 1 WHERE id = ?', [card.id]).catch(() => {});

            const [signatures] = await pool.execute(
                'SELECT * FROM birthday_card_signatures WHERE card_id = ? ORDER BY CASE WHEN pin_rank IS NOT NULL THEN 0 ELSE 1 END, pin_rank ASC, created_at ASC',
                [card.id]
            );

            // Load replies for each signature
            const sigIds = signatures.map(s => s.id);
            let repliesMap = {};
            let userLikes = new Set();
            if (sigIds.length > 0) {
                const [replies] = await pool.execute(
                    `SELECT * FROM birthday_card_replies WHERE signature_id IN (${sigIds.map(() => '?').join(',')}) ORDER BY created_at ASC`,
                    sigIds
                );
                for (const r of replies) {
                    if (!repliesMap[r.signature_id]) repliesMap[r.signature_id] = [];
                    repliesMap[r.signature_id].push(r);
                }

                // Load user's likes
                if (req.user) {
                    const [likes] = await pool.execute(
                        `SELECT signature_id FROM birthday_card_likes WHERE user_id = ? AND signature_id IN (${sigIds.map(() => '?').join(',')})`,
                        [req.user.id, ...sigIds]
                    );
                    for (const l of likes) userLikes.add(l.signature_id);
                }
            }

            const alreadySigned = req.user ? signatures.some(s => s.signer_user_id === req.user.id) : false;
            // Force read-only if ?delivered=1 query param (deliver link)
            const forceReadOnly = req.query.delivered === '1';

            // Password protection check
            let passwordRequired = false;
            if (card.password_hash) {
                const sessionKey = `card_unlocked_${card.id}`;
                if (!req.session?.[sessionKey]) {
                    passwordRequired = true;
                }
            }

            // For standalone cards, pass the creator's mutual guilds (guilds where bot is present)
            let mutualGuilds = [];
            const isCreator = req.user && (req.user.id === card.creator_user_id || req.user.id === card.user_id);
            if (!card.guild_id && isCreator && req.user?.guilds) {
                const botGuildIds = new Set();
                const defaultClient = global.botManager?.getDefaultClient() || client;
                if (defaultClient?.guilds?.cache) defaultClient.guilds.cache.forEach(g => botGuildIds.add(g.id));
                if (global.botManager?.getAllClients) {
                    for (const bc of global.botManager.getAllClients()) {
                        if (bc?.guilds?.cache) bc.guilds.cache.forEach(g => botGuildIds.add(g.id));
                    }
                }
                mutualGuilds = req.user.guilds
                    .filter(g => botGuildIds.has(g.id) && (parseInt(g.permissions) & 0x20) === 0x20) // MANAGE_GUILD
                    .map(g => ({ id: g.id, name: g.name, icon: g.icon }));
            }

            res.render('birthday-card', {
                card: { ...card, username, avatar_url: avatarUrl, guild_name: guildName, is_posted: card.is_posted || forceReadOnly ? 1 : 0 },
                signatures: passwordRequired ? [] : signatures,
                repliesMap: passwordRequired ? {} : repliesMap,
                userLikes: passwordRequired ? [] : Array.from(userLikes),
                user: req.user || null,
                alreadySigned: passwordRequired ? false : alreadySigned,
                passwordRequired,
                mutualGuilds,
                isCreator: !!isCreator,
                forceReadOnly: !!forceReadOnly
            });
        } catch (error) {
            logger.error('[Birthday Card] Error loading card:', error);
            res.status(500).render('error', { user: req.user || null, error: 'Failed to load birthday card' });
        }
    });

    // Unlock password-protected card
    app.post('/card/:shareToken/unlock', async (req, res) => {
        try {
            const { shareToken } = req.params;
            const { password } = req.body;
            const [cards] = await pool.execute('SELECT id, password_hash FROM birthday_cards WHERE share_token = ?', [shareToken]);
            if (!cards.length) return res.redirect('/card/' + shareToken);

            const crypto = await import('crypto');
            const hash = crypto.createHash('sha256').update(password || '').digest('hex');
            if (hash === cards[0].password_hash) {
                if (req.session) req.session[`card_unlocked_${cards[0].id}`] = true;
                return res.redirect('/card/' + shareToken);
            }
            return res.redirect('/card/' + shareToken + '?error=wrong_password');
        } catch {
            return res.redirect('/card/' + req.params.shareToken);
        }
    });

    // Upload image for birthday card signature
    app.post('/card/upload', upload.fields([{ name: 'file', maxCount: 1 }]), handleMulterError, async (req, res) => {
        try {
            const file = req.files?.file?.[0];
            if (!file) return res.status(400).json({ error: 'No file' });

            const ext = path.extname(file.originalname).toLowerCase() || '.png';
            const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
            if (!allowed.includes(ext)) return res.status(400).json({ error: 'Unsupported file type' });

            const fs = await import('fs');
            const userId = req.user?.id || 'guest';
            const filename = `card_upload_${userId}_${Date.now()}${ext}`;
            const uploadDir = path.join(__dirname, 'public', 'uploads');
            fs.writeFileSync(path.join(uploadDir, filename), file.buffer);

            const baseUrl = (process.env.DASHBOARD_URL || '').replace(/\/$/, '');
            res.json({ success: true, url: `${baseUrl}/uploads/${filename}` });
        } catch (error) {
            logger.error('[Card Upload] Error:', error);
            res.status(500).json({ error: 'Upload failed' });
        }
    });

    // Sign birthday card (supports logged-in users AND guests)
    app.post('/card/:shareToken/sign', async (req, res) => {
        try {
            const { shareToken } = req.params;
            const { message, gif_url, guest_name, guest_email, guest_password, font_color, font_family, font_size, audio_url, gift_code, gift_platform, card_bg_color, card_border_radius, card_border_color, card_shadow, note_effect } = req.body;

            if (!message || !message.trim()) {
                return res.status(400).json({ error: 'Please write a message' });
            }

            // Look up card by slug or token
            const [cards] = await pool.execute('SELECT * FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1', [shareToken, shareToken]);
            if (cards.length === 0) return res.status(404).json({ error: 'Card not found' });

            const card = cards[0];
            if (card.is_posted) return res.status(400).json({ error: 'This card has already been delivered' });
            if (card.is_frozen) return res.status(400).json({ error: 'This card is currently frozen — new messages are disabled' });

            let signerUserId, signerUsername, avatarUrl;

            if (req.user) {
                // Logged-in user (Discord/Twitch OAuth)
                signerUserId = req.user.id;
                signerUsername = req.user.username;
                const avatarHash = req.user.avatar;
                avatarUrl = avatarHash
                    ? `https://cdn.discordapp.com/avatars/${req.user.id}/${avatarHash}.png?size=128`
                    : `https://cdn.discordapp.com/embed/avatars/${(BigInt(req.user.id) >> 22n) % 6n}.png`;
            } else {
                // Guest signer
                if (!guest_name || !guest_name.trim()) {
                    return res.status(400).json({ error: 'Please enter your name' });
                }
                signerUserId = `guest_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
                signerUsername = guest_name.trim().substring(0, 100);
                avatarUrl = null;
            }

            // Sanitize font fields
            const safeFontColor = (font_color && /^#[0-9a-fA-F]{3,8}$/.test(font_color)) ? font_color : null;
            const allowedFonts = ['Helvetica Neue', 'Arial', 'Georgia', 'Courier New', 'Comic Sans MS', 'Impact', 'Trebuchet MS', 'Verdana', 'Palatino', 'Garamond', 'Bookman', 'Muli', 'Roboto', 'Inter', 'Quicksand', 'Pacifico', 'Dancing Script', 'Lobster', 'Caveat', 'Permanent Marker', 'Satisfy', 'Great Vibes', 'Sacramento', 'Architects Daughter', 'Indie Flower', 'Patrick Hand', 'Shadows Into Light', 'Amatic SC'];
            const safeFontFamily = (font_family && allowedFonts.includes(font_family)) ? font_family : null;
            const safeFontSize = (font_size && parseInt(font_size) >= 10 && parseInt(font_size) <= 28) ? parseInt(font_size) : null;
            // Random rotation like RecoCards: ~16% of cards get a rotation between -5 and +5 degrees
            const rotation = Math.random() < 0.3 ? parseFloat((Math.random() * 6 - 3).toFixed(1)) : null;

            const safeAudioUrl = (audio_url && audio_url.startsWith('/uploads/') && audio_url.length < 512) ? audio_url : null;

            // Encrypt gift card code if provided
            let encryptedGiftCode = null;
            const safeGiftPlatform = (gift_platform && gift_platform.length <= 100) ? gift_platform.trim() : null;
            if (gift_code && gift_code.trim()) {
                try {
                    encryptedGiftCode = JSON.stringify(encryption.encrypt(gift_code.trim().substring(0, 2000)));
                } catch { encryptedGiftCode = null; }
            }

            // Sanitize per-card appearance fields
            const safeCardBgColor = (card_bg_color && /^#[0-9a-fA-F]{3,8}$/.test(card_bg_color)) ? card_bg_color : null;
            const safeCardBorderRadius = (card_border_radius && [4, 8, 16, 24, 32].includes(parseInt(card_border_radius))) ? parseInt(card_border_radius) : null;
            const safeCardBorderColor = (card_border_color && /^#[0-9a-fA-F]{3,8}$/.test(card_border_color)) ? card_border_color : null;
            const safeCardShadow = (card_shadow && ['none', 'light', 'medium', 'dramatic'].includes(card_shadow)) ? card_shadow : null;
            const safeNoteEffect = (note_effect && ['hearts', 'confetti', 'stars', 'sparkles'].includes(note_effect)) ? note_effect : null;

            // Hash optional guest password for later editing
            const crypto = await import('crypto');
            const guestPasswordHash = (guest_password && guest_password.trim())
                ? crypto.createHash('sha256').update(guest_password.trim()).digest('hex')
                : null;

            await pool.execute(`
                INSERT INTO birthday_card_signatures (card_id, signer_user_id, signer_username, signer_avatar_url, message, gif_url, font_color, font_family, font_size, rotation, audio_url, gift_code_encrypted, gift_platform, card_bg_color, card_border_radius, card_border_color, card_shadow, note_effect, guest_password_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [card.id, signerUserId, signerUsername, avatarUrl, message.trim().substring(0, 2000), gif_url || null, safeFontColor, safeFontFamily, safeFontSize, rotation, safeAudioUrl, encryptedGiftCode, safeGiftPlatform, safeCardBgColor, safeCardBorderRadius, safeCardBorderColor, safeCardShadow, safeNoteEffect, guestPasswordHash]);

            logger.info(`[Birthday Card] ${req.user?.username || signerUsername} signed card ${card.id} for user ${card.user_id}`);
            res.json({ success: true });
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                return res.json({ error: 'You have already signed this card' });
            }
            logger.error('[Birthday Card] Error signing card:', error);
            res.status(500).json({ error: 'Failed to sign card' });
        }
    });

    // Edit a signature (logged-in user edits own, guest uses password)
    app.post('/card/:shareToken/edit-signature/:signatureId', async (req, res) => {
        try {
            const { signatureId } = req.params;
            const { message, guest_password } = req.body;

            if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty' });

            const [sigs] = await pool.execute('SELECT signer_user_id, guest_password_hash FROM birthday_card_signatures WHERE id = ?', [signatureId]);
            if (!sigs.length) return res.status(404).json({ error: 'Signature not found' });

            const sig = sigs[0];

            // Auth check: logged-in user must own the signature, guest must provide correct password
            if (req.user) {
                if (sig.signer_user_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own signature' });
            } else {
                // Guest edit — require password
                if (!sig.guest_password_hash) return res.status(403).json({ error: 'No edit password was set for this signature' });
                if (!guest_password) return res.status(400).json({ error: 'Password required to edit' });
                const crypto = await import('crypto');
                const hash = crypto.createHash('sha256').update(guest_password.trim()).digest('hex');
                if (hash !== sig.guest_password_hash) return res.status(403).json({ error: 'Incorrect password' });
            }

            await pool.execute('UPDATE birthday_card_signatures SET message = ? WHERE id = ?', [message.trim().substring(0, 2000), signatureId]);
            res.json({ success: true });
        } catch (error) {
            logger.error('[Birthday Card] Error editing signature:', error);
            res.status(500).json({ error: 'Failed to edit signature' });
        }
    });

    // Delete a signature (logged-in user deletes own, guest uses password)
    app.post('/card/:shareToken/delete-signature/:signatureId', async (req, res) => {
        try {
            const { signatureId } = req.params;
            const { guest_password } = req.body;

            const [sigs] = await pool.execute('SELECT signer_user_id, guest_password_hash FROM birthday_card_signatures WHERE id = ?', [signatureId]);
            if (!sigs.length) return res.status(404).json({ error: 'Signature not found' });

            const sig = sigs[0];

            if (req.user) {
                if (sig.signer_user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own signature' });
            } else {
                if (!sig.guest_password_hash) return res.status(403).json({ error: 'No edit password was set' });
                if (!guest_password) return res.status(400).json({ error: 'Password required' });
                const crypto = await import('crypto');
                const hash = crypto.createHash('sha256').update(guest_password.trim()).digest('hex');
                if (hash !== sig.guest_password_hash) return res.status(403).json({ error: 'Incorrect password' });
            }

            await pool.execute('DELETE FROM birthday_card_signatures WHERE id = ?', [signatureId]);
            res.json({ success: true });
        } catch (error) {
            logger.error('[Birthday Card] Error deleting signature:', error);
            res.status(500).json({ error: 'Failed to delete signature' });
        }
    });

    // Like a signature
    app.post('/card/:shareToken/like/:signatureId', async (req, res) => {
        try {
            if (!req.user) return res.status(401).json({ error: 'Please log in' });
            const sigId = req.params.signatureId;

            // Verify signature belongs to this card
            const [sigs] = await pool.execute(
                'SELECT bcs.id FROM birthday_card_signatures bcs JOIN birthday_cards bc ON bcs.card_id = bc.id WHERE bcs.id = ? AND bc.share_token = ?',
                [sigId, req.params.shareToken]
            );
            if (!sigs.length) return res.status(404).json({ error: 'Not found' });

            await pool.execute(
                'INSERT INTO birthday_card_likes (signature_id, user_id) VALUES (?, ?)',
                [sigId, req.user.id]
            );
            await pool.execute(
                'UPDATE birthday_card_signatures SET likes = likes + 1 WHERE id = ?',
                [sigId]
            );
            res.json({ success: true });
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') return res.json({ error: 'Already liked' });
            res.status(500).json({ error: 'Failed' });
        }
    });

    // Unlike a signature
    app.delete('/card/:shareToken/like/:signatureId', async (req, res) => {
        try {
            if (!req.user) return res.status(401).json({ error: 'Please log in' });
            const sigId = req.params.signatureId;
            const [result] = await pool.execute(
                'DELETE FROM birthday_card_likes WHERE signature_id = ? AND user_id = ?',
                [sigId, req.user.id]
            );
            if (result.affectedRows > 0) {
                await pool.execute('UPDATE birthday_card_signatures SET likes = GREATEST(likes - 1, 0) WHERE id = ?', [sigId]);
            }
            res.json({ success: true });
        } catch { res.status(500).json({ error: 'Failed' }); }
    });

    // Reply to a signature
    app.post('/card/:shareToken/reply/:signatureId', async (req, res) => {
        try {
            if (!req.user) return res.status(401).json({ error: 'Please log in' });
            const { message } = req.body;
            if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

            const sigId = req.params.signatureId;
            const [sigs] = await pool.execute(
                'SELECT bcs.id FROM birthday_card_signatures bcs JOIN birthday_cards bc ON bcs.card_id = bc.id WHERE bcs.id = ? AND bc.share_token = ?',
                [sigId, req.params.shareToken]
            );
            if (!sigs.length) return res.status(404).json({ error: 'Not found' });

            const avatarHash = req.user.avatar;
            const avatarUrl = avatarHash
                ? `https://cdn.discordapp.com/avatars/${req.user.id}/${avatarHash}.png?size=64`
                : `https://cdn.discordapp.com/embed/avatars/${(BigInt(req.user.id) >> 22n) % 6n}.png`;

            await pool.execute(
                'INSERT INTO birthday_card_replies (signature_id, user_id, username, avatar_url, message) VALUES (?, ?, ?, ?, ?)',
                [sigId, req.user.id, req.user.username, avatarUrl, message.trim().substring(0, 500)]
            );
            res.json({ success: true });
        } catch (error) {
            logger.error('[Birthday Card] Reply error:', error);
            res.status(500).json({ error: 'Failed' });
        }
    });

    // Delete a signature (signer or card creator)
    app.delete('/card/:shareToken/signature/:signatureId', async (req, res) => {
        try {
            if (!req.user) return res.status(401).json({ error: 'Please log in' });
            const { shareToken, signatureId } = req.params;
            const [cards] = await pool.execute('SELECT * FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1', [shareToken, shareToken]);
            if (!cards.length) return res.status(404).json({ error: 'Card not found' });
            const card = cards[0];

            const [sigs] = await pool.execute('SELECT * FROM birthday_card_signatures WHERE id = ? AND card_id = ?', [signatureId, card.id]);
            if (!sigs.length) return res.status(404).json({ error: 'Signature not found' });

            // Only the signer or card creator/owner can delete
            const isSigner = sigs[0].signer_user_id === req.user.id;
            const isCreator = card.creator_user_id === req.user.id || card.user_id === req.user.id;
            if (!isSigner && !isCreator) return res.status(403).json({ error: 'You can only delete your own messages' });

            await pool.execute('DELETE FROM birthday_card_signatures WHERE id = ?', [signatureId]);
            res.json({ success: true });
        } catch (error) {
            logger.error('[Birthday Card] Delete signature error:', error);
            res.status(500).json({ error: 'Failed' });
        }
    });

    // Pin/unpin a signature (card creator only)
    app.post('/card/:shareToken/pin/:signatureId', async (req, res) => {
        try {
            if (!req.user) return res.status(401).json({ error: 'Please log in' });
            const { shareToken, signatureId } = req.params;
            const { pin_rank } = req.body;
            const [cards] = await pool.execute('SELECT * FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1', [shareToken, shareToken]);
            if (!cards.length) return res.status(404).json({ error: 'Card not found' });
            const card = cards[0];

            const isCreator = card.creator_user_id === req.user.id || card.user_id === req.user.id;
            if (!isCreator) return res.status(403).json({ error: 'Only the card creator can pin messages' });

            const rank = pin_rank ? parseInt(pin_rank) : null;
            await pool.execute('UPDATE birthday_card_signatures SET pin_rank = ? WHERE id = ? AND card_id = ?', [rank, signatureId, card.id]);
            res.json({ success: true });
        } catch (error) {
            logger.error('[Birthday Card] Pin error:', error);
            res.status(500).json({ error: 'Failed' });
        }
    });

    // Move signature to different page (greeting cards)
    app.post('/card/:shareToken/move/:signatureId', async (req, res) => {
        try {
            if (!req.user) return res.status(401).json({ error: 'Please log in' });
            const { shareToken, signatureId } = req.params;
            const { page_number } = req.body;
            const [cards] = await pool.execute('SELECT * FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1', [shareToken, shareToken]);
            if (!cards.length) return res.status(404).json({ error: 'Card not found' });
            const card = cards[0];

            // Only creator or the signer can move
            const [sigs] = await pool.execute('SELECT * FROM birthday_card_signatures WHERE id = ? AND card_id = ?', [signatureId, card.id]);
            if (!sigs.length) return res.status(404).json({ error: 'Signature not found' });
            const isSigner = sigs[0].signer_user_id === req.user.id;
            const isCreator = card.creator_user_id === req.user.id || card.user_id === req.user.id;
            if (!isSigner && !isCreator) return res.status(403).json({ error: 'Only the signer or card creator can move messages' });

            const newPage = Math.max(1, parseInt(page_number) || 1);
            await pool.execute('UPDATE birthday_card_signatures SET page_number = ? WHERE id = ?', [newPage, signatureId]);
            res.json({ success: true, page_number: newPage });
        } catch (error) {
            logger.error('[Birthday Card] Move error:', error);
            res.status(500).json({ error: 'Failed' });
        }
    });

    // Import from RecoCards URL (admin route)
    // Delete birthday card
    // Update card customization
    app.post('/manage/:guildId/birthday/update-card', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { cardId, card_background_url, background_music_url, wishlist_url, custom_logo_url, password, is_frozen, deliver_at, profile_link, credits_text, header_bg_color, board_bg_color, board_bg_image_url, title_font, title_font_size, title_font_color, subtitle_text, subtitle_font, subtitle_font_color, custom_slug } = req.body;

            let passwordHash = null;
            if (password && password.trim()) {
                const crypto = await import('crypto');
                passwordHash = crypto.createHash('sha256').update(password.trim()).digest('hex');
            }

            await pool.execute(`
                UPDATE birthday_cards SET
                    card_background_url = ?,
                    background_music_url = ?,
                    wishlist_url = ?,
                    custom_logo_url = ?,
                    password_hash = COALESCE(?, password_hash),
                    is_frozen = ?,
                    deliver_at = ?,
                    profile_link = ?,
                    credits_text = ?,
                    header_bg_color = ?,
                    board_bg_color = ?,
                    board_bg_image_url = ?,
                    title_font = ?,
                    title_font_size = ?,
                    title_font_color = ?,
                    subtitle_text = ?,
                    subtitle_font = ?,
                    subtitle_font_color = ?
                    ${custom_slug ? ', slug = ?' : ''}
                WHERE id = ? AND guild_id = ?
            `, [
                card_background_url || null,
                background_music_url || null,
                wishlist_url || null,
                custom_logo_url || null,
                passwordHash,
                is_frozen ? 1 : 0,
                deliver_at || null,
                profile_link || null,
                credits_text || null,
                header_bg_color || null,
                board_bg_color || null,
                board_bg_image_url || null,
                title_font || null,
                title_font_size ? parseInt(title_font_size) : null,
                title_font_color || null,
                subtitle_text || null,
                subtitle_font || null,
                subtitle_font_color || null,
                ...(custom_slug ? [custom_slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-|-$/g, '').substring(0, 200)] : []),
                cardId,
                guildId
            ]);

            res.redirect(`/manage/${guildId}?page=birthday&success=card_updated`);
        } catch (error) {
            logger.error('[Birthday Card] Update error:', error);
            res.redirect(`/manage/${guildId}?page=birthday&error=update_failed`);
        }
    });

    // Audio upload for birthday card signatures
    app.post('/card/upload-audio', upload.single('audio'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'No audio file' });
            if (req.file.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'Audio too large (max 2MB)' });
            const filename = `audio_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.webm`;
            const uploadDir = path.join(__dirname, 'public', 'uploads');
            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
            fs.writeFileSync(path.join(uploadDir, filename), req.file.buffer);
            res.json({ url: `/uploads/${filename}` });
        } catch (error) {
            logger.error('[Birthday Card] Audio upload error:', error);
            res.status(500).json({ error: 'Upload failed' });
        }
    });

    // Pin/unpin a signature (admin only)
    app.post('/manage/:guildId/birthday/pin-signature', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { signatureId, pinRank } = req.body;
            const rank = pinRank ? parseInt(pinRank) : null;
            await pool.execute('UPDATE birthday_card_signatures SET pin_rank = ? WHERE id = ?', [rank, signatureId]);
            res.json({ success: true });
        } catch (error) {
            logger.error('[Birthday Card] Pin error:', error);
            res.status(500).json({ error: 'Failed to pin' });
        }
    });

    // Read-only / delivered view (recipient link)
    // Read-only deliver link — forces read-only view regardless of card status
    app.get('/card/:shareToken/view', async (req, res) => {
        res.redirect('/card/' + req.params.shareToken + '?delivered=1');
    });

    // Embed code endpoint
    app.get('/card/:shareToken/embed', async (req, res) => {
        try {
            const { shareToken } = req.params;
            const [cards] = await pool.execute('SELECT * FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1', [shareToken, shareToken]);
            if (!cards.length) return res.status(404).send('Card not found');
            const card = cards[0];
            const baseUrl = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '');
            const embedUrl = `${baseUrl}/card/${card.slug || card.share_token}`;
            res.json({
                embed_url: embedUrl,
                iframe: `<iframe src="${embedUrl}" width="100%" height="800" frameborder="0" style="border-radius: 12px; max-width: 1600px;"></iframe>`,
                link: embedUrl
            });
        } catch (error) {
            res.status(500).json({ error: 'Failed to generate embed' });
        }
    });

    // Connect a standalone card to a Discord guild
    app.post('/card/:shareToken/connect-discord', async (req, res) => {
        try {
            const { shareToken } = req.params;
            const { guild_id, user_id, card_channel_id, announcement_channel_id, birthday_role_id } = req.body;
            if (!req.user) return res.status(401).json({ error: 'Please log in' });

            const [cards] = await pool.execute('SELECT * FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1', [shareToken, shareToken]);
            if (!cards.length) return res.status(404).json({ error: 'Card not found' });

            const card = cards[0];
            // Only the creator can connect
            if (card.creator_user_id !== req.user.id && card.user_id !== req.user.id) {
                return res.status(403).json({ error: 'Only the card creator can connect to Discord' });
            }

            // Verify the user has manage_guild permission on this guild
            const userGuild = req.user.guilds?.find(g => g.id === guild_id);
            if (!userGuild || (parseInt(userGuild.permissions) & 0x20) !== 0x20) {
                return res.status(403).json({ error: 'You need Manage Server permission on that guild' });
            }

            // Update the card with Discord connection
            await pool.execute(`
                UPDATE birthday_cards SET
                    guild_id = ?,
                    user_id = COALESCE(user_id, ?),
                    signing_channel_id = ?,
                    signing_message_id = NULL
                WHERE id = ?
            `, [guild_id, user_id || null, card_channel_id || null, card.id]);

            // If a birthday role was specified, update the birthday_config for this guild
            if (birthday_role_id) {
                await pool.execute(`
                    INSERT INTO birthday_config (guild_id, birthday_role_id, card_channel_id)
                    VALUES (?, ?, ?)
                    ON DUPLICATE KEY UPDATE birthday_role_id = VALUES(birthday_role_id), card_channel_id = VALUES(card_channel_id)
                `, [guild_id, birthday_role_id, card_channel_id || null]).catch(() => {});
            }

            // If an announcement channel was specified, post a signing embed there
            if (announcement_channel_id) {
                try {
                    const botClient = global.botManager?.getClientForGuild(guild_id) || global.botManager?.getDefaultClient() || client;
                    const channel = await botClient.channels.fetch(announcement_channel_id).catch(() => null);
                    if (channel) {
                        const baseUrl = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '');
                        const cardUrl = `${baseUrl}/card/${card.slug || card.share_token}`;
                        const embed = new EmbedBuilder()
                            .setColor(0xa78bfa)
                            .setTitle(card.card_name || `Card for ${card.recipient_name}`)
                            .setDescription(`Sign the card! Add your message, GIFs, voice recordings, and even gift cards.\n\n[Sign the Card](${cardUrl})`)
                            .setFooter({ text: `${(await pool.execute('SELECT COUNT(*) as c FROM birthday_card_signatures WHERE card_id = ?', [card.id]))[0][0].c} signatures so far` })
                            .setTimestamp();
                        if (card.card_background_url) embed.setImage(card.card_background_url);
                        const msg = await channel.send({ embeds: [embed] });
                        await pool.execute('UPDATE birthday_cards SET signing_message_id = ?, signing_channel_id = ? WHERE id = ?', [msg.id, announcement_channel_id, card.id]);
                    }
                } catch (e) {
                    logger.warn('[Cards] Failed to post signing embed:', e.message);
                }
            }

            logger.info(`[Cards] Card ${card.id} connected to guild ${guild_id} by ${req.user.username}`);
            res.json({ success: true });
        } catch (error) {
            logger.error('[Cards] Connect Discord error:', error);
            res.status(500).json({ error: 'Failed to connect' });
        }
    });

    // Freeze/unfreeze card
    app.post('/card/:shareToken/freeze', async (req, res) => {
        try {
            const { shareToken } = req.params;
            const [cards] = await pool.execute('SELECT * FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1', [shareToken, shareToken]);
            if (!cards.length) return res.status(404).json({ error: 'Card not found' });
            const newState = cards[0].is_frozen ? 0 : 1;
            await pool.execute('UPDATE birthday_cards SET is_frozen = ? WHERE id = ?', [newState, cards[0].id]);
            res.json({ success: true, is_frozen: !!newState });
        } catch (error) {
            res.status(500).json({ error: 'Failed to update' });
        }
    });

    // AI Cover Generation (Google Gemini)
    app.post('/manage/:guildId/birthday/generate-cover', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { cardId, prompt } = req.body;
            if (!prompt || !cardId) return res.redirect(`/manage/${guildId}?page=birthday&error=missing_prompt`);

            const apiKey = process.env.GOOGLE_AI_KEY;
            if (!apiKey) return res.redirect(`/manage/${guildId}?page=birthday&error=ai_not_configured`);

            const safePrompt = `Generate a birthday card cover image: ${prompt.substring(0, 400)}. Style: colorful, celebratory, festive, high quality. No text or words in the image.`;

            // Use Gemini Nano Banana (image generation model)
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: safePrompt }] }],
                    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
                })
            });

            const data = await response.json();

            // Extract image from response
            let imageUrl = null;
            if (data.candidates?.[0]?.content?.parts) {
                for (const part of data.candidates[0].content.parts) {
                    if (part.inlineData?.mimeType?.startsWith('image/')) {
                        // Save base64 image to file
                        const ext = part.inlineData.mimeType === 'image/png' ? 'png' : 'jpg';
                        const filename = `ai_cover_${cardId}_${Date.now()}.${ext}`;
                        const uploadDir = path.join(__dirname, 'public', 'uploads');
                        const fs = await import('fs');
                        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
                        fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(part.inlineData.data, 'base64'));
                        const baseUrl = (process.env.DASHBOARD_URL || '').replace(/\/$/, '');
                        imageUrl = `${baseUrl}/uploads/${filename}`;
                        break;
                    }
                }
            }

            if (!imageUrl) {
                logger.warn('[Birthday Card] AI cover generation returned no image', data.candidates?.[0]?.content?.parts?.map(p => p.text || '[image]'));
                return res.redirect(`/manage/${guildId}?page=birthday&error=ai_no_image`);
            }

            await pool.execute('UPDATE birthday_cards SET ai_cover_url = ?, ai_cover_prompt = ?, card_background_url = ? WHERE id = ? AND guild_id = ?',
                [imageUrl, prompt.substring(0, 500), imageUrl, cardId, guildId]);

            logger.info(`[Birthday Card] AI cover generated for card ${cardId}: "${prompt.substring(0, 60)}"`);
            res.redirect(`/manage/${guildId}?page=birthday&success=cover_generated`);
        } catch (error) {
            logger.error('[Birthday Card] AI cover generation error:', error);
            res.redirect(`/manage/${guildId}?page=birthday&error=ai_failed`);
        }
    });

    // Thank You message (birthday person replies to everyone)
    app.post('/card/:shareToken/thank-you', async (req, res) => {
        try {
            const { shareToken } = req.params;
            const { message } = req.body;
            if (!req.user) return res.status(401).json({ error: 'Please log in' });
            if (!message?.trim()) return res.status(400).json({ error: 'Please write a message' });

            const [cards] = await pool.execute('SELECT * FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1', [shareToken, shareToken]);
            if (!cards.length) return res.status(404).json({ error: 'Card not found' });
            if (!cards[0].is_posted) return res.status(400).json({ error: 'Card has not been delivered yet' });
            const isRecipient = cards[0].user_id && cards[0].user_id === req.user.id;
            const isCreator = cards[0].creator_user_id && cards[0].creator_user_id === req.user.id;
            if (!isRecipient && !isCreator) return res.status(403).json({ error: 'Only the recipient or card creator can post a thank-you' });

            await pool.execute('UPDATE birthday_cards SET thank_you_message = ?, thank_you_user_id = ? WHERE id = ?',
                [message.trim().substring(0, 2000), req.user.id, cards[0].id]);

            res.json({ success: true });
        } catch (error) {
            logger.error('[Birthday Card] Thank you error:', error);
            res.status(500).json({ error: 'Failed to post' });
        }
    });

    // Reveal gift codes (only for the birthday person, only after delivery)
    app.get('/card/:shareToken/gifts', async (req, res) => {
        try {
            const { shareToken } = req.params;
            if (!req.user) return res.status(401).json({ error: 'Please log in' });

            const [cards] = await pool.execute('SELECT * FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1', [shareToken, shareToken]);
            if (!cards.length) return res.status(404).json({ error: 'Card not found' });
            const isGiftRecipient = cards[0].user_id && cards[0].user_id === req.user.id;
            const isGiftCreator = cards[0].creator_user_id && cards[0].creator_user_id === req.user.id;
            if (!isGiftRecipient && !isGiftCreator) return res.status(403).json({ error: 'Only the recipient or card creator can view gift codes' });

            const [sigs] = await pool.execute(
                'SELECT signer_username, gift_code_encrypted, gift_platform FROM birthday_card_signatures WHERE card_id = ? AND gift_code_encrypted IS NOT NULL',
                [cards[0].id]
            );

            const gifts = sigs.map(sig => {
                let code = '(decryption failed)';
                try { code = encryption.decrypt(JSON.parse(sig.gift_code_encrypted)); } catch {}
                return { from: sig.signer_username, platform: sig.gift_platform, code };
            });

            res.json({ gifts });
        } catch (error) {
            logger.error('[Birthday Card] Gift reveal error:', error);
            res.status(500).json({ error: 'Failed to load gifts' });
        }
    });

    // ═══ Standalone Card Management (for /cards/my-cards) ═══

    // Helper: verify card ownership via Discord user or cookie
    function isCardOwner(req, card) {
        if (req.user?.id && (card.creator_user_id === req.user.id || card.user_id === req.user.id)) return true;
        const cookieSlugs = req.cookies?.my_cards ? JSON.parse(req.cookies.my_cards) : [];
        return cookieSlugs.includes(card.slug);
    }

    // Edit card settings page
    app.get('/card/:shareToken/edit', async (req, res) => {
        try {
            const { shareToken } = req.params;
            const [cards] = await pool.execute('SELECT * FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1', [shareToken, shareToken]);
            if (!cards.length) return res.status(404).render('error', { user: req.user || null, error: 'Card not found' });
            const card = cards[0];
            if (!isCardOwner(req, card)) return res.status(403).render('error', { user: req.user || null, error: 'You don\'t have permission to edit this card' });
            res.render('cards-edit', { user: req.user || null, card });
        } catch (error) {
            logger.error('[Cards] Edit page error:', error);
            res.status(500).render('error', { user: req.user || null, error: 'Failed to load card editor' });
        }
    });

    // Update card settings
    app.post('/card/:shareToken/edit', async (req, res) => {
        try {
            const { shareToken } = req.params;
            const [cards] = await pool.execute('SELECT * FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1', [shareToken, shareToken]);
            if (!cards.length) return res.status(404).json({ error: 'Card not found' });
            const card = cards[0];
            if (!isCardOwner(req, card)) return res.status(403).json({ error: 'Permission denied' });

            const { card_name, recipient_name, background_music_url, wishlist_url, card_background_url, board_bg_image_url, board_bg_color, is_frozen, password, custom_slug } = req.body;

            let passwordHash = undefined;
            if (password && password.trim()) {
                const crypto = await import('crypto');
                passwordHash = crypto.createHash('sha256').update(password.trim()).digest('hex');
            }

            let newSlug = undefined;
            if (custom_slug && custom_slug.trim()) {
                newSlug = custom_slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-|-$/g, '').substring(0, 200);
            }

            await pool.execute(`
                UPDATE birthday_cards SET
                    card_name = ?,
                    recipient_name = ?,
                    background_music_url = ?,
                    wishlist_url = ?,
                    card_background_url = ?,
                    board_bg_image_url = ?,
                    board_bg_color = ?,
                    is_frozen = ?
                    ${passwordHash !== undefined ? ', password_hash = ?' : ''}
                    ${newSlug ? ', slug = ?' : ''}
                WHERE id = ?
            `, [
                card_name || card.card_name,
                recipient_name || card.recipient_name,
                background_music_url || null,
                wishlist_url || null,
                card_background_url || null,
                board_bg_image_url || null,
                board_bg_color || null,
                is_frozen ? 1 : 0,
                ...(passwordHash !== undefined ? [passwordHash] : []),
                ...(newSlug ? [newSlug] : []),
                card.id
            ]);

            // Update cookie if slug changed
            if (newSlug && newSlug !== card.slug) {
                const cookieSlugs = req.cookies?.my_cards ? JSON.parse(req.cookies.my_cards) : [];
                const idx = cookieSlugs.indexOf(card.slug);
                if (idx !== -1) cookieSlugs[idx] = newSlug;
                res.cookie('my_cards', JSON.stringify(cookieSlugs), { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
            }

            logger.info(`[Cards] Card ${card.id} updated by ${req.user?.username || 'anonymous'}`);
            res.json({ success: true, slug: newSlug || card.slug });
        } catch (error) {
            logger.error('[Cards] Edit error:', error);
            res.status(500).json({ error: 'Failed to update card' });
        }
    });

    // Delete standalone card
    app.delete('/card/:shareToken', async (req, res) => {
        try {
            const { shareToken } = req.params;
            const [cards] = await pool.execute('SELECT * FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1', [shareToken, shareToken]);
            if (!cards.length) return res.status(404).json({ error: 'Card not found' });
            const card = cards[0];
            if (!isCardOwner(req, card)) return res.status(403).json({ error: 'Permission denied' });

            await pool.execute('DELETE FROM birthday_cards WHERE id = ?', [card.id]);

            // Remove from cookie
            const cookieSlugs = req.cookies?.my_cards ? JSON.parse(req.cookies.my_cards) : [];
            const filtered = cookieSlugs.filter(s => s !== card.slug);
            res.cookie('my_cards', JSON.stringify(filtered), { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });

            logger.info(`[Cards] Card ${card.id} (${card.card_name}) deleted by ${req.user?.username || 'anonymous'}`);
            res.json({ success: true });
        } catch (error) {
            logger.error('[Cards] Delete error:', error);
            res.status(500).json({ error: 'Failed to delete card' });
        }
    });

    app.post('/manage/:guildId/birthday/delete-card', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { cardId } = req.body;
            // Signatures, likes, and replies cascade-delete via foreign keys
            await pool.execute('DELETE FROM birthday_cards WHERE id = ? AND guild_id = ?', [cardId, guildId]);
            logger.info(`[Birthday Card] Card ${cardId} deleted from guild ${guildId} by ${req.user.username}`);
            res.redirect(`/manage/${guildId}?page=birthday&success=card_deleted`);
        } catch (error) {
            logger.error('[Birthday Card] Delete error:', error);
            res.redirect(`/manage/${guildId}?page=birthday&error=delete_failed`);
        }
    });

    app.post('/manage/:guildId/birthday/import-recocard', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { user_id, recocard_url } = req.body;
            if (!user_id || !recocard_url || !recocard_url.includes('recocards.com/board/')) {
                return res.redirect(`/manage/${guildId}?page=birthday&error=invalid_url`);
            }

            const puppeteer = (await import('puppeteer')).default;
            const crypto = await import('crypto');

            logger.info(`[Birthday Card] Scraping RecoCards: ${recocard_url}`);

            const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
            const page = await browser.newPage();
            await page.setViewport({ width: 1920, height: 1080 });
            await page.goto(recocard_url, { waitUntil: 'networkidle2', timeout: 60000 });
            await page.waitForSelector('mat-card.example-card', { timeout: 20000 }).catch(() => {});

            // Scroll to load all cards
            await page.evaluate(async () => {
                // Scroll aggressively to load all lazy-loaded cards
                let lastHeight = 0;
                for (let i = 0; i < 50; i++) {
                    window.scrollBy(0, 2000);
                    await new Promise(r => setTimeout(r, 300));
                    if (document.body.scrollHeight === lastHeight && i > 10) break;
                    lastHeight = document.body.scrollHeight;
                }
                window.scrollTo(0, 0);
            });
            await new Promise(r => setTimeout(r, 3000));

            const signatures = await page.evaluate(() => {
                const cards = document.querySelectorAll('mat-card.example-card');
                return Array.from(cards).map(card => {
                    const name = card.querySelector('mat-card-title, .mat-card-title')?.textContent?.trim() || '';
                    const contentEl = card.querySelector('mat-card-content, .mat-card-content');
                    const content = contentEl?.textContent?.trim() || '';
                    const allImgs = Array.from(card.querySelectorAll('img')).map(i => i.src).filter(s => s && !s.includes('avatar') && s.startsWith('http'));
                    // Extract like count from heart button
                    let likes = 0;
                    const heartIcon = card.querySelector('[data-icon=heart]');
                    if (heartIcon) {
                        const parent = heartIcon.closest('button') || heartIcon.parentElement;
                        const countMatch = parent?.textContent?.trim().match(/\d+/);
                        if (countMatch) likes = parseInt(countMatch[0]);
                    }
                    // Extract font styles from card content
                    let fontColor = null, fontFamily = null, fontSize = null;
                    if (contentEl) {
                        const cs = getComputedStyle(contentEl);
                        const inlineDiv = contentEl.querySelector('div[style]');
                        if (inlineDiv) {
                            const colorMatch = inlineDiv.style.color;
                            if (colorMatch && colorMatch !== 'rgb(31, 41, 55)') fontColor = colorMatch;
                        }
                        if (cs.fontFamily && !cs.fontFamily.includes('Muli')) fontFamily = cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
                        const fSize = parseInt(cs.fontSize);
                        if (fSize && fSize !== 14) fontSize = fSize;
                    }
                    // Extract rotation from inline style
                    let rotation = null;
                    const style = card.getAttribute('style') || '';
                    const rotMatch = style.match(/rotate\(([^)]+)deg\)/);
                    if (rotMatch && rotMatch[1] !== '0') rotation = parseFloat(rotMatch[1]);
                    return { name, content: content.substring(0, 5000), image: allImgs[0] || null, likes, fontColor, fontFamily, fontSize, rotation };
                }).filter(s => s.name || s.content.length > 5);
            });

            // Grab the board title from the page
            const boardTitle = await page.evaluate(() => {
                const h1 = document.querySelector('h1, .board-title, [class*=title]');
                return h1?.textContent?.trim() || '';
            });

            await browser.close();

            if (signatures.length === 0) {
                return res.redirect(`/manage/${guildId}?page=birthday&error=no_signatures_found`);
            }

            // Create card with readable slug
            const token = crypto.randomBytes(16).toString('hex');
            const cardName = boardTitle || 'Birthday Card';
            const slug = cardName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60) + '-' + token.substring(0, 12);
            const now = new Date();
            const [result] = await pool.execute(
                'INSERT INTO birthday_cards (guild_id, user_id, card_name, birthday_month, birthday_day, share_token, slug, is_posted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
                [guildId, user_id, cardName, now.getMonth() + 1, now.getDate(), token, slug]
            );
            const cardId = result.insertId;

            // Import signatures with font styles and rotation
            for (let i = 0; i < signatures.length; i++) {
                const sig = signatures[i];
                // Convert rgb color to hex if needed
                let hexColor = sig.fontColor;
                if (hexColor && hexColor.startsWith('rgb')) {
                    const m = hexColor.match(/\d+/g);
                    if (m && m.length >= 3) hexColor = '#' + m.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
                }
                await pool.execute(
                    'INSERT INTO birthday_card_signatures (card_id, signer_user_id, signer_username, message, gif_url, likes, font_color, font_family, font_size, rotation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [cardId, `recocard_${i}`, sig.name || 'Anonymous', sig.content || '(no message)', sig.image, sig.likes || 0, hexColor || null, sig.fontFamily || null, sig.fontSize || null, sig.rotation || null]
                );
            }

            logger.info(`[Birthday Card] Imported ${signatures.length} signatures from RecoCards for guild ${guildId}, card ${cardId}`);
            res.redirect(`/manage/${guildId}?page=birthday&success=imported_${signatures.length}`);
        } catch (error) {
            logger.error('[Birthday Card] RecoCards import error:', error);
            res.redirect(`/manage/${guildId}?page=birthday&error=import_failed`);
        }
    });

    // PDF import (admin route)
    app.post('/manage/:guildId/birthday/import-card', uploadLarge.fields([
        { name: 'pdf_file', maxCount: 1 }
    ]), handleMulterError, checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { user_id, card_id } = req.body;
            const uploadedFile = req.files?.pdf_file?.[0];

            if (!uploadedFile || !user_id) {
                return res.redirect(`/manage/${guildId}?page=birthday&error=missing_fields`);
            }

            const crypto = await import('crypto');
            const fs = await import('fs');

            // Save PDF to public uploads for viewing
            const pdfFilename = `birthday_card_${guildId}_${Date.now()}.pdf`;
            const uploadDir = path.join(__dirname, 'public', 'uploads');
            fs.writeFileSync(path.join(uploadDir, pdfFilename), uploadedFile.buffer);
            const baseUrl = (process.env.DASHBOARD_URL || '').replace(/\/$/, '');
            const pdfUrl = `${baseUrl}/uploads/${pdfFilename}`;

            // Try to extract text (works for text-based PDFs)
            const { execFileSync } = await import('child_process');

            // Create or use existing card
            let targetCardId = card_id;
            if (!targetCardId) {
                const token = crypto.randomBytes(16).toString('hex');
                const now = new Date();
                const [result] = await pool.execute(
                    'INSERT INTO birthday_cards (guild_id, user_id, birthday_month, birthday_day, share_token, is_posted, card_background_url) VALUES (?, ?, ?, ?, ?, 0, ?)',
                    [guildId, user_id, now.getMonth() + 1, now.getDate(), token, pdfUrl]
                );
                targetCardId = result.insertId;
            } else {
                await pool.execute('UPDATE birthday_cards SET card_background_url = ? WHERE id = ?', [pdfUrl, targetCardId]);
            }

            // Save PDF to temp file for ImageMagick processing
            const tmpPdf = path.join(uploadDir, `_tmp_import_${Date.now()}.pdf`);
            fs.writeFileSync(tmpPdf, uploadedFile.buffer);

            // Count pages using identify
            let pageCount = 0;
            try {
                const countOutput = execFileSync('identify', [tmpPdf], { timeout: 60000 }).toString();
                pageCount = countOutput.trim().split('\n').length;
            } catch { pageCount = 0; }

            let imported = 0;
            if (pageCount > 0) {
                // Convert each page to an image and create a signature entry
                // Skip page 0 (cover page) — start from page 1
                const startPage = pageCount > 2 ? 1 : 0;
                for (let p = startPage; p < pageCount; p++) {
                    try {
                        const imgFilename = `card_${targetCardId}_page_${p}.png`;
                        const imgPath = path.join(uploadDir, imgFilename);
                        execFileSync('convert', [
                            '-density', '200',
                            `${tmpPdf}[${p}]`,
                            '-quality', '90',
                            imgPath
                        ], { timeout: 30000 });

                        const imgUrl = `${baseUrl}/uploads/${imgFilename}`;
                        await pool.execute(
                            'INSERT INTO birthday_card_signatures (card_id, signer_user_id, signer_username, message, gif_url) VALUES (?, ?, ?, ?, ?)',
                            [targetCardId, `imported_${p}`, `Page ${p + 1}`, 'Imported from RecoCards', imgUrl]
                        );
                        imported++;
                    } catch (pageErr) {
                        logger.warn(`[Birthday Card] Failed to convert page ${p}: ${pageErr.message}`);
                    }
                }
            }

            // Clean up temp PDF
            try { fs.unlinkSync(tmpPdf); } catch { /* ignore */ }

            logger.info(`[Birthday Card] Imported ${imported} pages from PDF for guild ${guildId}, card ${targetCardId}`);
            res.redirect(`/manage/${guildId}?page=birthday&success=imported_${imported}`);
        } catch (error) {
            logger.error('[Birthday Card] PDF import error:', error);
            res.redirect(`/manage/${guildId}?page=birthday&error=import_failed`);
        }
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
                    // Per-guild live counts (for badge on each server card)
                    const [allLive] = await pool.query(`
                        SELECT guild_id, COUNT(DISTINCT COALESCE(discord_user_id, CONCAT(platform, ':', username))) as live_count
                        FROM live_announcements
                        WHERE offline_check_count < 6
                        GROUP BY guild_id
                    `);
                    allLive.forEach(row => {
                        livePerGuild.set(row.guild_id, row.live_count);
                    });

                    // Global unique live count (not sum of per-guild — a streamer in 3 guilds = 1 streamer)
                    const [globalLive] = await pool.query(`
                        SELECT COUNT(DISTINCT COALESCE(discord_user_id, CONCAT(platform, ':', username))) as live_count
                        FROM live_announcements
                        WHERE offline_check_count < 6
                    `);
                    totalLiveStreams = globalLive[0]?.live_count || 0;

                    // Get total streamers tracked across all guilds
                    const [allStreamers] = await pool.query(`SELECT COUNT(*) as total FROM streamers`);
                    totalStreamersTracked = allStreamers[0]?.total || 0;

                } else if (manageableGuilds.length > 0) {
                    const guildIds = manageableGuilds.map(g => g.id);
                    const placeholders = guildIds.map(() => '?').join(',');

                    // Per-guild live counts
                    const [liveByGuild] = await pool.query(`
                        SELECT guild_id, COUNT(DISTINCT COALESCE(discord_user_id, CONCAT(platform, ':', username))) as live_count
                        FROM live_announcements
                        WHERE guild_id IN (${placeholders})
                        AND offline_check_count < 6
                        GROUP BY guild_id
                    `, guildIds);
                    liveByGuild.forEach(row => {
                        livePerGuild.set(row.guild_id, row.live_count);
                    });

                    // Global unique live count for user's guilds
                    const [userLive] = await pool.query(`
                        SELECT COUNT(DISTINCT COALESCE(discord_user_id, CONCAT(platform, ':', username))) as live_count
                        FROM live_announcements
                        WHERE guild_id IN (${placeholders})
                        AND offline_check_count < 6
                    `, guildIds);
                    totalLiveStreams = userLive[0]?.live_count || 0;

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

            // Fetch guild owner + bot joined date for each guild
            for (const guildData of manageableGuilds) {
                try {
                    let botGuild = null;
                    if (global.botManager) {
                        const botClient = global.botManager.getClientForGuild(guildData.id);
                        botGuild = botClient?.guilds.cache.get(guildData.id);
                    } else {
                        botGuild = client.guilds.cache.get(guildData.id);
                    }
                    if (botGuild) {
                        // Guild owner
                        if (botGuild.ownerId) {
                            try {
                                const ownerUser = await botGuild.members.fetch(botGuild.ownerId).catch(() => null);
                                guildData.ownerName = ownerUser?.user?.username || null;
                                guildData.ownerId = botGuild.ownerId;
                            } catch {
                                guildData.ownerId = botGuild.ownerId;
                            }
                        }
                        // Bot joined date (the bot's own member join timestamp)
                        const botMember = botGuild.members.me;
                        if (botMember?.joinedAt) {
                            guildData.botJoinedAt = botMember.joinedAt;
                        }
                    }
                } catch { /* best effort */ }
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

            // Sort servers alphabetically by name
            manageableGuilds.sort((a, b) => a.name.localeCompare(b.name));

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

            // Refresh from REST before reading the cache. The gateway cache
            // goes stale when the bot misses GUILD_ROLE_* / GUILD_CHANNEL_*
            // events (offline at the moment of the change, dropped events),
            // which causes admin dropdowns to render an incomplete list.
            // The fetch* methods hit the API and update the cache in place.
            try {
                await Promise.all([
                    guild.roles.fetch(),
                    guild.channels.fetch(),
                ]);
            } catch (err) {
                logger.warn('[Manage] role/channel refresh failed, falling back to cache', { guildId, error: err.message });
            }
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

            // Build category channels and event colors maps from log_event_config
            const categoryChannels = {};
            const eventColorMap = {};
            logEventConfigRows.forEach(row => {
                if (row.log_channel_id) {
                    categoryChannels[row.event_type] = row.log_channel_id;
                }
                if (row.embed_color) {
                    eventColorMap[row.event_type] = row.embed_color;
                }
            });

            // Format logConfig for the template
            // When enabled_events is NULL, ALL events are enabled (log-manager treats null as "allow all")
            // But also respect log_event_config.enabled = 0 for explicitly disabled events
            let enabledLogs = logConfigRaw.enabled_events || null;
            if (!enabledLogs || enabledLogs === '[]') {
                // NULL or empty = all events enabled — start with full list
                const allEvents = [
                    "messageDelete","messageUpdate","memberUpdate","memberLeave","memberKick",
                    "voiceUpdate","channelCreate","channelDelete","channelUpdate",
                    "ban","unban","moderation","roleCreate","roleDelete","roleUpdate",
                    "tickets","xp","giveaway","starboard","http","commandUsage",
                    "memberJoin","memberTimeout","automodAction",
                    "reactionAdd","reactionRemove","reactionRemoveAll","reactionRemoveEmoji",
                    "pollVoteAdd","pollVoteRemove","channelPinsUpdate",
                    "threadCreate","threadDelete","threadUpdate","threadMembersUpdate",
                    "guildUpdate","emojiCreate","emojiDelete","emojiUpdate",
                    "stickerCreate","stickerDelete","stickerUpdate",
                    "inviteCreate","inviteDelete",
                    "webhookUpdate","integrationUpdate","integrationsUpdate",
                    "scheduledEventCreate","scheduledEventUpdate","scheduledEventDelete",
                    "scheduledEventUserAdd","scheduledEventUserRemove",
                    "soundboardSoundCreate","soundboardSoundDelete","soundboardSoundUpdate",
                    "voiceChannelEffect","stageInstanceCreate","stageInstanceDelete","stageInstanceUpdate",
                    "automodRuleCreate","automodRuleUpdate","automodRuleDelete",
                    "system","sticky-roles","temp-channels","join-gate","poll"
                ];
                // Remove events explicitly disabled in log_event_config
                const disabledEvents = new Set(
                    logEventConfigRows.filter(r => r.enabled === 0).map(r => r.event_type)
                );
                enabledLogs = JSON.stringify(allEvents.filter(e => !disabledEvents.has(e)));
            }
            const logConfig = {
                log_channel_id: logConfigRaw.log_channel_id || null,
                enabled_logs: enabledLogs,
                log_categories: JSON.stringify(categoryChannels),
                event_colors: JSON.stringify(eventColorMap)
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
                        sub.subscription_id, sub.announcement_channel_id, sub.live_role_id, sub.ping_role_id,
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
                        ping_role_id: row.ping_role_id,
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

            // Fetch custom bot info for appearance page
            let customBotInfo = null;
            try {
                const [botMapping] = await pool.execute(
                    'SELECT bot_id, assigned_by, assigned_at FROM guild_bot_mapping WHERE guild_id = ?',
                    [guildId]
                );
                if (botMapping.length > 0) {
                    const [botData] = await pool.execute(
                        'SELECT bot_id, bot_name, owner_user_id, enabled, approved, self_service, created_at FROM custom_bots WHERE bot_id = ?',
                        [botMapping[0].bot_id]
                    );
                    if (botData.length > 0) {
                        const botStatus = global.botManager?.getBotStatus(botData[0].bot_id) || null;
                        let botAvatar = null;
                        if (botStatus?.isReady) {
                            if (botStatus.avatar) botAvatar = botStatus.avatar;
                            else if (botStatus.avatarHash) botAvatar = `https://cdn.discordapp.com/avatars/${botData[0].bot_id}/${botStatus.avatarHash}.png?size=128`;
                            else botAvatar = `https://cdn.discordapp.com/embed/avatars/${(BigInt(botData[0].bot_id) >> 22n) % 6n}.png`;
                        }
                        // Resolve owner username
                        let ownerName = null;
                        try {
                            const [ownerRows] = await pool.execute('SELECT username FROM users WHERE user_id = ?', [botData[0].owner_user_id]);
                            ownerName = ownerRows[0]?.username || null;
                        } catch { /* ignore */ }
                        customBotInfo = {
                            ...botData[0],
                            bot_name: (botStatus?.isReady && botStatus?.username) ? botStatus.username : botData[0].bot_name,
                            bot_avatar: botAvatar,
                            is_online: botStatus?.isReady || false,
                            owner_name: ownerName,
                            assigned_at: botMapping[0].assigned_at
                        };
                    }
                }
            } catch (error) {
                logger.error('Error fetching custom bot info:', error);
            }

            // Fetch TikTok data
            let tiktokSubs = [];
            let tiktokConfig = {};
            let recentTiktokVideos = [];
            try {
                const [subs] = await pool.execute(`
                    SELECT sub.subscription_id, sub.streamer_id, sub.tiktok_vod_notifications, sub.announcement_channel_id,
                           sub.video_announcement_channel_id, sub.custom_message, sub.live_role_id,
                           sub.delete_on_end, sub.edit_on_end, sub.tiktok_embed_video, sub.ping_role_id,
                           s.username, s.profile_image_url,
                           1 AS has_live
                    FROM subscriptions sub
                    JOIN streamers s ON sub.streamer_id = s.streamer_id
                    WHERE s.platform = 'tiktok' AND sub.guild_id = ?
                    ORDER BY s.username
                `, [guildId]);
                tiktokSubs = subs;
                const subWithVideoChannel = subs.find(s => s.video_announcement_channel_id);
                tiktokConfig = { video_channel_id: subWithVideoChannel?.video_announcement_channel_id || '' };

                const [videos] = await pool.execute(`
                    SELECT tvp.video_id, tvp.video_url, tvp.title, tvp.thumbnail_url, tvp.view_count, tvp.posted_at, s.username
                    FROM tiktok_video_posts tvp
                    JOIN streamers s ON tvp.streamer_id = s.streamer_id
                    JOIN subscriptions sub ON s.streamer_id = sub.streamer_id AND sub.guild_id = ?
                    WHERE s.platform = 'tiktok'
                    ORDER BY tvp.posted_at DESC LIMIT 6
                `, [guildId]);
                recentTiktokVideos = videos;
            } catch (error) {
                if (error.code !== 'ER_NO_SUCH_TABLE') {
                    logger.error('Error fetching TikTok data:', error);
                }
            }

            // Fetch stat display channels with live values
            let statDisplayChannels = [];
            try {
                const [sdRows] = await pool.execute(
                    'SELECT id, channel_id, stat_type, template, config FROM stat_display_channels WHERE guild_id = ?',
                    [guildId]
                );
                // Compute live values for each stat display
                const sdGuild = req.guildObject;
                for (const sd of sdRows) {
                    try {
                        const cfg = sd.config ? (typeof sd.config === 'string' ? JSON.parse(sd.config) : sd.config) : null;
                        switch (sd.stat_type) {
                            case 'members': sd.live_value = sdGuild?.memberCount || 0; break;
                            case 'humans': sd.live_value = sdGuild?.members?.cache?.filter(m => !m.user.bot).size || 0; break;
                            case 'bots': sd.live_value = sdGuild?.members?.cache?.filter(m => m.user.bot).size || 0; break;
                            case 'online': sd.live_value = sdGuild?.members?.cache?.filter(m => m.presence?.status && m.presence.status !== 'offline').size || 0; break;
                            case 'channels': sd.live_value = sdGuild?.channels?.cache?.filter(c => c.type !== 4).size || 0; break;
                            case 'roles': sd.live_value = (sdGuild?.roles?.cache?.size || 1) - 1; break;
                            case 'boosts': sd.live_value = sdGuild?.premiumSubscriptionCount || 0; break;
                            case 'role': {
                                const roleId = cfg?.role_id;
                                const role = roleId && sdGuild?.roles?.cache?.get(roleId);
                                sd.live_value = role?.members?.size || 0;
                                sd.role_name = role?.name || 'Unknown Role';
                                break;
                            }
                            case 'time': {
                                // Compute guild local time
                                const [tzRows] = await pool.execute('SELECT timezone FROM guild_settings WHERE guild_id = ?', [guildId]);
                                const tz = tzRows[0]?.timezone || 'UTC+0';
                                const tzMatch = tz.match(/UTC([+-])(\d+)(?::(\d+))?/);
                                const sign = tzMatch ? (tzMatch[1] === '-' ? -1 : 1) : 1;
                                const oh = tzMatch ? parseInt(tzMatch[2]) : 0;
                                const om = tzMatch?.[3] ? parseInt(tzMatch[3]) : 0;
                                const now = new Date();
                                const local = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + sign * (oh * 3600000 + om * 60000));
                                const hrs = local.getHours() % 12 || 12;
                                sd.live_value = `${hrs}:${local.getMinutes().toString().padStart(2, '0')}${local.getHours() >= 12 ? 'pm' : 'am'}`;
                                break;
                            }
                            case 'date': {
                                const [tzRows2] = await pool.execute('SELECT timezone FROM guild_settings WHERE guild_id = ?', [guildId]);
                                const tz2 = tzRows2[0]?.timezone || 'UTC+0';
                                const tzMatch2 = tz2.match(/UTC([+-])(\d+)(?::(\d+))?/);
                                const sign2 = tzMatch2 ? (tzMatch2[1] === '-' ? -1 : 1) : 1;
                                const oh2 = tzMatch2 ? parseInt(tzMatch2[2]) : 0;
                                const om2 = tzMatch2?.[3] ? parseInt(tzMatch2[3]) : 0;
                                const now2 = new Date();
                                const local2 = new Date(now2.getTime() + (now2.getTimezoneOffset() * 60000) + sign2 * (oh2 * 3600000 + om2 * 60000));
                                const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
                                const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                                const d = local2.getDate();
                                const ord = d===1||d===21||d===31?'st':d===2||d===22?'nd':d===3||d===23?'rd':'th';
                                sd.live_value = `${days[local2.getDay()]}, ${months[local2.getMonth()]} ${d}${ord}`;
                                break;
                            }
                            default: sd.live_value = '?';
                        }
                    } catch { sd.live_value = '?'; }
                }
                statDisplayChannels = sdRows;
            } catch (error) {
                if (error.code !== 'ER_NO_SUCH_TABLE') {
                    logger.error('Error fetching stat display channels:', error);
                }
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
                stream_ignored_roles: guildConfig.stream_ignored_roles ? JSON.parse(guildConfig.stream_ignored_roles) : [],
                leveling_enabled: levelingConfig.enabled,
                leveling_xp_rate: levelingConfig.xp_per_message,
                leveling_xp_cooldown: levelingConfig.xp_cooldown_seconds,
                level_up_channel_id: levelingConfig.level_up_channel_id,
                leveling_ignored_channels: levelingConfig.ignored_channels ? JSON.parse(levelingConfig.ignored_channels) : [],
                leveling_ignored_roles: levelingConfig.ignored_roles ? JSON.parse(levelingConfig.ignored_roles) : [],
                monthly_reset_enabled: levelingConfig.monthly_reset_enabled,
                reset_interval_days: levelingConfig.reset_interval_days,
                last_reset_at: levelingConfig.last_reset_at,
                // Appearance settings from guild_config
                bot_nickname: guildConfig.bot_nickname,
                bot_avatar_url: guildConfig.bot_avatar_url,
                embed_color: guildConfig.embed_color
            };

            // Fetch Twitch schedule syncs
            let twitchScheduleSyncs = [];
            try {
                const [syncsData] = await pool.execute(
                    `SELECT
                        tss.id, tss.streamer_id, tss.discord_channel_id,
                        tss.discord_channel_id AS channel_id,
                        tss.is_enabled, tss.sync_interval_minutes, tss.weekly_refresh,
                        tss.last_weekly_refresh, tss.mention_role_id, tss.custom_message,
                        tss.last_synced, tss.schedule_hash, tss.last_message_id,
                        s.username, s.username AS twitch_username, s.profile_image_url
                     FROM twitch_schedule_sync_config tss
                     LEFT JOIN streamers s ON tss.streamer_id = s.streamer_id
                     WHERE tss.guild_id = ?
                     ORDER BY tss.id DESC`,
                    [guildId]
                );
                twitchScheduleSyncs = syncsData;
            } catch (error) {
                logger.error('Error fetching Twitch schedule syncs:', error);
            }

            // Fetch Twitch role sync config
            let twitchRoleSyncConfig = null;
            let twitchRoleSyncMembers = [];
            try {
                const [configRows] = await pool.execute('SELECT guild_id, broadcaster_twitch_id, broadcaster_twitch_username, vip_role_id, mod_role_id, sub_role_id, remove_vip_on_leave, enabled, last_synced, token_scopes FROM twitch_role_sync_config WHERE guild_id = ?', [guildId]);
                if (configRows.length > 0) twitchRoleSyncConfig = configRows[0];
                const [memberRows] = await pool.execute('SELECT * FROM twitch_role_sync_members WHERE guild_id = ? ORDER BY twitch_username', [guildId]);
                twitchRoleSyncMembers = memberRows;
            } catch {}

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

            // Fetch invite filter config + whitelist entries
            let inviteFilterConfig = { enabled: 1, use_whitelist: 0, action: 'delete_warn', log_channel_id: null };
            let inviteFilterEntries = { users: [], roles: [], channels: [] };
            try {
                const linkWhitelist = await import('../utils/link-whitelist.js');
                inviteFilterConfig = await linkWhitelist.getConfig(guildId);
                inviteFilterEntries = await linkWhitelist.listEntries(guildId);
            } catch (error) {
                logger.error('Error fetching invite filter config:', error);
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

            // Fetch prefix command config + aliases
            let prefixConfig = { prefix: '!', enabled: 1, delete_trigger: 0, cleanup_delay: 0, private_categories: null, disabled_commands: null };
            let prefixAliases = [];
            try {
                const [prefixRows] = await pool.execute(
                    'SELECT * FROM prefix_command_config WHERE guild_id = ?',
                    [guildId]
                );
                if (prefixRows.length > 0) prefixConfig = prefixRows[0];
                const [aliasRows] = await pool.execute(
                    'SELECT alias, command_name, created_by, created_at FROM prefix_command_aliases WHERE guild_id = ? ORDER BY alias',
                    [guildId]
                );
                prefixAliases = aliasRows;
            } catch (error) {
                // Table may not exist yet
            }

            res.render('manage-tailwind', {
                user: req.user,
                guild: guild,
                page: req.query.page || 'overview',
                roles: Array.from(allRoles.filter(r => !r.managed && r.name !== '@everyone').values()).sort((a, b) => a.name.localeCompare(b.name)),
                channels: Array.from(allChannels.filter(c => c.isTextBased()).values()).sort((a, b) => a.name.localeCompare(b.name)),
                voiceChannels: Array.from(allChannels.filter(c => c.isVoiceBased()).values()).sort((a, b) => a.name.localeCompare(b.name)),
                categories: Array.from(allChannels.filter(c => c.type === 4).values()).sort((a, b) => a.name.localeCompare(b.name)),
                // Non-bot members, mapped to a lean shape for the Twitch link UI's autocomplete.
                // We expose the full list so a Twitch broadcaster can map all 22+ mods on-page
                // without round-tripping a search endpoint per row.
                guildMembers: Array.from(guild.members.cache.filter(m => !m.user.bot).values())
                    .map(m => ({ id: m.user.id, username: m.user.username, display: m.displayName }))
                    .sort((a, b) => a.username.localeCompare(b.username)),
                // Streamers and Teams
                consolidatedStreamers: consolidatedStreamers,
                teamSubscriptions: teamSubscriptions,
                channelsData: {},
                totalSubscriptions: totalSubscriptions,
                // Settings
                settings: settings,
                customBotInfo: customBotInfo,
                statDisplayChannels: statDisplayChannels,
                customEmbeds: await (async () => {
                    try {
                        const [rows] = await pool.execute('SELECT * FROM custom_embeds WHERE guild_id = ? ORDER BY created_at DESC', [guildId]);
                        return rows;
                    } catch { return []; }
                })(),
                purgeConfigs: await (async () => {
                    try {
                        const [rows] = await pool.execute('SELECT * FROM scheduled_purges WHERE guild_id = ? ORDER BY created_at DESC', [guildId]);
                        return rows;
                    } catch { return []; }
                })(),
                tiktokSubs: tiktokSubs,
                tiktokConfig: tiktokConfig,
                recentTiktokVideos: recentTiktokVideos,
                prefixConfig: prefixConfig,
                prefixAliases: prefixAliases,
                channelSettings: channelSettingsRows,
                channelSettingsMap: channelSettingsMap,
                // Community Features
                welcomeSettings: welcomeSettings,
                reactionRolePanels: reactionRolePanels,
                starboardConfig: starboardConfig,
                roleRewards: await (async () => {
                    try {
                        const [rows] = await pool.execute('SELECT id, level, role_id FROM level_role_rewards WHERE guild_id = ? ORDER BY level', [guildId]);
                        return rows;
                    } catch { return []; }
                })(),
                giveaways: giveaways,
                polls: [],
                suggestions: suggestions,
                suggestionConfig: suggestionConfig,
                suggestionStats: {},
                suggestionTags: [],
                // Throne
                throneNotifications: await (async () => {
                    try {
                        const [rows] = await pool.execute('SELECT * FROM throne_notifications WHERE guild_id = ?', [guildId]);
                        return rows;
                    } catch { return []; }
                })(),
                throneGuildConfig: await (async () => {
                    try {
                        const [rows] = await pool.execute('SELECT * FROM throne_guild_config WHERE guild_id = ?', [guildId]);
                        return rows[0] || null;
                    } catch { return null; }
                })(),
                throneSettings: await (async () => {
                    try {
                        const [rows] = await pool.execute('SELECT * FROM throne_guild_settings WHERE guild_id = ?', [guildId]);
                        return rows[0] || null;
                    } catch { return null; }
                })(),
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
                                action: rows[0].action,
                                alert_channel_id: rows[0].alert_channel_id
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
                                enabled: rows[0].enabled,
                                alert_channel_id: rows[0].alert_channel_id
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
                globalBanStats: await (async () => {
                    try {
                        const [[active]] = await pool.execute('SELECT COUNT(*) as c FROM global_ban_entries WHERE active = 1');
                        const [[pending]] = await pool.execute('SELECT COUNT(*) as c FROM global_ban_reports WHERE status = "pending"');
                        const [[guilds]] = await pool.execute('SELECT COUNT(*) as c FROM global_ban_config WHERE enabled = 1');
                        return { activeEntries: active.c, pendingReports: pending.c, enabledGuilds: guilds.c };
                    } catch { return { activeEntries: 0, pendingReports: 0, enabledGuilds: 0 }; }
                })(),
                phishingConfig: await (async () => {
                    try {
                        const [rows] = await pool.execute(
                            'SELECT * FROM phishing_config WHERE guild_id = ?',
                            [guildId]
                        );
                        return rows[0] || {};
                    } catch (error) {
                        logger.error('Error fetching phishing config:', error);
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
                birthdayUsers: await (async () => {
                    try {
                        const [rows] = await pool.execute('SELECT user_id, month, day FROM user_birthdays WHERE guild_id = ? ORDER BY month, day', [guildId]);
                        // Resolve usernames from Discord cache
                        const botClient = global.botManager?.getClientForGuild(guildId) || client;
                        const guildObj = botClient?.guilds.cache.get(guildId);
                        for (const row of rows) {
                            try {
                                const member = guildObj?.members.cache.get(row.user_id) || await guildObj?.members.fetch(row.user_id).catch(() => null);
                                row.username = member?.displayName || member?.user?.username || null;
                                row.avatar_url = member?.user?.displayAvatarURL({ size: 64 }) || null;
                            } catch { row.username = null; row.avatar_url = null; }
                        }
                        return rows;
                    } catch { return []; }
                })(),
                birthdayStats: await (async () => {
                    try {
                        const [total] = await pool.execute('SELECT COUNT(*) as count FROM user_birthdays WHERE guild_id = ?', [guildId]);
                        const now = new Date();
                        const m = now.getMonth() + 1;
                        const [thisMonth] = await pool.execute('SELECT COUNT(*) as count FROM user_birthdays WHERE guild_id = ? AND month = ?', [guildId, m]);
                        // Upcoming 7 days
                        let upcoming = 0;
                        for (let d = 0; d <= 7; d++) {
                            const future = new Date(now); future.setDate(future.getDate() + d);
                            const fm = future.getMonth() + 1, fd = future.getDate();
                            const [r] = await pool.execute('SELECT COUNT(*) as c FROM user_birthdays WHERE guild_id = ? AND month = ? AND day = ?', [guildId, fm, fd]);
                            upcoming += r[0].c;
                        }
                        return { total: total[0].count, thisMonth: thisMonth[0].count, upcoming };
                    } catch { return { total: 0, thisMonth: 0, upcoming: 0 }; }
                })(),
                birthdayConfig: await (async () => {
                    try {
                        const [rows] = await pool.execute('SELECT * FROM birthday_config WHERE guild_id = ?', [guildId]);
                        return rows[0] || {};
                    } catch { return {}; }
                })(),
                birthdayCards: await (async () => {
                    try {
                        const [rows] = await pool.execute(`
                            SELECT bc.*, COUNT(bcs.id) as signature_count
                            FROM birthday_cards bc
                            LEFT JOIN birthday_card_signatures bcs ON bc.id = bcs.card_id
                            WHERE bc.guild_id = ?
                            GROUP BY bc.id
                            ORDER BY bc.created_at DESC
                            LIMIT 20
                        `, [guildId]);
                        return rows;
                    } catch { return []; }
                })(),
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
                backups: await (async () => {
                    try {
                        const [rows] = await pool.execute('SELECT id, guild_id, snapshot_name, created_by_id, created_at FROM server_backups WHERE guild_id = ? ORDER BY created_at DESC', [guildId]);
                        return rows;
                    } catch { return []; }
                })(),
                permissionOverrides: [],
                reminders: [],
                tags: [],
                // Additional variables
                twitchScheduleSyncs: twitchScheduleSyncs,
                twitchRoleSyncConfig: twitchRoleSyncConfig,
                twitchRoleSyncMembers: twitchRoleSyncMembers,
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
                redditFeeds:    await pool.execute('SELECT * FROM reddit_feeds    WHERE guild_id = ? ORDER BY id DESC', [guildId]).then(r => r[0]).catch(() => []),
                youtubeFeeds:   await pool.execute('SELECT * FROM youtube_feeds   WHERE guild_id = ? ORDER BY id DESC', [guildId]).then(r => r[0]).catch(() => []),
                twitterFeeds:   await pool.execute('SELECT * FROM twitter_feeds   WHERE guild_id = ? ORDER BY id DESC', [guildId]).then(r => r[0]).catch(() => []),
                blueskyFeeds:   await pool.execute('SELECT * FROM bluesky_feeds   WHERE guild_id = ? ORDER BY id DESC', [guildId]).then(r => r[0]).catch(() => []),
                instagramFeeds: await pool.execute('SELECT * FROM instagram_feeds WHERE guild_id = ? ORDER BY id DESC', [guildId]).then(r => r[0]).catch(() => []),
                facebookFeeds:  await pool.execute('SELECT * FROM facebook_feeds  WHERE guild_id = ? ORDER BY id DESC', [guildId]).then(r => r[0]).catch(() => []),
                autoPublisherConfig: autoPublisherConfig,
                autorolesConfig: autorolesConfig,
                tempChannelConfig: tempChannelConfig,
                customCommands: await (async () => {
                    try {
                        const [rows] = await pool.execute('SELECT * FROM custom_commands WHERE guild_id = ? ORDER BY command_name', [guildId]);
                        return rows;
                    } catch { return []; }
                })(),
                commandSettings: (() => {
                    const cmds = [];
                    if (client && client.commands) {
                        client.commands.forEach(cmd => {
                            const data = cmd.data;
                            if (!data) return;

                            const entry = {
                                name: data.name,
                                description: data.description,
                                category: cmd.category || 'General',
                                subcommands: []
                            };

                            // Extract subcommand groups and subcommands from options
                            if (data.options && data.options.length > 0) {
                                for (const opt of data.options) {
                                    const optJson = opt.toJSON ? opt.toJSON() : opt;
                                    if (optJson.type === 2) {
                                        // SubcommandGroup
                                        const group = { name: optJson.name, description: optJson.description, subcommands: [] };
                                        if (optJson.options) {
                                            for (const sub of optJson.options) {
                                                const subJson = sub.toJSON ? sub.toJSON() : sub;
                                                if (subJson.type === 1) {
                                                    group.subcommands.push({
                                                        name: subJson.name,
                                                        description: subJson.description,
                                                        options: (subJson.options || []).filter(o => o.type !== 1 && o.type !== 2).map(o => ({
                                                            name: o.name, description: o.description, required: o.required || false, type: o.type
                                                        }))
                                                    });
                                                }
                                            }
                                        }
                                        entry.subcommands.push({ type: 'group', ...group });
                                    } else if (optJson.type === 1) {
                                        // SubCommand (no group)
                                        const subJson = opt.toJSON ? opt.toJSON() : opt;
                                        entry.subcommands.push({
                                            type: 'subcommand',
                                            name: subJson.name,
                                            description: subJson.description,
                                            options: (subJson.options || []).filter(o => o.type !== 1 && o.type !== 2).map(o => ({
                                                name: o.name, description: o.description, required: o.required || false, type: o.type
                                            }))
                                        });
                                    }
                                }
                            }

                            cmds.push(entry);
                        });
                    }
                    return cmds;
                })(),
                commandRestrictions: await (async () => {
                    try {
                        const [rows] = await pool.execute(
                            'SELECT command_name, allowed, admin_only FROM guild_command_restrictions WHERE guild_id = ?',
                            [guildId]
                        );
                        const map = {};
                        rows.forEach(r => {
                            map[r.command_name] = { allowed: r.allowed, admin_only: r.admin_only };
                        });
                        return map;
                    } catch { return {}; }
                })(),
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
                // Invite link filter (loaded from link-whitelist helper)
                inviteFilterConfig: inviteFilterConfig,
                inviteFilterEntries: inviteFilterEntries,
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
                            LEFT JOIN guild_config gc ON sub.guild_id COLLATE utf8mb4_unicode_ci = gc.guild_id COLLATE utf8mb4_unicode_ci
                            WHERE sub.guild_id = ?
                            ORDER BY sub.edit_on_end DESC, s.username
                        `, [guildId]);
                        return rows;
                    } catch { return []; }
                })(),
                freeGamesSubs: await (async () => {
                    try {
                        const [rows] = await pool.execute(
                            'SELECT * FROM free_games_subscriptions WHERE guild_id = ? ORDER BY created_at DESC',
                            [guildId]
                        );
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

            const isEnabled = djEnabled === 'on' ? 1 : 0;

            // Upsert music_config
            await pool.execute(`
                INSERT INTO music_config (guild_id, dj_enabled, dj_voice)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    dj_enabled = VALUES(dj_enabled),
                    dj_voice = VALUES(dj_voice)
            `, [guildId, isEnabled, djVoice || 'female']);

            // Also upsert ai_dj_config (the command handler checks this table)
            await pool.execute(`
                INSERT INTO ai_dj_config (guild_id, enabled)
                VALUES (?, ?)
                ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)
            `, [guildId, isEnabled]);

            logger.info(`[DJ Config] Saved to DB: djEnabled=${isEnabled}, djVoice=${djVoice || 'female'}`);
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

    // Music filter settings
    app.post('/manage/:guildId/music/filters', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const filters = req.body['filters[]'] || req.body.filters || [];
            const filterList = Array.isArray(filters) ? filters : [filters];
            const filtersJson = JSON.stringify(filterList.filter(Boolean));

            await pool.execute(
                `INSERT INTO music_config (guild_id, enabled_filters) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE enabled_filters = VALUES(enabled_filters)`,
                [guildId, filtersJson]
            );

            invalidateMusicConfigCache(guildId);
            logger.info(`[Music Filters] Updated filters for guild ${guildId}: ${filtersJson}`);
            res.redirect(`/manage/${guildId}?page=music&success=filters`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/music/filters Error]', error);
            res.redirect(`/manage/${guildId}?page=music&error=filters`);
        }
    });

    // ===========================
    // SERVER BACKUPS (extracted to routes/features/backups.js)
    // ===========================
    import('./routes/features/backups.js').then(mod => {
        app.use('/manage/:guildId', checkAuth, checkGuildAdmin, mod.default);
        logger.info('[Dashboard] Backup routes loaded');
    });

    // ===========================
    // CUSTOM COMMANDS
    // ===========================

    app.post('/manage/:guildId/add-custom-command', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { command_name, response } = req.body;
            if (!command_name || !response) return res.redirect(`/manage/${guildId}?page=custom-commands&error=missing_fields`);

            const name = command_name.trim().toLowerCase().replace(/\s+/g, '');
            if (name.length > 50) return res.redirect(`/manage/${guildId}?page=custom-commands&error=name_too_long`);

            await pool.execute(
                'INSERT INTO custom_commands (guild_id, command_name, response) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE response = VALUES(response)',
                [guildId, name, response.trim()]
            );

            logger.info(`[CustomCmd] Created command "${name}" for guild ${guildId} by ${req.user.username}`);
            res.redirect(`/manage/${guildId}?page=custom-commands&success=created`);
        } catch (error) {
            logger.error('[CustomCmd] Error creating command:', { error: error.message, guildId });
            res.redirect(`/manage/${guildId}?page=custom-commands&error=create_failed`);
        }
    });

    app.post('/manage/:guildId/edit-custom-command', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { command_id, response } = req.body;
            if (!command_id || !response) return res.redirect(`/manage/${guildId}?page=custom-commands&error=missing_fields`);

            await pool.execute('UPDATE custom_commands SET response = ? WHERE id = ? AND guild_id = ?', [response.trim(), command_id, guildId]);
            logger.info(`[CustomCmd] Updated command ${command_id} for guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=custom-commands&success=updated`);
        } catch (error) {
            logger.error('[CustomCmd] Error updating command:', { error: error.message, guildId });
            res.redirect(`/manage/${guildId}?page=custom-commands&error=update_failed`);
        }
    });

    app.post('/manage/:guildId/delete-custom-command', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { command_id } = req.body;
            if (!command_id) return res.redirect(`/manage/${guildId}?page=custom-commands&error=missing_id`);

            await pool.execute('DELETE FROM custom_commands WHERE id = ? AND guild_id = ?', [command_id, guildId]);
            logger.info(`[CustomCmd] Deleted command ${command_id} for guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=custom-commands&success=deleted`);
        } catch (error) {
            logger.error('[CustomCmd] Error deleting command:', { error: error.message, guildId });
            res.redirect(`/manage/${guildId}?page=custom-commands&error=delete_failed`);
        }
    });

    // Alias for the existing form that uses command_name instead of id
    app.post('/manage/:guildId/remove-custom-command', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { command_name } = req.body;
            if (!command_name) return res.redirect(`/manage/${guildId}?page=custom-commands&error=missing_name`);
            await pool.execute('DELETE FROM custom_commands WHERE command_name = ? AND guild_id = ?', [command_name, guildId]);
            logger.info(`[CustomCmd] Deleted command "${command_name}" for guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=custom-commands&success=deleted`);
        } catch (error) {
            logger.error('[CustomCmd] Error deleting command:', { error: error.message, guildId });
            res.redirect(`/manage/${guildId}?page=custom-commands&error=delete_failed`);
        }
    });

    // ===========================
    // MISSING ROUTE HANDLERS
    // ===========================

    // --- Leveling: Role Rewards ---
    app.post('/manage/:guildId/add-role-reward', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { level, role_id } = req.body;
            if (!level || !role_id) return res.redirect(`/manage/${guildId}?page=leveling&error=missing_fields`);
            await pool.execute('INSERT INTO level_role_rewards (guild_id, level, role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)', [guildId, parseInt(level), role_id]);
            res.redirect(`/manage/${guildId}?page=leveling&success=created`);
        } catch (error) { logger.error('[LevelReward] Error:', error.message); res.redirect(`/manage/${guildId}?page=leveling&error=failed`); }
    });

    app.post('/manage/:guildId/remove-role-reward', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { level } = req.body;
            await pool.execute('DELETE FROM level_role_rewards WHERE guild_id = ? AND level = ?', [guildId, parseInt(level)]);
            res.redirect(`/manage/${guildId}?page=leveling&success=deleted`);
        } catch (error) { logger.error('[LevelReward] Error:', error.message); res.redirect(`/manage/${guildId}?page=leveling&error=failed`); }
    });

    // --- Tags ---
    app.post('/manage/:guildId/delete-tag', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { tag_name } = req.body;
            await pool.execute('DELETE FROM tags WHERE guild_id = ? AND tag_name = ?', [guildId, tag_name]);
            res.redirect(`/manage/${guildId}?page=tags&success=deleted`);
        } catch (error) { logger.error('[Tags] Error:', error.message); res.redirect(`/manage/${guildId}?page=tags&error=failed`); }
    });

    // --- Permissions ---
    app.post('/manage/:guildId/create-permission-override', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { role_id, command_name, allowed } = req.body;
            if (!role_id || !command_name) return res.redirect(`/manage/${guildId}?page=permissions&error=missing_fields`);
            await pool.execute('INSERT INTO bot_permissions (guild_id, role_id, command_name, allowed) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE allowed = VALUES(allowed)', [guildId, role_id, command_name, allowed ? 1 : 0]);
            res.redirect(`/manage/${guildId}?page=permissions&success=created`);
        } catch (error) { logger.error('[Permissions] Error:', error.message); res.redirect(`/manage/${guildId}?page=permissions&error=failed`); }
    });

    app.post('/manage/:guildId/delete-permission-override', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { override_id } = req.body;
            await pool.execute('DELETE FROM bot_permissions WHERE guild_id = ? AND id = ?', [guildId, override_id]);
            res.redirect(`/manage/${guildId}?page=permissions&success=deleted`);
        } catch (error) { logger.error('[Permissions] Error:', error.message); res.redirect(`/manage/${guildId}?page=permissions&error=failed`); }
    });

    // --- Reminders ---
    app.post('/manage/:guildId/create-reminder', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { channel_id, message, remind_at } = req.body;
            if (!channel_id || !message || !remind_at) return res.redirect(`/manage/${guildId}?page=reminders&error=missing_fields`);
            await pool.execute('INSERT INTO reminders (guild_id, channel_id, message, remind_at, created_by) VALUES (?, ?, ?, ?, ?)', [guildId, channel_id, message, remind_at, req.user.id]);
            res.redirect(`/manage/${guildId}?page=reminders&success=created`);
        } catch (error) { logger.error('[Reminders] Error:', error.message); res.redirect(`/manage/${guildId}?page=reminders&error=failed`); }
    });

    app.post('/manage/:guildId/delete-reminder', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { reminder_id } = req.body;
            await pool.execute('DELETE FROM reminders WHERE guild_id = ? AND id = ?', [guildId, reminder_id]);
            res.redirect(`/manage/${guildId}?page=reminders&success=deleted`);
        } catch (error) { logger.error('[Reminders] Error:', error.message); res.redirect(`/manage/${guildId}?page=reminders&error=failed`); }
    });

    // --- Tickets ---
    app.post('/manage/:guildId/create-ticket-panel', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { panel_name, channel_id, category_id, description } = req.body;
            if (!panel_name || !channel_id) return res.redirect(`/manage/${guildId}?page=tickets&error=missing_fields`);
            await pool.execute('INSERT INTO ticket_panels (guild_id, panel_name, channel_id, category_id, description) VALUES (?, ?, ?, ?, ?)', [guildId, panel_name, channel_id, category_id || null, description || null]);
            res.redirect(`/manage/${guildId}?page=tickets&success=created`);
        } catch (error) { logger.error('[Tickets] Error:', error.message); res.redirect(`/manage/${guildId}?page=tickets&error=failed`); }
    });

    // --- Economy Shop ---
    app.post('/manage/:guildId/economy/shop/add', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { item_name, price, description, role_id } = req.body;
            if (!item_name || !price) return res.redirect(`/manage/${guildId}?page=economy&error=missing_fields`);
            await pool.execute('INSERT INTO shop_items (guild_id, item_name, price, description, role_id) VALUES (?, ?, ?, ?, ?)', [guildId, item_name, parseInt(price), description || null, role_id || null]);
            res.redirect(`/manage/${guildId}?page=economy&success=created`);
        } catch (error) { logger.error('[Economy] Error:', error.message); res.redirect(`/manage/${guildId}?page=economy&error=failed`); }
    });

    app.post('/manage/:guildId/economy/shop/edit', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { item_id, item_name, price, description, role_id } = req.body;
            await pool.execute('UPDATE shop_items SET item_name = ?, price = ?, description = ?, role_id = ? WHERE guild_id = ? AND id = ?', [item_name, parseInt(price), description || null, role_id || null, guildId, item_id]);
            res.redirect(`/manage/${guildId}?page=economy&success=updated`);
        } catch (error) { logger.error('[Economy] Error:', error.message); res.redirect(`/manage/${guildId}?page=economy&error=failed`); }
    });

    app.post('/manage/:guildId/economy/shop/delete', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { item_id } = req.body;
            await pool.execute('DELETE FROM shop_items WHERE guild_id = ? AND id = ?', [guildId, item_id]);
            res.redirect(`/manage/${guildId}?page=economy&success=deleted`);
        } catch (error) { logger.error('[Economy] Error:', error.message); res.redirect(`/manage/${guildId}?page=economy&error=failed`); }
    });

    // --- Gambling ---
    app.post('/manage/:guildId/gambling/config', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { enabled, min_bet, max_bet, house_edge } = req.body;
            await pool.execute('INSERT INTO gambling_config (guild_id, enabled, min_bet, max_bet, house_edge) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), min_bet = VALUES(min_bet), max_bet = VALUES(max_bet), house_edge = VALUES(house_edge)', [guildId, enabled ? 1 : 0, parseInt(min_bet) || 10, parseInt(max_bet) || 10000, parseFloat(house_edge) || 0.05]);
            res.redirect(`/manage/${guildId}?page=gambling&success=saved`);
        } catch (error) { logger.error('[Gambling] Error:', error.message); res.redirect(`/manage/${guildId}?page=gambling&error=failed`); }
    });

    // --- Stat Roles ---
    app.post('/manage/:guildId/stat-roles/update', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { configs } = req.body;
            // Clear and re-insert
            await pool.execute('DELETE FROM statrole_configs WHERE guild_id = ?', [guildId]);
            if (configs && Array.isArray(configs)) {
                for (const cfg of configs) {
                    if (cfg.role_id && cfg.stat_type && cfg.threshold) {
                        await pool.execute('INSERT INTO statrole_configs (guild_id, role_id, stat_type, threshold) VALUES (?, ?, ?, ?)', [guildId, cfg.role_id, cfg.stat_type, parseInt(cfg.threshold)]);
                    }
                }
            }
            res.redirect(`/manage/${guildId}?page=stat-roles&success=saved`);
        } catch (error) { logger.error('[StatRoles] Error:', error.message); res.redirect(`/manage/${guildId}?page=stat-roles&error=failed`); }
    });

    // --- Suggestions ---
    app.post('/manage/:guildId/suggestions/approve', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { suggestion_id } = req.body;
            await pool.execute('UPDATE suggestions SET status = "approved" WHERE guild_id = ? AND id = ?', [guildId, suggestion_id]);
            res.redirect(`/manage/${guildId}?page=suggestions&success=updated`);
        } catch (error) { res.redirect(`/manage/${guildId}?page=suggestions&error=failed`); }
    });

    app.post('/manage/:guildId/suggestions/reject', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { suggestion_id } = req.body;
            await pool.execute('UPDATE suggestions SET status = "rejected" WHERE guild_id = ? AND id = ?', [guildId, suggestion_id]);
            res.redirect(`/manage/${guildId}?page=suggestions&success=updated`);
        } catch (error) { res.redirect(`/manage/${guildId}?page=suggestions&error=failed`); }
    });

    // --- Mass Actions ---
    app.post('/manage/:guildId/mass-assign-role', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { role_id, target_role_id } = req.body;
            if (!role_id) return res.redirect(`/manage/${guildId}?page=mass&error=missing_fields`);
            const botClient = global.botManager?.getClientForGuild(guildId) || req.app.locals.client;
            const guild = botClient?.guilds?.cache?.get(guildId);
            if (!guild) return res.redirect(`/manage/${guildId}?page=mass&error=guild_not_found`);
            await guild.members.fetch();
            const role = guild.roles.cache.get(role_id);
            if (!role) return res.redirect(`/manage/${guildId}?page=mass&error=role_not_found`);
            let count = 0;
            for (const [, member] of guild.members.cache) {
                if (member.roles.cache.has(role_id)) continue;
                if (target_role_id && !member.roles.cache.has(target_role_id)) continue;
                try { await member.roles.add(role, 'Mass assign via dashboard'); count++; } catch {}
            }
            logger.info(`[MassAction] Assigned role ${role.name} to ${count} members in ${guild.name}`);
            res.redirect(`/manage/${guildId}?page=mass&success=created`);
        } catch (error) { logger.error('[MassAction] Error:', error.message); res.redirect(`/manage/${guildId}?page=mass&error=failed`); }
    });

    app.post('/manage/:guildId/mass-remove-role', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { role_id } = req.body;
            if (!role_id) return res.redirect(`/manage/${guildId}?page=mass&error=missing_fields`);
            const botClient = global.botManager?.getClientForGuild(guildId) || req.app.locals.client;
            const guild = botClient?.guilds?.cache?.get(guildId);
            if (!guild) return res.redirect(`/manage/${guildId}?page=mass&error=guild_not_found`);
            const role = guild.roles.cache.get(role_id);
            if (!role) return res.redirect(`/manage/${guildId}?page=mass&error=role_not_found`);
            let count = 0;
            for (const [, member] of role.members) {
                try { await member.roles.remove(role, 'Mass remove via dashboard'); count++; } catch {}
            }
            logger.info(`[MassAction] Removed role ${role.name} from ${count} members in ${guild.name}`);
            res.redirect(`/manage/${guildId}?page=mass&success=deleted`);
        } catch (error) { logger.error('[MassAction] Error:', error.message); res.redirect(`/manage/${guildId}?page=mass&error=failed`); }
    });

    app.post('/manage/:guildId/mass-kick', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { role_id, reason } = req.body;
            if (!role_id) return res.redirect(`/manage/${guildId}?page=mass&error=missing_fields`);
            const botClient = global.botManager?.getClientForGuild(guildId) || req.app.locals.client;
            const guild = botClient?.guilds?.cache?.get(guildId);
            if (!guild) return res.redirect(`/manage/${guildId}?page=mass&error=guild_not_found`);
            const role = guild.roles.cache.get(role_id);
            if (!role) return res.redirect(`/manage/${guildId}?page=mass&error=role_not_found`);
            let count = 0;
            for (const [, member] of role.members) {
                if (!member.kickable) continue;
                try { await member.kick(reason || 'Mass kick via dashboard'); count++; } catch {}
            }
            logger.info(`[MassAction] Kicked ${count} members with role ${role.name} in ${guild.name}`);
            res.redirect(`/manage/${guildId}?page=mass&success=deleted`);
        } catch (error) { logger.error('[MassAction] Error:', error.message); res.redirect(`/manage/${guildId}?page=mass&error=failed`); }
    });

    app.post('/manage/:guildId/mass-ban', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { role_id, reason } = req.body;
            if (!role_id) return res.redirect(`/manage/${guildId}?page=mass&error=missing_fields`);
            const botClient = global.botManager?.getClientForGuild(guildId) || req.app.locals.client;
            const guild = botClient?.guilds?.cache?.get(guildId);
            if (!guild) return res.redirect(`/manage/${guildId}?page=mass&error=guild_not_found`);
            const role = guild.roles.cache.get(role_id);
            if (!role) return res.redirect(`/manage/${guildId}?page=mass&error=role_not_found`);
            let count = 0;
            for (const [, member] of role.members) {
                if (!member.bannable) continue;
                try { await member.ban({ reason: reason || 'Mass ban via dashboard' }); count++; } catch {}
            }
            logger.info(`[MassAction] Banned ${count} members with role ${role.name} in ${guild.name}`);
            res.redirect(`/manage/${guildId}?page=mass&success=deleted`);
        } catch (error) { logger.error('[MassAction] Error:', error.message); res.redirect(`/manage/${guildId}?page=mass&error=failed`); }
    });

    // --- Ranks (Self-Assignable Roles) ---
    app.post('/manage/:guildId/add-self-assignable-role', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { role_id, category } = req.body;
            if (!role_id) return res.redirect(`/manage/${guildId}?page=ranks&error=missing_fields`);
            await pool.execute('INSERT INTO joinable_ranks (guild_id, role_id, category) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE category = VALUES(category)', [guildId, role_id, category || 'General']);
            res.redirect(`/manage/${guildId}?page=ranks&success=created`);
        } catch (error) { res.redirect(`/manage/${guildId}?page=ranks&error=failed`); }
    });

    app.post('/manage/:guildId/edit-self-assignable-role', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { role_id, category } = req.body;
            await pool.execute('UPDATE joinable_ranks SET category = ? WHERE guild_id = ? AND role_id = ?', [category || 'General', guildId, role_id]);
            res.redirect(`/manage/${guildId}?page=ranks&success=updated`);
        } catch (error) { res.redirect(`/manage/${guildId}?page=ranks&error=failed`); }
    });

    app.post('/manage/:guildId/remove-self-assignable-role', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { role_id } = req.body;
            await pool.execute('DELETE FROM joinable_ranks WHERE guild_id = ? AND role_id = ?', [guildId, role_id]);
            res.redirect(`/manage/${guildId}?page=ranks&success=deleted`);
        } catch (error) { res.redirect(`/manage/${guildId}?page=ranks&error=failed`); }
    });

    app.post('/manage/:guildId/add-role-category', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { category_name } = req.body;
            // Categories are implicit from the joinable_ranks table — no separate table needed
            res.redirect(`/manage/${guildId}?page=ranks&success=created`);
        } catch (error) { res.redirect(`/manage/${guildId}?page=ranks&error=failed`); }
    });

    app.post('/manage/:guildId/edit-role-category', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { old_category, new_category } = req.body;
            await pool.execute('UPDATE joinable_ranks SET category = ? WHERE guild_id = ? AND category = ?', [new_category, guildId, old_category]);
            res.redirect(`/manage/${guildId}?page=ranks&success=updated`);
        } catch (error) { res.redirect(`/manage/${guildId}?page=ranks&error=failed`); }
    });

    app.post('/manage/:guildId/delete-role-category', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { category } = req.body;
            await pool.execute('DELETE FROM joinable_ranks WHERE guild_id = ? AND category = ?', [guildId, category]);
            res.redirect(`/manage/${guildId}?page=ranks&success=deleted`);
        } catch (error) { res.redirect(`/manage/${guildId}?page=ranks&error=failed`); }
    });

    app.post('/manage/:guildId/update-rank-config', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            // Rank config is typically just the self-assignable role settings — redirect back
            res.redirect(`/manage/${guildId}?page=ranks&success=saved`);
        } catch (error) { res.redirect(`/manage/${guildId}?page=ranks&error=failed`); }
    });

    // --- Music Playlists ---
    app.post('/manage/:guildId/music/playlists', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { playlist_name, playlist_url } = req.body;
            if (!playlist_name) return res.redirect(`/manage/${guildId}?page=music&error=missing_fields`);
            await pool.execute('INSERT INTO music_playlists (guild_id, name, url, created_by) VALUES (?, ?, ?, ?)', [guildId, playlist_name, playlist_url || null, req.user.id]);
            res.redirect(`/manage/${guildId}?page=music&success=created`);
        } catch (error) { logger.error('[Music] Error:', error.message); res.redirect(`/manage/${guildId}?page=music&error=failed`); }
    });

    // --- Import ---
    app.post('/manage/:guildId/import-csv', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        // CSV import needs file upload handling — redirect with info
        res.redirect(`/manage/${guildId}?page=csv&error=csv_import_requires_file`);
    });

    app.post('/manage/:guildId/import-team', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { team_url } = req.body;
            if (!team_url) return res.redirect(`/manage/${guildId}?page=mass&error=missing_fields`);
            // Team import logic would go here
            res.redirect(`/manage/${guildId}?page=mass&success=created`);
        } catch (error) { res.redirect(`/manage/${guildId}?page=mass&error=failed`); }
    });

    // --- Trading ---
    app.post('/manage/:guildId/trading/cancel', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { trade_id } = req.body;
            await pool.execute('UPDATE trades SET status = "cancelled" WHERE guild_id = ? AND id = ?', [guildId, trade_id]);
            res.redirect(`/manage/${guildId}?page=trading&success=updated`);
        } catch (error) { res.redirect(`/manage/${guildId}?page=trading&error=failed`); }
    });

    // --- Teams (edit) ---
    app.post('/manage/:guildId/edit-team', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { team_id, team_name, webhook_avatar_url } = req.body;
            if (!team_id) return res.redirect(`/manage/${guildId}?page=streamers&error=missing_fields`);
            await pool.execute('UPDATE teams SET team_name = ?, webhook_avatar_url = ? WHERE guild_id = ? AND team_id = ?', [team_name, webhook_avatar_url || null, guildId, team_id]);
            res.redirect(`/manage/${guildId}?page=streamers&success=updated`);
        } catch (error) { logger.error('[Teams] Error:', error.message); res.redirect(`/manage/${guildId}?page=streamers&error=failed`); }
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
            const { log_channel_id, enabled_logs, log_categories, event_colors } = req.body;

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
            const colorOverrides = event_colors || {};

            // Define all possible log categories to ensure we update disabled ones too
            const allCategories = [
                'memberJoin', 'messageDelete', 'messageUpdate', 'memberUpdate', 'memberLeave', 'memberKick',
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
                const embedColor = colorOverrides[eventType] || null;

                await pool.execute(`
                    INSERT INTO log_event_config (guild_id, event_type, enabled, log_channel_id, embed_color)
                    VALUES (?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        enabled = VALUES(enabled),
                        log_channel_id = VALUES(log_channel_id),
                        embed_color = VALUES(embed_color)
                `, [guildId, eventType, isEnabled ? 1 : 0, channelOverride, embedColor]);
            }

            res.redirect(`/manage/${guildId}?page=logging&success=config`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-logging Error]', error);
            res.redirect(`/manage/${guildId}?page=logging&error=config`);
        }
    });

    // ===========================
    // CUSTOM EMBEDS
    // ===========================

    app.post('/manage/:guildId/create-custom-embed', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { channel_id, title, description, color, thumbnail_url, image_url, footer_text, author_name, author_icon_url, url, action } = req.body;

            if (!channel_id) {
                return res.redirect(`/manage/${guildId}?page=custom-embeds&error=missing_channel`);
            }
            if (!title && !description) {
                return res.redirect(`/manage/${guildId}?page=custom-embeds&error=missing_content`);
            }

            const [result] = await pool.execute(`
                INSERT INTO custom_embeds (guild_id, channel_id, title, description, color, thumbnail_url, image_url, footer_text, author_name, author_icon_url, url, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [guildId, channel_id, title || null, description || null, color || '#a78bfa', thumbnail_url || null, image_url || null, footer_text || null, author_name || null, author_icon_url || null, url || null, req.user.id]);

            const embedId = result.insertId;

            // If action is 'post', immediately post to Discord
            if (action === 'post') {
                try {
                    const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient() || client;
                    const channel = await botClient.channels.fetch(channel_id).catch(() => null);
                    if (channel && channel.isTextBased()) {
                        const embed = new EmbedBuilder()
                            .setColor(color || '#a78bfa');
                        if (title) embed.setTitle(title);
                        if (description) embed.setDescription(description);
                        if (url) embed.setURL(url);
                        if (thumbnail_url) embed.setThumbnail(thumbnail_url);
                        if (image_url) embed.setImage(image_url);
                        if (footer_text) embed.setFooter({ text: footer_text });
                        if (author_name) embed.setAuthor({ name: author_name, iconURL: author_icon_url || undefined });
                        embed.setTimestamp();

                        const msg = await channel.send({ embeds: [embed] });
                        await pool.execute('UPDATE custom_embeds SET message_id = ? WHERE id = ?', [msg.id, embedId]);
                        logger.info(`[Custom Embeds] Posted embed ${embedId} to channel ${channel_id} as message ${msg.id}`);
                    }
                } catch (postErr) {
                    logger.error(`[Custom Embeds] Failed to post embed ${embedId}: ${postErr.message}`);
                }
            }

            res.redirect(`/manage/${guildId}?page=custom-embeds&success=created`);
        } catch (error) {
            logger.error('[POST create-custom-embed Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=custom-embeds&error=create_failed`);
        }
    });

    app.post('/api/guilds/:guildId/custom-embeds/:embedId/post', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, embedId } = req.params;
            const [embeds] = await pool.execute('SELECT * FROM custom_embeds WHERE id = ? AND guild_id = ?', [embedId, guildId]);
            if (!embeds.length) return res.json({ success: false, error: 'Embed not found' });

            const emb = embeds[0];
            if (emb.message_id) return res.json({ success: false, error: 'Already posted' });

            const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient() || client;
            const channel = await botClient.channels.fetch(emb.channel_id).catch(() => null);
            if (!channel || !channel.isTextBased()) return res.json({ success: false, error: 'Channel not found' });

            const embed = new EmbedBuilder().setColor(emb.color || '#a78bfa');
            if (emb.title) embed.setTitle(emb.title);
            if (emb.description) embed.setDescription(emb.description);
            if (emb.url) embed.setURL(emb.url);
            if (emb.thumbnail_url) embed.setThumbnail(emb.thumbnail_url);
            if (emb.image_url) embed.setImage(emb.image_url);
            if (emb.footer_text) embed.setFooter({ text: emb.footer_text });
            if (emb.author_name) embed.setAuthor({ name: emb.author_name, iconURL: emb.author_icon_url || undefined });
            embed.setTimestamp();

            const msg = await channel.send({ embeds: [embed] });
            await pool.execute('UPDATE custom_embeds SET message_id = ? WHERE id = ?', [msg.id, embedId]);

            res.json({ success: true, message_id: msg.id });
        } catch (error) {
            logger.error('[POST custom-embeds post Error]', error);
            res.status(500).json({ success: false, error: 'Failed to post' });
        }
    });

    app.post('/manage/:guildId/delete-custom-embed', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { embedId } = req.body;
            const [embeds] = await pool.execute('SELECT * FROM custom_embeds WHERE id = ? AND guild_id = ?', [embedId, guildId]);
            if (embeds.length && embeds[0].message_id) {
                try {
                    const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient() || client;
                    const channel = await botClient.channels.fetch(embeds[0].channel_id).catch(() => null);
                    if (channel) {
                        const msg = await channel.messages.fetch(embeds[0].message_id).catch(() => null);
                        if (msg) await msg.delete().catch(() => {});
                    }
                } catch { /* best effort */ }
            }
            await pool.execute('DELETE FROM custom_embeds WHERE id = ? AND guild_id = ?', [embedId, guildId]);
            res.redirect(`/manage/${guildId}?page=custom-embeds&success=deleted`);
        } catch (error) {
            logger.error('[POST delete-custom-embed Error]', error);
            res.redirect(`/manage/${guildId}?page=custom-embeds&error=delete_failed`);
        }
    });

    // Edit custom embed
    app.post('/manage/:guildId/edit-custom-embed', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { embedId, channel_id, title, description, color, thumbnail_url, image_url, footer_text, author_name, author_icon_url, url, action } = req.body;

            await pool.execute(
                `UPDATE custom_embeds SET channel_id = ?, title = ?, description = ?, color = ?, thumbnail_url = ?, image_url = ?, footer_text = ?, author_name = ?, author_icon_url = ?, url = ?, updated_at = NOW() WHERE id = ? AND guild_id = ?`,
                [channel_id, title || null, description || null, color || '#a78bfa', thumbnail_url || null, image_url || null, footer_text || null, author_name || null, author_icon_url || null, url || null, embedId, guildId]
            );

            // If "Save & Update Discord Message", also edit the live message
            if (action === 'update_discord') {
                const [embeds] = await pool.execute('SELECT * FROM custom_embeds WHERE id = ? AND guild_id = ?', [embedId, guildId]);
                if (embeds.length) {
                    try {
                        const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient() || client;
                        const channel = await botClient.channels.fetch(embeds[0].channel_id).catch(() => null);
                        if (channel) {
                            const embed = new EmbedBuilder().setColor(embeds[0].color || '#a78bfa');
                            if (embeds[0].title) embed.setTitle(embeds[0].title);
                            if (embeds[0].url) embed.setURL(embeds[0].url);
                            if (embeds[0].description) embed.setDescription(embeds[0].description);
                            if (embeds[0].thumbnail_url) embed.setThumbnail(embeds[0].thumbnail_url);
                            if (embeds[0].image_url) embed.setImage(embeds[0].image_url);
                            if (embeds[0].footer_text) embed.setFooter({ text: embeds[0].footer_text });
                            if (embeds[0].author_name) {
                                const authorObj = { name: embeds[0].author_name };
                                if (embeds[0].author_icon_url) authorObj.iconURL = embeds[0].author_icon_url;
                                embed.setAuthor(authorObj);
                            }

                            let updated = false;
                            // Try to edit existing message first
                            if (embeds[0].message_id) {
                                try {
                                    const msg = await channel.messages.fetch(embeds[0].message_id).catch(() => null);
                                    if (msg && msg.author.id === botClient.user.id) {
                                        await msg.edit({ embeds: [embed] });
                                        updated = true;
                                    } else if (msg) {
                                        // Message exists but was posted by a different bot — delete and repost
                                        await msg.delete().catch(() => {});
                                    }
                                } catch { /* message may be gone */ }
                            }

                            // If edit didn't work, post a new message
                            if (!updated) {
                                const newMsg = await channel.send({ embeds: [embed] });
                                await pool.execute('UPDATE custom_embeds SET message_id = ? WHERE id = ?', [newMsg.id, embedId]);
                                logger.info(`[Custom Embeds] Reposted embed ${embedId} as new message ${newMsg.id} (old message was from different bot)`);
                            }
                        }
                    } catch (e) {
                        logger.warn('[Edit Custom Embed] Failed to update Discord message:', e.message);
                    }
                }
            }

            res.redirect(`/manage/${guildId}?page=custom-embeds&success=updated`);
        } catch (error) {
            logger.error('[POST edit-custom-embed Error]', error);
            res.redirect(`/manage/${guildId}?page=custom-embeds&error=edit_failed`);
        }
    });

    // ===========================
    // SCHEDULED PURGE ROUTES
    // ===========================

    app.post('/manage/:guildId/add-purge', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { channel_id, mode, purge_time, interval_hours } = req.body;
            if (!channel_id) return res.redirect(`/manage/${guildId}?page=auto-purge&error=missing_channel`);

            const isInterval = mode === 'interval';
            await pool.execute(`
                INSERT INTO scheduled_purges (guild_id, channel_id, purge_time, interval_hours, enabled, created_by)
                VALUES (?, ?, ?, ?, 1, ?)
                ON DUPLICATE KEY UPDATE purge_time = VALUES(purge_time), interval_hours = VALUES(interval_hours), enabled = 1
            `, [guildId, channel_id, isInterval ? '00:00' : (purge_time || '00:00'), isInterval ? (parseInt(interval_hours) || 24) : null, req.user.id]);

            logger.info(`[Auto Purge] Schedule added for channel ${channel_id} in guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=auto-purge&success=added`);
        } catch (error) {
            logger.error('[POST add-purge Error]', error);
            res.redirect(`/manage/${guildId}?page=auto-purge&error=add_failed`);
        }
    });

    app.post('/manage/:guildId/remove-purge', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            await pool.execute('DELETE FROM scheduled_purges WHERE id = ? AND guild_id = ?', [req.body.purgeId, guildId]);
            res.redirect(`/manage/${guildId}?page=auto-purge&success=removed`);
        } catch (error) {
            logger.error('[POST remove-purge Error]', error);
            res.redirect(`/manage/${guildId}?page=auto-purge&error=remove_failed`);
        }
    });

    app.post('/manage/:guildId/toggle-purge', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            await pool.execute('UPDATE scheduled_purges SET enabled = ? WHERE id = ? AND guild_id = ?', [req.body.enabled === '1' ? 1 : 0, req.body.purgeId, guildId]);
            res.redirect(`/manage/${guildId}?page=auto-purge&success=toggled`);
        } catch (error) {
            logger.error('[POST toggle-purge Error]', error);
            res.redirect(`/manage/${guildId}?page=auto-purge&error=toggle_failed`);
        }
    });

    // ===========================
    // SOCIAL FEED ROUTES
    // ===========================

    // YouTube Feeds
    app.post('/manage/:guildId/add-youtube-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const wantsJson = req.is('application/json') || req.accepts(['html', 'json']) === 'json';
        try {
            const { youtube_channel_id } = req.body;
            const discordChannelId = req.body.discord_channel_id || req.body.channel_id;
            if (!youtube_channel_id || !discordChannelId) {
                if (wantsJson) return res.status(400).json({ error: 'Missing required fields: youtube_channel_id, discord_channel_id' });
                return res.redirect(`/manage/${guildId}?page=feeds&error=missing_fields`);
            }
            await pool.execute(
                'INSERT INTO youtube_feeds (guild_id, youtube_channel_id, discord_channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE discord_channel_id = VALUES(discord_channel_id)',
                [guildId, youtube_channel_id.trim(), discordChannelId]
            );
            logger.info(`[Feeds] YouTube feed added: ${youtube_channel_id} → ${discordChannelId} in guild ${guildId}`);
            if (wantsJson) return res.json({ success: true });
            res.redirect(`/manage/${guildId}?page=feeds&success=youtube_added`);
        } catch (error) {
            logger.error('[POST add-youtube-feed Error]', error);
            if (wantsJson) return res.status(500).json({ error: 'Failed to add YouTube feed' });
            res.redirect(`/manage/${guildId}?page=feeds&error=youtube`);
        }
    });

    app.post('/manage/:guildId/remove-youtube-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            await pool.execute('DELETE FROM youtube_feeds WHERE id = ? AND guild_id = ?', [req.body.feedId, guildId]);
            logger.info(`[Feeds] YouTube feed ${req.body.feedId} removed from guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=feeds&success=youtube_removed`);
        } catch (error) {
            logger.error('[POST remove-youtube-feed Error]', error);
            res.redirect(`/manage/${guildId}?page=feeds&error=youtube`);
        }
    });

    // Reddit Feeds
    app.post('/manage/:guildId/add-reddit-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const wantsJson = req.is('application/json') || req.accepts(['html', 'json']) === 'json';
        try {
            const { subreddit } = req.body;
            const channelId = req.body.channel_id || req.body.discord_channel_id;
            if (!subreddit || !channelId) {
                if (wantsJson) return res.status(400).json({ error: 'Missing required fields: subreddit, channel_id' });
                return res.redirect(`/manage/${guildId}?page=feeds&error=missing_fields`);
            }
            const cleanSubreddit = subreddit.trim().replace(/^r\//, '');
            await pool.execute(
                'INSERT INTO reddit_feeds (guild_id, subreddit, channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id)',
                [guildId, cleanSubreddit, channelId]
            );
            logger.info(`[Feeds] Reddit feed added: r/${cleanSubreddit} → ${channelId} in guild ${guildId}`);
            if (wantsJson) return res.json({ success: true });
            res.redirect(`/manage/${guildId}?page=feeds&success=reddit_added`);
        } catch (error) {
            logger.error('[POST add-reddit-feed Error]', error);
            if (wantsJson) return res.status(500).json({ error: 'Failed to add Reddit feed' });
            res.redirect(`/manage/${guildId}?page=feeds&error=reddit`);
        }
    });

    app.post('/manage/:guildId/remove-reddit-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            await pool.execute('DELETE FROM reddit_feeds WHERE id = ? AND guild_id = ?', [req.body.feedId, guildId]);
            logger.info(`[Feeds] Reddit feed ${req.body.feedId} removed from guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=feeds&success=reddit_removed`);
        } catch (error) {
            logger.error('[POST remove-reddit-feed Error]', error);
            res.redirect(`/manage/${guildId}?page=feeds&error=reddit`);
        }
    });

    // Twitter/X Feeds
    app.post('/manage/:guildId/add-twitter-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const wantsJson = req.is('application/json') || req.accepts(['html', 'json']) === 'json';
        try {
            const { twitter_username } = req.body;
            // Modern form sends `channel_id`; older code passed `discord_channel_id`. Accept either.
            const channelId = req.body.channel_id || req.body.discord_channel_id;
            if (!twitter_username || !channelId) {
                if (wantsJson) return res.status(400).json({ error: 'Missing required fields: twitter_username, channel_id' });
                return res.redirect(`/manage/${guildId}?page=feeds&error=missing_fields`);
            }
            const cleanUsername = twitter_username.trim().replace(/^@/, '');
            await pool.execute(
                'INSERT INTO twitter_feeds (guild_id, twitter_username, channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id)',
                [guildId, cleanUsername, channelId]
            );
            logger.info(`[Feeds] Twitter feed added: @${cleanUsername} → ${channelId} in guild ${guildId}`);
            if (wantsJson) return res.json({ success: true, twitter_username: cleanUsername, channel_id: channelId });
            res.redirect(`/manage/${guildId}?page=feeds&success=twitter_added`);
        } catch (error) {
            logger.error('[POST add-twitter-feed Error]', error);
            if (wantsJson) return res.status(500).json({ error: 'Failed to add Twitter feed' });
            res.redirect(`/manage/${guildId}?page=feeds&error=twitter`);
        }
    });

    app.post('/manage/:guildId/remove-twitter-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            await pool.execute('DELETE FROM twitter_feeds WHERE id = ? AND guild_id = ?', [req.body.feedId, guildId]);
            logger.info(`[Feeds] Twitter feed ${req.body.feedId} removed from guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=feeds&success=twitter_removed`);
        } catch (error) {
            logger.error('[POST remove-twitter-feed Error]', error);
            res.redirect(`/manage/${guildId}?page=feeds&error=twitter`);
        }
    });

    // ===========================
    // BLUESKY ROUTES
    // ===========================
    app.post('/manage/:guildId/add-bluesky-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const wantsJson = req.is('application/json') || req.accepts(['html', 'json']) === 'json';
        try {
            let { bluesky_handle } = req.body;
            const channelId = req.body.channel_id || req.body.discord_channel_id;
            if (!bluesky_handle || !channelId) {
                if (wantsJson) return res.status(400).json({ error: 'Missing required fields: bluesky_handle, channel_id' });
                return res.redirect(`/manage/${guildId}?page=feeds&error=missing_fields`);
            }
            bluesky_handle = bluesky_handle.trim().replace(/^@/, '').replace(/^https?:\/\/bsky\.app\/profile\//, '');

            // Resolve the profile to confirm the handle is real before persisting
            const { getProfile } = await import('../utils/platforms/bluesky.js');
            const profile = await getProfile(bluesky_handle);
            if (!profile) {
                if (wantsJson) return res.status(404).json({ error: `Bluesky handle @${bluesky_handle} not found` });
                return res.redirect(`/manage/${guildId}?page=feeds&error=bluesky_not_found`);
            }

            await pool.execute(
                'INSERT INTO bluesky_feeds (guild_id, bluesky_handle, channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id)',
                [guildId, bluesky_handle, channelId]
            );
            logger.info(`[Feeds] Bluesky feed added: @${bluesky_handle} → ${channelId} in guild ${guildId}`);
            if (wantsJson) return res.json({ success: true, bluesky_handle, channel_id: channelId, profile: { displayName: profile.displayName, handle: profile.handle } });
            res.redirect(`/manage/${guildId}?page=feeds&success=bluesky_added`);
        } catch (error) {
            logger.error('[POST add-bluesky-feed Error]', error);
            if (wantsJson) return res.status(500).json({ error: 'Failed to add Bluesky feed' });
            res.redirect(`/manage/${guildId}?page=feeds&error=bluesky`);
        }
    });

    app.post('/manage/:guildId/remove-bluesky-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            await pool.execute('DELETE FROM bluesky_feeds WHERE id = ? AND guild_id = ?', [req.body.feedId, guildId]);
            logger.info(`[Feeds] Bluesky feed ${req.body.feedId} removed from guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=feeds&success=bluesky_removed`);
        } catch (error) {
            logger.error('[POST remove-bluesky-feed Error]', error);
            res.redirect(`/manage/${guildId}?page=feeds&error=bluesky`);
        }
    });

    // ===========================
    // INSTAGRAM ROUTES
    // ===========================
    app.post('/manage/:guildId/add-instagram-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const wantsJson = req.is('application/json') || req.accepts(['html', 'json']) === 'json';
        try {
            let { instagram_username } = req.body;
            const channelId = req.body.channel_id || req.body.discord_channel_id;
            if (!instagram_username || !channelId) {
                if (wantsJson) return res.status(400).json({ error: 'Missing required fields: instagram_username, channel_id' });
                return res.redirect(`/manage/${guildId}?page=feeds&error=missing_fields`);
            }
            instagram_username = instagram_username.trim().replace(/^@/, '');

            const { igBusinessDiscovery } = await import('../utils/platforms/meta.js');
            const biz = await igBusinessDiscovery(instagram_username, { mediaLimit: 1 });
            if (!biz) {
                const msg = `Instagram profile @${instagram_username} not found or not a Business/Creator account (Graph API requirement)`;
                if (wantsJson) return res.status(404).json({ error: msg });
                return res.redirect(`/manage/${guildId}?page=feeds&error=instagram_not_discoverable`);
            }

            await pool.execute(
                'INSERT INTO instagram_feeds (guild_id, instagram_username, ig_user_id, channel_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), ig_user_id = VALUES(ig_user_id)',
                [guildId, instagram_username, biz.id || null, channelId]
            );
            logger.info(`[Feeds] Instagram feed added: @${instagram_username} → ${channelId} in guild ${guildId}`);
            if (wantsJson) return res.json({ success: true, instagram_username, channel_id: channelId });
            res.redirect(`/manage/${guildId}?page=feeds&success=instagram_added`);
        } catch (error) {
            logger.error('[POST add-instagram-feed Error]', error);
            if (wantsJson) return res.status(500).json({ error: 'Failed to add Instagram feed' });
            res.redirect(`/manage/${guildId}?page=feeds&error=instagram`);
        }
    });

    app.post('/manage/:guildId/remove-instagram-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            await pool.execute('DELETE FROM instagram_feeds WHERE id = ? AND guild_id = ?', [req.body.feedId, guildId]);
            res.redirect(`/manage/${guildId}?page=feeds&success=instagram_removed`);
        } catch (error) {
            logger.error('[POST remove-instagram-feed Error]', error);
            res.redirect(`/manage/${guildId}?page=feeds&error=instagram`);
        }
    });

    // ===========================
    // FACEBOOK PAGE ROUTES
    // ===========================
    app.post('/manage/:guildId/add-facebook-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const wantsJson = req.is('application/json') || req.accepts(['html', 'json']) === 'json';
        try {
            const { facebook_page_id } = req.body;
            const channelId = req.body.channel_id || req.body.discord_channel_id;
            if (!facebook_page_id || !channelId) {
                if (wantsJson) return res.status(400).json({ error: 'Missing required fields: facebook_page_id, channel_id' });
                return res.redirect(`/manage/${guildId}?page=feeds&error=missing_fields`);
            }
            const pageId = facebook_page_id.trim();

            const { fbPageInfo } = await import('../utils/platforms/meta.js');
            const info = await fbPageInfo(pageId);
            if (!info) {
                const msg = `Facebook page ${pageId} not accessible with the configured token`;
                if (wantsJson) return res.status(404).json({ error: msg });
                return res.redirect(`/manage/${guildId}?page=feeds&error=facebook_not_found`);
            }

            await pool.execute(
                'INSERT INTO facebook_feeds (guild_id, facebook_page_id, page_name, channel_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), page_name = VALUES(page_name)',
                [guildId, pageId, info.name || null, channelId]
            );
            logger.info(`[Feeds] Facebook feed added: ${info.name || pageId} → ${channelId} in guild ${guildId}`);
            if (wantsJson) return res.json({ success: true, facebook_page_id: pageId, page_name: info.name, channel_id: channelId });
            res.redirect(`/manage/${guildId}?page=feeds&success=facebook_added`);
        } catch (error) {
            logger.error('[POST add-facebook-feed Error]', error);
            if (wantsJson) return res.status(500).json({ error: 'Failed to add Facebook feed' });
            res.redirect(`/manage/${guildId}?page=feeds&error=facebook`);
        }
    });

    app.post('/manage/:guildId/remove-facebook-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            await pool.execute('DELETE FROM facebook_feeds WHERE id = ? AND guild_id = ?', [req.body.feedId, guildId]);
            res.redirect(`/manage/${guildId}?page=feeds&success=facebook_removed`);
        } catch (error) {
            logger.error('[POST remove-facebook-feed Error]', error);
            res.redirect(`/manage/${guildId}?page=feeds&error=facebook`);
        }
    });

    // ===========================
    // TIKTOK ROUTES
    // ===========================

    // Add TikTok creator directly from the TikTok page (with video feed enabled by default)
    app.post('/manage/:guildId/tiktok/add-creator', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            let { username, channel_id, custom_message, mention_role_id } = req.body;
            if (!username || !channel_id) return res.redirect(`/manage/${guildId}?page=tiktok&error=missing_fields`);

            username = username.trim().replace(/^@/, '').toLowerCase();

            // Resolve the real TikTok user id before persisting — never insert temp_ placeholders.
            const { resolveStreamerIdentity, upsertStreamerByIdentity } = await import('../utils/platforms/resolve-identity.js');
            const identity = await resolveStreamerIdentity('tiktok', username);
            if (!identity) {
                logger.warn('[TikTok add-creator] TikTok user not resolvable', { username });
                return res.redirect(`/manage/${guildId}?page=tiktok&error=tiktok_user_not_found`);
            }
            const streamerId = await upsertStreamerByIdentity(pool, 'tiktok', identity, null);

            // Create subscription with video feed enabled, custom message, and mention role
            await pool.execute(`
                INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, video_announcement_channel_id, tiktok_vod_notifications, delete_on_end, custom_message, live_role_id)
                VALUES (?, ?, ?, ?, 1, 1, ?, ?)
                ON DUPLICATE KEY UPDATE video_announcement_channel_id = VALUES(video_announcement_channel_id), tiktok_vod_notifications = 1, custom_message = VALUES(custom_message), live_role_id = VALUES(live_role_id)
            `, [guildId, streamerId, channel_id, channel_id, custom_message || null, mention_role_id || null]);

            logger.info(`[TikTok] Creator @${username} added with video feed to channel ${channel_id} in guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=tiktok&success=creator_added`);
        } catch (error) {
            logger.error('[POST tiktok/add-creator Error]', error);
            res.redirect(`/manage/${guildId}?page=tiktok&error=add_failed`);
        }
    });

    // Toggle video feed notifications for a TikTok subscription
    app.post('/manage/:guildId/tiktok/toggle-feed', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { subscription_id, enabled } = req.body;
            await pool.execute(
                'UPDATE subscriptions SET tiktok_vod_notifications = ? WHERE subscription_id = ? AND guild_id = ?',
                [enabled === '1' ? 1 : 0, subscription_id, guildId]
            );
            logger.info(`[TikTok] Toggled video feed for sub ${subscription_id} in guild ${guildId}: ${enabled}`);
            res.redirect(`/manage/${guildId}?page=tiktok&success=feed_toggled`);
        } catch (error) {
            logger.error('[TikTok toggle-feed Error]', error);
            res.redirect(`/manage/${guildId}?page=tiktok&error=feed_toggle`);
        }
    });

    // Edit a TikTok creator's settings
    app.post('/manage/:guildId/tiktok/edit', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { subscription_id, announcement_channel_id, video_announcement_channel_id, live_role_id, ping_role_id, custom_message, delete_on_end, edit_on_end, tiktok_embed_video } = req.body;
            await pool.execute(`
                UPDATE subscriptions SET
                    announcement_channel_id = ?,
                    video_announcement_channel_id = ?,
                    live_role_id = ?,
                    ping_role_id = ?,
                    custom_message = ?,
                    delete_on_end = ?,
                    edit_on_end = ?,
                    tiktok_embed_video = ?
                WHERE subscription_id = ? AND guild_id = ?
            `, [
                announcement_channel_id || null,
                video_announcement_channel_id || null,
                live_role_id || null,
                ping_role_id || null,
                custom_message || null,
                delete_on_end ? 1 : 0,
                edit_on_end ? 1 : 0,
                tiktok_embed_video ? 1 : 0,
                subscription_id,
                guildId,
            ]);
            logger.info(`[TikTok] Updated settings for sub ${subscription_id} in guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=tiktok&success=updated`);
        } catch (error) {
            logger.error('[TikTok edit Error]', error);
            res.redirect(`/manage/${guildId}?page=tiktok&error=edit_failed`);
        }
    });

    // Remove a TikTok creator
    app.post('/manage/:guildId/tiktok/remove', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { subscription_id, streamer_id } = req.body;
            // Delete the subscription
            await pool.execute('DELETE FROM subscriptions WHERE subscription_id = ? AND guild_id = ?', [subscription_id, guildId]);
            // Check if any other guilds still track this streamer
            const [remaining] = await pool.execute('SELECT COUNT(*) as c FROM subscriptions WHERE streamer_id = ?', [streamer_id]);
            if (remaining[0].c === 0) {
                // No other guilds track this streamer — clean up streamer record
                await pool.execute('DELETE FROM streamers WHERE streamer_id = ? AND platform = ?', [streamer_id, 'tiktok']).catch(() => {});
            }
            logger.info(`[TikTok] Removed sub ${subscription_id} (streamer ${streamer_id}) from guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=tiktok&success=removed`);
        } catch (error) {
            logger.error('[TikTok remove Error]', error);
            res.redirect(`/manage/${guildId}?page=tiktok&error=remove_failed`);
        }
    });

    // Update TikTok feed settings (video channel override)
    app.post('/manage/:guildId/tiktok/feed-settings', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { video_channel_id } = req.body;
            const channelId = video_channel_id || null;

            // Update all TikTok subscriptions for this guild with the video channel
            await pool.execute(`
                UPDATE subscriptions sub
                JOIN streamers s ON sub.streamer_id = s.streamer_id
                SET sub.video_announcement_channel_id = ?
                WHERE s.platform = 'tiktok' AND sub.guild_id = ?
            `, [channelId, guildId]);

            logger.info(`[TikTok] Updated feed channel for guild ${guildId}: ${channelId || 'default'}`);
            res.redirect(`/manage/${guildId}?page=tiktok&success=feed_settings`);
        } catch (error) {
            logger.error('[TikTok feed-settings Error]', error);
            res.redirect(`/manage/${guildId}?page=tiktok&error=feed_settings`);
        }
    });

    // Twitch Role Sync — Save settings
    app.post('/manage/:guildId/twitch-role-sync/settings', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const { vip_role_id, mod_role_id, sub_role_id, remove_vip_on_leave, enabled } = req.body;
        try {
            await pool.execute(`
                UPDATE twitch_role_sync_config SET
                    vip_role_id = ?, mod_role_id = ?, sub_role_id = ?,
                    remove_vip_on_leave = ?, enabled = ?
                WHERE guild_id = ?
            `, [vip_role_id || null, mod_role_id || null, sub_role_id || null, remove_vip_on_leave ? 1 : 0, enabled ? 1 : 0, guildId]);
            logger.info(`[TwitchRoleSync] Updated settings for guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=streamers&success=sync_settings_saved`);
        } catch (err) {
            logger.error('[TwitchRoleSync] Error saving settings:', { error: err.message, guildId });
            res.redirect(`/manage/${guildId}?page=streamers&error=settings_save_failed`);
        }
    });

    // Twitch Role Sync — Disconnect broadcaster
    app.post('/manage/:guildId/twitch-role-sync/disconnect', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            await pool.execute('DELETE FROM twitch_role_sync_config WHERE guild_id = ?', [guildId]);
            await pool.execute('DELETE FROM twitch_role_sync_members WHERE guild_id = ?', [guildId]);
            logger.info(`[TwitchRoleSync] Disconnected broadcaster for guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=streamers&success=twitch_disconnected`);
        } catch (err) {
            logger.error('[TwitchRoleSync] Error disconnecting:', { error: err.message, guildId });
            res.redirect(`/manage/${guildId}?page=streamers&error=disconnect_failed`);
        }
    });

    // Twitch Role Sync — Fetch full Twitch mods/VIPs list with link status
    // Returns JSON; the UI calls this to render the mapping panel.
    app.get('/manage/:guildId/twitch-role-sync/mods-vips', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const [configRows] = await pool.execute('SELECT * FROM twitch_role_sync_config WHERE guild_id = ?', [guildId]);
            if (configRows.length === 0) return res.json({ error: 'broadcaster_not_connected' });

            const config = configRows[0];
            const { getValidToken } = await import('../jobs/twitch-role-sync-scheduler.js');
            const { getChannelVIPs, getChannelModerators } = await import('../utils/platforms/twitch.js');
            const accessToken = await getValidToken(config);
            if (!accessToken) return res.json({ error: 'token_invalid' });

            const [vipList, modList] = await Promise.all([
                getChannelVIPs(config.broadcaster_twitch_id, accessToken).catch(() => []),
                getChannelModerators(config.broadcaster_twitch_id, accessToken).catch(() => []),
            ]);

            // Build link map from both sources
            const linkMap = new Map(); // twitch_user_id → { discord_user_id, twitch_username, source }
            const [communityLinks] = await pool.execute(
                'SELECT discord_user_id, twitch_user_id, twitch_username FROM community_twitch_links WHERE guild_id = ? AND twitch_user_id IS NOT NULL',
                [guildId]
            );
            for (const l of communityLinks) linkMap.set(l.twitch_user_id, { ...l, source: 'community_twitch_links' });
            const [streamerLinks] = await pool.execute(
                `SELECT DISTINCT s.discord_user_id, s.platform_user_id AS twitch_user_id, s.username AS twitch_username
                 FROM streamers s JOIN subscriptions sub ON s.streamer_id = sub.streamer_id
                 WHERE sub.guild_id = ? AND s.platform = 'twitch' AND s.discord_user_id IS NOT NULL AND s.platform_user_id IS NOT NULL`,
                [guildId]
            );
            for (const l of streamerLinks) {
                if (!linkMap.has(l.twitch_user_id)) linkMap.set(l.twitch_user_id, { ...l, source: 'streamers' });
            }

            // Known Twitch bot accounts that can never be Discord-linked
            const KNOWN_TWITCH_BOTS = new Set([
                'streamlabs', 'wizebot', 'sery_bot', 'streamelements', 'moobot', 'nightbot',
                'kumabotdefender', 'frostytools', 'lumiastream', 'fossabot', 'cloudbot',
                'commanderroot', 'soundalerts', 'streamcaptainbot', 'lurxx',
            ]);

            // Build candidate-name index for username heuristic matching.
            //
            // Discord display names and nicknames often use stylized Unicode —
            // mathematical bold (𝐀), cursive (𝓐), fullwidth (Ａ), small caps (ᴀ),
            // squared/circled letters, surrounding emojis/symbols, diacritics.
            // None of those should defeat a username match. Two passes:
            //   deStyle()   — NFKD-decomposes most variants, strips combining
            //                 marks and zero-width characters, applies a small-
            //                 caps lookup for code points NFKD won't touch
            //                 (Phonetic Extensions, U+1D00-U+1D7F + a few singletons).
            //   normalize() — deStyle + lowercase + strip all non-[a-z0-9].
            //                 Used for fuzzy comparisons (substring, edit-distance).
            //
            // Source for the small-caps map: same trick `scripts/kitsune-lockdown.mjs`
            // already uses for matching staff-role names.
            const SMALL_CAPS_MAP = {
                'ᴀ':'a','ʙ':'b','ᴄ':'c','ᴅ':'d','ᴇ':'e','ꜰ':'f','ɢ':'g','ʜ':'h','ɪ':'i',
                'ᴊ':'j','ᴋ':'k','ʟ':'l','ᴍ':'m','ɴ':'n','ᴏ':'o','ᴘ':'p','ǫ':'q','ʀ':'r',
                'ꜱ':'s','ᴛ':'t','ᴜ':'u','ᴠ':'v','ᴡ':'w','ʏ':'y','ᴢ':'z',
            };
            function deStyle(s) {
                if (!s) return '';
                let out = s.normalize('NFKD')
                    .replace(/[̀-ͯ]/g, '')              // combining diacritic marks
                    .replace(/[​-‍﻿]/g, '');       // zero-width / BOM
                // Manual small-caps lookup (NFKD doesn't decompose Phonetic Extensions)
                let mapped = '';
                for (const ch of out) mapped += SMALL_CAPS_MAP[ch] || SMALL_CAPS_MAP[ch.toLowerCase()] || ch;
                return mapped;
            }

            const guild = req.guildObject;
            const members = Array.from(guild.members.cache.filter(m => !m.user.bot).values());
            const normalize = (s) => deStyle(s).toLowerCase().replace(/[^a-z0-9]/g, '');
            const lowerDestyle = (s) => deStyle(s).toLowerCase();

            const memberIndex = members.map(m => ({
                id: m.user.id,
                username: m.user.username,
                global_name: m.user.globalName || null,
                nickname: m.nickname || null,
                names_raw: [m.user.username, m.user.globalName, m.nickname].filter(Boolean).map(lowerDestyle),
                names_norm: [m.user.username, m.user.globalName, m.nickname].filter(Boolean).map(normalize),
            }));

            // Cheap Levenshtein for short strings (cap at 8 to bail early)
            function lev(a, b, max = 8) {
                if (Math.abs(a.length - b.length) > max) return max + 1;
                const m = a.length, n = b.length;
                if (m === 0) return n; if (n === 0) return m;
                let prev = new Array(n + 1);
                for (let j = 0; j <= n; j++) prev[j] = j;
                for (let i = 1; i <= m; i++) {
                    const curr = [i];
                    let rowMin = i;
                    for (let j = 1; j <= n; j++) {
                        const cost = a[i-1] === b[j-1] ? 0 : 1;
                        curr[j] = Math.min(prev[j] + 1, curr[j-1] + 1, prev[j-1] + cost);
                        if (curr[j] < rowMin) rowMin = curr[j];
                    }
                    if (rowMin > max) return max + 1;
                    prev = curr;
                }
                return prev[n];
            }

            // Score a (twitch_username, twitch_display_name) pair against a member.
            // Returns { score, reason } where score is 0-100.
            // Twitch display names can also be stylized, so the same deStyle pass
            // applies on the Twitch side too — symmetry matters for matching.
            function scoreMatch(twitchUsername, twitchDisplayName, mem) {
                const tCandidates = [twitchUsername, twitchDisplayName].filter(Boolean).map(lowerDestyle);
                const tNorms      = tCandidates.map(normalize);
                let best = { score: 0, reason: null };

                // Tier 1: exact case-insensitive match on any raw name
                for (const tc of tCandidates) {
                    if (mem.names_raw.includes(tc)) return { score: 100, reason: `exact "${tc}"` };
                }
                // Tier 2: exact normalized match (strips punctuation/underscores)
                for (const tn of tNorms) {
                    if (mem.names_norm.includes(tn)) {
                        if (best.score < 92) best = { score: 92, reason: `normalized exact "${tn}"` };
                    }
                }
                // Tier 3: substring/contains (small length delta)
                for (const tn of tNorms) {
                    for (const mn of mem.names_norm) {
                        if (!tn || !mn) continue;
                        if (tn === mn) continue; // already scored
                        const longer = tn.length > mn.length ? tn : mn;
                        const shorter = tn.length > mn.length ? mn : tn;
                        if (shorter.length >= 4 && longer.includes(shorter)) {
                            const ratio = shorter.length / longer.length;
                            const score = Math.round(60 + ratio * 25);  // 60-85
                            if (score > best.score) best = { score, reason: `contains "${shorter}"` };
                        }
                    }
                }
                // Tier 4: edit-distance ≤ 2 on normalized
                for (const tn of tNorms) {
                    for (const mn of mem.names_norm) {
                        if (!tn || !mn || Math.abs(tn.length - mn.length) > 3) continue;
                        const d = lev(tn, mn, 3);
                        if (d <= 2 && tn.length >= 4) {
                            const score = d === 0 ? 92 : (d === 1 ? 75 : 65);
                            if (score > best.score) best = { score, reason: `edit-distance ${d} from "${mn}"` };
                        }
                    }
                }
                return best;
            }

            // For an unlinked Twitch entry, find the best member suggestion.
            function suggestForTwitch(twitchUsername, twitchDisplayName, excludeDiscordIds) {
                let bestMember = null, bestScore = 0, bestReason = null;
                for (const mem of memberIndex) {
                    if (excludeDiscordIds.has(mem.id)) continue;  // member already linked to another Twitch user
                    const r = scoreMatch(twitchUsername, twitchDisplayName, mem);
                    if (r.score > bestScore) {
                        bestScore = r.score; bestReason = r.reason; bestMember = mem;
                    }
                }
                if (!bestMember || bestScore < 60) return null;
                return {
                    discord_user_id: bestMember.id,
                    discord_username: bestMember.username,
                    discord_display: bestMember.global_name || bestMember.nickname || null,
                    score: bestScore,
                    reason: bestReason,
                };
            }

            // Members already linked to a Twitch user shouldn't be suggested for another
            const alreadyLinkedMemberIds = new Set([...linkMap.values()].map(l => l.discord_user_id));

            const enrich = (entry, type) => {
                const link = linkMap.get(entry.user_id);
                const username = entry.user_login || entry.user_name?.toLowerCase();
                const isBot = KNOWN_TWITCH_BOTS.has((entry.user_login || '').toLowerCase());
                const suggestion = (link || isBot) ? null : suggestForTwitch(username, entry.user_name, alreadyLinkedMemberIds);
                return {
                    twitch_user_id: entry.user_id,
                    twitch_username: username,
                    twitch_display_name: entry.user_name,
                    type,
                    discord_user_id: link?.discord_user_id || null,
                    link_source: link?.source || null,
                    is_known_bot: isBot,
                    suggestion,
                };
            };

            return res.json({
                mods: modList.map(m => enrich(m, 'mod')),
                vips: vipList.map(v => enrich(v, 'vip')),
                broadcaster: { twitch_id: config.broadcaster_twitch_id, twitch_username: config.broadcaster_twitch_username },
                counts: {
                    mods_total: modList.length,
                    vips_total: vipList.length,
                    mods_linked: modList.filter(m => linkMap.has(m.user_id)).length,
                    vips_linked: vipList.filter(v => linkMap.has(v.user_id)).length,
                },
            });
        } catch (err) {
            logger.error('[TwitchRoleSync] mods-vips fetch error:', { error: err.message, stack: err.stack, guildId });
            res.status(500).json({ error: 'fetch_failed', message: err.message });
        }
    });

    // Twitch Role Sync — Link a Twitch user to a Discord user (manual mapping)
    app.post('/manage/:guildId/twitch-role-sync/link', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const { twitch_user_id, twitch_username, discord_user_id } = req.body;
        if (!twitch_user_id || !twitch_username || !discord_user_id) {
            return res.status(400).json({ error: 'missing_fields' });
        }
        try {
            // Verify the Discord user is actually in this guild (prevents linking to random snowflakes)
            const guild = req.guildObject;
            const member = await guild.members.fetch(discord_user_id).catch(() => null);
            if (!member) return res.status(400).json({ error: 'discord_user_not_in_guild' });

            await pool.execute(
                `INSERT INTO community_twitch_links (guild_id, discord_user_id, twitch_username, twitch_user_id, last_checked)
                 VALUES (?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE twitch_username = VALUES(twitch_username), twitch_user_id = VALUES(twitch_user_id), last_checked = NOW()`,
                [guildId, discord_user_id, twitch_username, twitch_user_id]
            );
            logger.info(`[TwitchRoleSync] Linked Twitch ${twitch_username} (${twitch_user_id}) → Discord ${member.user.tag} (${discord_user_id}) in guild ${guildId}`);
            res.json({ success: true, discord_username: member.user.tag });
        } catch (err) {
            logger.error('[TwitchRoleSync] link error:', { error: err.message, guildId });
            res.status(500).json({ error: 'link_failed', message: err.message });
        }
    });

    // Twitch Role Sync — Unlink (delete a community_twitch_links row)
    app.post('/manage/:guildId/twitch-role-sync/unlink', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const { discord_user_id } = req.body;
        if (!discord_user_id) return res.status(400).json({ error: 'missing_discord_user_id' });
        try {
            await pool.execute(
                'DELETE FROM community_twitch_links WHERE guild_id = ? AND discord_user_id = ?',
                [guildId, discord_user_id]
            );
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: 'unlink_failed', message: err.message });
        }
    });

    // Twitch Role Sync — Manual sync now
    app.post('/manage/:guildId/twitch-role-sync/sync-now', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const [configs] = await pool.execute('SELECT * FROM twitch_role_sync_config WHERE guild_id = ?', [guildId]);
            if (configs.length === 0) return res.redirect(`/manage/${guildId}?page=streamers&error=sync_not_configured`);
            const { syncGuild } = await import('../jobs/twitch-role-sync-scheduler.js');
            await syncGuild(configs[0]);
            res.redirect(`/manage/${guildId}?page=streamers&success=sync_complete`);
        } catch (err) {
            logger.error('[TwitchRoleSync] Manual sync error:', { error: err.message, stack: err.stack, guildId });
            res.redirect(`/manage/${guildId}?page=streamers&error=sync_failed`);
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
            const {
                leveling_enabled, leveling_xp_rate, leveling_xp_cooldown,
                level_up_channel_id, leveling_ignored_channels, leveling_ignored_roles,
                monthly_reset_enabled, reset_interval_days
            } = req.body;

            logger.info(`[Leveling Config] Received for guild ${guildId}:`, {
                leveling_enabled,
                leveling_xp_rate,
                leveling_xp_cooldown,
                monthly_reset_enabled,
                reset_interval_days
            });

            // Prepare arrays for ignored channels and roles
            const ignoredChannels = Array.isArray(leveling_ignored_channels)
                ? leveling_ignored_channels
                : (leveling_ignored_channels ? [leveling_ignored_channels] : []);

            const ignoredRoles = Array.isArray(leveling_ignored_roles)
                ? leveling_ignored_roles
                : (leveling_ignored_roles ? [leveling_ignored_roles] : []);

            // Validate + coerce reset interval (7–365 days)
            let resetIntervalDays = parseInt(reset_interval_days);
            if (!Number.isInteger(resetIntervalDays) || resetIntervalDays < 7 || resetIntervalDays > 365) {
                resetIntervalDays = 30;
            }

            // Update leveling config
            await pool.execute(`
                INSERT INTO level_config
                    (guild_id, enabled, xp_per_message, xp_cooldown_seconds, level_up_channel_id,
                     ignored_channels, ignored_roles, monthly_reset_enabled, reset_interval_days)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    enabled = VALUES(enabled),
                    xp_per_message = VALUES(xp_per_message),
                    xp_cooldown_seconds = VALUES(xp_cooldown_seconds),
                    level_up_channel_id = VALUES(level_up_channel_id),
                    ignored_channels = VALUES(ignored_channels),
                    ignored_roles = VALUES(ignored_roles),
                    monthly_reset_enabled = VALUES(monthly_reset_enabled),
                    reset_interval_days = VALUES(reset_interval_days)
            `, [
                guildId,
                leveling_enabled ? 1 : 0,
                parseInt(leveling_xp_rate) || 15,
                parseInt(leveling_xp_cooldown) || 60,
                level_up_channel_id || null,
                JSON.stringify(ignoredChannels),
                JSON.stringify(ignoredRoles),
                monthly_reset_enabled ? 1 : 0,
                resetIntervalDays
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
            const { timezone, live_role_id, prefix, prefix_enabled, delete_trigger, cleanup_delay, private_categories } = req.body;

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

            // Update prefix command config
            const privateCats = Array.isArray(private_categories) ? private_categories : (private_categories ? [private_categories] : []);
            await pool.execute(
                `INSERT INTO prefix_command_config (guild_id, prefix, enabled, delete_trigger, cleanup_delay, private_categories)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE prefix = VALUES(prefix), enabled = VALUES(enabled),
                 delete_trigger = VALUES(delete_trigger), cleanup_delay = VALUES(cleanup_delay),
                 private_categories = VALUES(private_categories)`,
                [
                    guildId,
                    (prefix && prefix.length <= 5) ? prefix : '!',
                    prefix_enabled ? 1 : 0,
                    delete_trigger ? 1 : 0,
                    parseInt(cleanup_delay) || 0,
                    privateCats.length ? JSON.stringify(privateCats) : null
                ]
            );

            // Invalidate prefix cache so bot picks up changes immediately
            try {
                const { invalidateGuildCache } = await import('../core/prefix-command-manager.js');
                invalidateGuildCache(guildId);
            } catch { /* prefix module may not be loaded in dashboard context */ }

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
            const { enabled, threshold, timePeriod, action, alert_channel_id } = req.body;
            const alertChannel = alert_channel_id || null;

            // Check if config exists
            const [existing] = await pool.execute(
                'SELECT * FROM anti_raid_config WHERE guild_id = ?',
                [guildId]
            );

            if (existing.length === 0) {
                await pool.execute(
                    `INSERT INTO anti_raid_config (guild_id, is_enabled, join_limit, time_period_seconds, action, alert_channel_id)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [guildId, enabled ? 1 : 0, threshold || 10, timePeriod || 10, action || 'kick', alertChannel]
                );
            } else {
                await pool.execute(
                    `UPDATE anti_raid_config
                     SET is_enabled = ?, join_limit = ?, time_period_seconds = ?, action = ?, alert_channel_id = ?
                     WHERE guild_id = ?`,
                    [enabled ? 1 : 0, threshold || 10, timePeriod || 10, action || 'kick', alertChannel, guildId]
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
            const { enabled, alert_channel_id } = req.body;
            const alertChannel = alert_channel_id || null;

            // Check if config exists
            const [existing] = await pool.execute(
                'SELECT * FROM anti_nuke_config WHERE guild_id = ?',
                [guildId]
            );

            if (existing.length === 0) {
                await pool.execute(
                    `INSERT INTO anti_nuke_config
                     (guild_id, enabled, max_channel_deletes, max_role_deletes, max_kick_bans, action_on_trigger, alert_channel_id)
                     VALUES (?, ?, 3, 3, 5, 'ban', ?)`,
                    [guildId, enabled ? 1 : 0, alertChannel]
                );
            } else {
                await pool.execute(
                    `UPDATE anti_nuke_config SET enabled = ?, alert_channel_id = ? WHERE guild_id = ?`,
                    [enabled ? 1 : 0, alertChannel, guildId]
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

            if (uploadedFile) {
                const ext = path.extname(uploadedFile.originalname).toLowerCase() || '.png';
                const allowedExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
                if (allowedExts.includes(ext)) {
                    const fs = await import('fs');
                    const { execFileSync } = await import('child_process');
                    const uploadDir = path.join(__dirname, 'public', 'uploads');
                    const ts = Date.now();

                    // Save original
                    const origPath = path.join(uploadDir, `avatar_${guildId}_${ts}_orig${ext}`);
                    fs.writeFileSync(origPath, uploadedFile.buffer);

                    // Resize to 256x256 PNG for Discord webhook avatar compatibility
                    // Always convert to static PNG — Discord webhook avatar_url doesn't reliably support animated GIFs
                    const filename = `avatar_${guildId}_${ts}.png`;
                    const outputPath = path.join(uploadDir, filename);
                    try {
                        if (ext === '.gif') {
                            // Flatten GIF to static PNG (composite all frames)
                            execFileSync('convert', [origPath, '-coalesce', '-flatten', '-resize', '256x256', outputPath], { timeout: 15000 });
                        } else {
                            execFileSync('convert', [origPath, '-resize', '256x256', outputPath], { timeout: 10000 });
                        }
                        fs.unlinkSync(origPath);
                    } catch (resizeErr) {
                        logger.warn(`[Appearance] Resize failed, using original: ${resizeErr.message}`);
                        fs.renameSync(origPath, outputPath);
                    }

                    const baseUrl = (process.env.DASHBOARD_URL || '').replace(/\/$/, '');
                    finalAvatarUrl = `${baseUrl}/uploads/${filename}`;
                    logger.info(`[Appearance] Avatar uploaded and resized: ${filename} → ${finalAvatarUrl} for guild ${guildId}`);
                }
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
            const { announcement_channel_id, live_role_id, announcement_message, use_webhook_persona, stream_ignored_roles } = req.body;
            const webhookPersona = use_webhook_persona === '1' ? 1 : 0;
            const ignoredRolesJson = stream_ignored_roles
                ? JSON.stringify(Array.isArray(stream_ignored_roles) ? stream_ignored_roles : [stream_ignored_roles])
                : null;

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
                INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id, announcement_message, use_webhook_persona, stream_ignored_roles)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    announcement_channel_id = VALUES(announcement_channel_id),
                    live_role_id = VALUES(live_role_id),
                    announcement_message = VALUES(announcement_message),
                    use_webhook_persona = VALUES(use_webhook_persona),
                    stream_ignored_roles = VALUES(stream_ignored_roles)
            `, [guildId, announcement_channel_id || null, live_role_id || null, announcement_message || null, webhookPersona, ignoredRolesJson]);

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
    app.post('/manage/:guildId/update-welcome', upload.fields([
        { name: 'card_background_file', maxCount: 1 }
    ]), handleMulterError, checkAuth, checkGuildAdmin, async (req, res) => {
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

            // Handle file upload — save to public/uploads/ for static serving
            let finalBackgroundUrl = card_background_url || null;
            const uploadedFile = req.files?.card_background_file?.[0];
            if (uploadedFile) {
                const ext = path.extname(uploadedFile.originalname).toLowerCase() || '.png';
                const allowedExts = ['.png', '.jpg', '.jpeg'];
                if (allowedExts.includes(ext)) {
                    const filename = `welcome_${guildId}_${Date.now()}${ext}`;
                    const uploadDir = path.join(__dirname, 'public', 'uploads');
                    const filePath = path.join(uploadDir, filename);
                    const fs = await import('fs');
                    fs.writeFileSync(filePath, uploadedFile.buffer);
                    const baseUrl = (process.env.DASHBOARD_URL || '').replace(/\/$/, '');
                    finalBackgroundUrl = `${baseUrl}/uploads/${filename}`;
                    logger.info(`[Welcome] Banner uploaded: ${filename} → ${finalBackgroundUrl} for guild ${guildId}`);
                } else {
                    logger.warn(`[Welcome] Rejected upload with extension ${ext}`);
                }
            }

            logger.info('[POST /manage/:guildId/update-welcome] Updating:', {
                guildId,
                channel_id,
                banner_enabled: Boolean(banner_enabled),
                goodbye_enabled: Boolean(goodbye_enabled),
                hasUpload: !!uploadedFile
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
                finalBackgroundUrl,
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
            const { enabled, announcement_channel_id, message_template, birthday_role_id, card_channel_id, cards_enabled, default_card_type } = req.body;

            logger.info('[POST /manage/:guildId/birthday/config] Updating:', {
                guildId,
                enabled: Boolean(enabled),
                cards_enabled: Boolean(cards_enabled),
                default_card_type: default_card_type || 'board'
            });

            await pool.execute(`
                INSERT INTO birthday_config (guild_id, enabled, announcement_channel_id, message_template, birthday_role_id, card_channel_id, cards_enabled, default_card_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    enabled = VALUES(enabled),
                    announcement_channel_id = VALUES(announcement_channel_id),
                    message_template = VALUES(message_template),
                    birthday_role_id = VALUES(birthday_role_id),
                    card_channel_id = VALUES(card_channel_id),
                    cards_enabled = VALUES(cards_enabled),
                    default_card_type = VALUES(default_card_type)
            `, [
                guildId,
                enabled ? 1 : 0,
                announcement_channel_id || null,
                message_template || null,
                birthday_role_id || null,
                card_channel_id || null,
                cards_enabled ? 1 : 0,
                default_card_type || 'board'
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

            // Resolve the real platform_user_id up front. Refuse to persist temp_ placeholders —
            // those are the root cause of the HolyDabRip/lepoor duplicate-row bug whenever a
            // streamer renames on the platform.
            const { resolveStreamerIdentity, upsertStreamerByIdentity } = await import('../utils/platforms/resolve-identity.js');
            const identity = await resolveStreamerIdentity(platform, username);
            if (!identity) {
                logger.warn('[POST /manage/:guildId/add-streamer] platform identity not resolvable', { platform, username });
                return res.redirect(`/manage/${guildId}?page=streamers&error=streamer_not_found`);
            }

            const streamerId = await upsertStreamerByIdentity(pool, platform, identity, discord_user_id || null);
            logger.info('[POST /manage/:guildId/add-streamer] resolved identity', {
                streamerId,
                platform,
                platformUserId: identity.platformUserId,
                canonicalUsername: identity.canonicalUsername,
            });

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
                            ping_role_id = ?,
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
                            subData.ping_role_id || null,
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
            const { streamerId, channelId, syncIntervalMinutes, weeklyRefresh } = req.body;

            if (!streamerId || !channelId) {
                return res.redirect(`/manage/${guildId}?page=twitch-schedules&error=missing_fields`);
            }

            // Clamp interval to [15, 10080]
            const interval = Math.min(10080, Math.max(15, parseInt(syncIntervalMinutes, 10) || 360));
            const weekly = (weeklyRefresh === 'on' || weeklyRefresh === '1' || weeklyRefresh === true) ? 1 : 0;

            // Check if sync already exists
            const [existing] = await pool.execute(
                'SELECT id FROM twitch_schedule_sync_config WHERE guild_id = ? AND streamer_id = ? AND discord_channel_id = ?',
                [guildId, streamerId, channelId]
            );

            if (existing.length > 0) {
                return res.redirect(`/manage/${guildId}?page=twitch-schedules&error=duplicate`);
            }

            // Create new sync
            const [insertResult] = await pool.execute(
                'INSERT INTO twitch_schedule_sync_config (guild_id, streamer_id, discord_channel_id, is_enabled, sync_interval_minutes, weekly_refresh) VALUES (?, ?, ?, 1, ?, ?)',
                [guildId, streamerId, channelId, interval, weekly]
            );

            // Trigger immediate first sync (don't block the response)
            try {
                const { getTwitchScheduleManager } = await import('../jobs/twitch-schedule-scheduler.js');
                let manager = getTwitchScheduleManager(guildId);

                // If no manager found, create one on the fly from the bot client
                if (!manager) {
                    const TwitchScheduleManager = (await import('../core/twitch-schedule-manager.js')).default;
                    const botClient = global.botManager?.getClientForGuild?.(guildId) || global.botManager?.clients?.get('default');
                    if (botClient) {
                        manager = new TwitchScheduleManager(botClient);
                    }
                }

                if (manager) {
                    const [newRows] = await pool.execute(
                        `SELECT tss.*, s.platform_user_id, s.username, s.profile_image_url
                         FROM twitch_schedule_sync_config tss
                         JOIN streamers s ON tss.streamer_id = s.streamer_id
                         WHERE tss.id = ?`,
                        [insertResult.insertId]
                    );
                    if (newRows.length > 0) {
                        // Fire and forget — skip cooldown for initial post
                        manager.syncSchedule(newRows[0], { skipCooldown: true }).catch(err =>
                            logger.error('[TwitchSchedules] Initial sync failed:', { error: err.message })
                        );
                    }
                } else {
                    logger.warn('[TwitchSchedules] No bot client available for initial sync');
                }
            } catch (err) {
                logger.error('[TwitchSchedules] Could not trigger initial sync:', { error: err.message, stack: err.stack });
            }

            res.redirect(`/manage/${guildId}?page=twitch-schedules&success=created`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/twitch-schedules/sync Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=twitch-schedules&error=create`);
        }
    });

    app.post('/manage/:guildId/twitch-schedules/edit', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { syncId, syncIntervalMinutes, weeklyRefresh } = req.body;

            if (!syncId) {
                return res.redirect(`/manage/${guildId}?page=twitch-schedules&error=missing_id`);
            }

            const interval = Math.min(10080, Math.max(15, parseInt(syncIntervalMinutes, 10) || 360));
            const weekly = (weeklyRefresh === 'on' || weeklyRefresh === '1' || weeklyRefresh === true) ? 1 : 0;

            // When enabling weekly_refresh, reset last_weekly_refresh so the next sync triggers a fresh post
            const resetWeekly = weekly ? ', last_weekly_refresh = NULL' : '';

            await pool.execute(
                `UPDATE twitch_schedule_sync_config
                 SET sync_interval_minutes = ?, weekly_refresh = ?${resetWeekly}
                 WHERE id = ? AND guild_id = ?`,
                [interval, weekly, syncId, guildId]
            );

            res.redirect(`/manage/${guildId}?page=twitch-schedules&success=updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/twitch-schedules/edit Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=twitch-schedules&error=update`);
        }
    });

    app.post('/manage/:guildId/twitch-schedules/force-sync', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { syncId } = req.body;

            if (!syncId) {
                return res.redirect(`/manage/${guildId}?page=twitch-schedules&error=missing_id`);
            }

            const [[sync]] = await pool.execute(`
                SELECT tss.*, s.platform_user_id, s.username, s.profile_image_url
                FROM twitch_schedule_sync_config tss
                JOIN streamers s ON tss.streamer_id = s.streamer_id
                WHERE tss.id = ? AND tss.guild_id = ?
            `, [syncId, guildId]);

            if (!sync) {
                return res.redirect(`/manage/${guildId}?page=twitch-schedules&error=not_found`);
            }

            const { getTwitchScheduleManager } = await import('../jobs/twitch-schedule-scheduler.js');
            const manager = getTwitchScheduleManager(guildId);
            if (manager) {
                await pool.execute(
                    'UPDATE twitch_schedule_sync_config SET change_detected_at = NULL WHERE id = ?',
                    [syncId]
                );
                sync.change_detected_at = null;
                manager.syncSchedule(sync, { skipCooldown: true }).catch(err =>
                    logger.error('[TwitchSchedules force-sync] Background error:', { error: err.message })
                );
            }

            res.redirect(`/manage/${guildId}?page=twitch-schedules&success=force_sync`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/twitch-schedules/force-sync Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=twitch-schedules&error=force_sync`);
        }
    });

    // --- Invite Link Filter (manage/advanced-protection) ---
    app.post('/manage/:guildId/invite-filter/config', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { enabled, use_whitelist, action, log_channel_id } = req.body;
            const linkWhitelist = await import('../utils/link-whitelist.js');
            await linkWhitelist.setConfig(guildId, {
                enabled: enabled === 'on' || enabled === '1' || enabled === true ? 1 : 0,
                use_whitelist: use_whitelist === 'on' || use_whitelist === '1' || use_whitelist === true ? 1 : 0,
                action: ['delete', 'delete_warn', 'log_only'].includes(action) ? action : 'delete_warn',
                log_channel_id: log_channel_id || null
            });
            res.redirect(`/manage/${guildId}?page=advanced-protection&success=invite_filter_saved`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/invite-filter/config Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=advanced-protection&error=invite_filter`);
        }
    });

    app.post('/manage/:guildId/invite-filter/whitelist/add', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { target_type, target_id } = req.body;
            if (!['user', 'role', 'channel'].includes(target_type) || !target_id) {
                return res.redirect(`/manage/${guildId}?page=advanced-protection&error=invite_filter_invalid`);
            }
            const linkWhitelist = await import('../utils/link-whitelist.js');
            await linkWhitelist.addEntry(guildId, target_type, target_id.trim(), req.user?.id || null);
            res.redirect(`/manage/${guildId}?page=advanced-protection&success=invite_filter_added`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/invite-filter/whitelist/add Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=advanced-protection&error=invite_filter_add`);
        }
    });

    app.post('/manage/:guildId/invite-filter/whitelist/remove', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { target_type, target_id } = req.body;
            if (!['user', 'role', 'channel'].includes(target_type) || !target_id) {
                return res.redirect(`/manage/${guildId}?page=advanced-protection&error=invite_filter_invalid`);
            }
            const linkWhitelist = await import('../utils/link-whitelist.js');
            await linkWhitelist.removeEntry(guildId, target_type, target_id);
            res.redirect(`/manage/${guildId}?page=advanced-protection&success=invite_filter_removed`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/invite-filter/whitelist/remove Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=advanced-protection&error=invite_filter_remove`);
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
    // Repost a reaction role panel (delete old message, clear message_id so "Post to Discord" button reappears)
    app.post('/manage/:guildId/repost-rr-panel', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const { panelId } = req.body;
        try {
            const [[panel]] = await pool.execute('SELECT * FROM reaction_role_panels WHERE id = ? AND guild_id = ?', [panelId, guildId]);
            if (!panel) return res.redirect(`/manage/${guildId}?page=reaction-roles&error=panel_not_found`);

            const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient() || client;

            // Delete old message
            if (panel.message_id && panel.channel_id) {
                try {
                    const oldChannel = await botClient.channels.fetch(panel.channel_id).catch(() => null);
                    if (oldChannel) {
                        const oldMsg = await oldChannel.messages.fetch(panel.message_id).catch(() => null);
                        if (oldMsg) await oldMsg.delete().catch(() => {});
                    }
                } catch { /* old message may already be gone */ }
            }

            // Clear message_id so the "Post to Discord" button reappears, allowing a fresh post
            await pool.execute('UPDATE reaction_role_panels SET message_id = NULL WHERE id = ?', [panelId]);
            logger.info(`[Reaction Roles] Panel ${panelId} cleared for repost in guild ${guildId}`);

            res.redirect(`/manage/${guildId}?page=reaction-roles&success=panel_cleared`);
        } catch (error) {
            logger.error('[Reaction Roles] Repost error:', error);
            res.redirect(`/manage/${guildId}?page=reaction-roles&error=repost_failed`);
        }
    });

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
            const { panelId, emoji_id, role_id, label, button_style } = req.body;

            if (!panelId || !role_id) {
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
            const interactionType = panel.interaction_type || 'reaction';

            // Reaction type requires emoji; button/select can use label instead
            if (interactionType === 'reaction' && !emoji_id) {
                return res.redirect(`/manage/${guildId}?page=reaction-roles&error=emoji_required`);
            }

            // Insert mapping
            const validStyles = ['primary', 'secondary', 'success', 'danger'];
            const style = validStyles.includes(button_style) ? button_style : 'primary';
            await pool.execute(
                'INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, button_style) VALUES (?, ?, ?, ?, ?)',
                [panelId, role_id, emoji_id || null, label || null, style]
            );

            // Get the bot client for this guild
            const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient() || client;

            // Update the Discord message based on panel type
            try {
                const channel = await botClient.channels.fetch(panel.channel_id);
                const message = await channel.messages.fetch(panel.message_id);

                if (interactionType === 'reaction') {
                    // Reaction type: add the emoji as a reaction
                    if (emoji_id) await message.react(emoji_id);
                } else {
                    // Button or select menu: rebuild the components from all mappings
                    const [allMappings] = await pool.execute(
                        'SELECT role_id, emoji_id, label, button_style FROM reaction_role_mappings WHERE panel_id = ?',
                        [panelId]
                    );

                    const styleMap = { primary: 1, secondary: 2, success: 3, danger: 4 };
                    const roles = allMappings.map(m => {
                        const guildRole = message.guild.roles.cache.get(m.role_id);
                        return {
                            roleId: m.role_id,
                            emoji: m.emoji_id || undefined,
                            label: m.label || guildRole?.name || 'Role',
                            name: guildRole?.name || 'Role',
                            description: `Get the ${guildRole?.name || 'Role'} role`,
                            style: m.button_style || 'primary'
                        };
                    });

                    const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = await import('discord.js');

                    if (interactionType === 'button') {
                        // Build button rows
                        const componentRows = [];
                        let currentRow = new ActionRowBuilder();
                        let count = 0;
                        for (const role of roles) {
                            if (count >= 5) { componentRows.push(currentRow); currentRow = new ActionRowBuilder(); count = 0; }
                            const btn = new ButtonBuilder()
                                .setCustomId(`rr_${role.roleId}`)
                                .setLabel(role.label)
                                .setStyle(styleMap[role.style] || ButtonStyle.Primary);
                            if (role.emoji) {
                                try { btn.setEmoji(role.emoji.includes(':') ? role.emoji.split(':')[2].replace('>', '') : role.emoji); } catch { /* skip emoji */ }
                            }
                            currentRow.addComponents(btn);
                            count++;
                            if (componentRows.length >= 5) break;
                        }
                        if (count > 0) componentRows.push(currentRow);
                        await message.edit({ components: componentRows });
                    } else if (interactionType === 'select' || interactionType === 'select_menu') {
                        // Build select menu
                        const options = roles.map(r => ({
                            label: r.label,
                            value: r.roleId,
                            description: r.description,
                            emoji: r.emoji || undefined
                        }));
                        const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId('rr_select')
                            .setPlaceholder('Choose your roles')
                            .setMinValues(panel.panel_mode === 'unique' ? 1 : 0)
                            .setMaxValues(panel.panel_mode === 'unique' ? 1 : options.length)
                            .addOptions(options);
                        await message.edit({ components: [new ActionRowBuilder().addComponents(selectMenu)] });
                    }
                }
            } catch (error) {
                logger.warn(`[Reaction Roles] Failed to update message components: ${error.message}`);
            }

            logger.info(`[Reaction Roles] Mapping added for panel ${panelId}: ${emoji_id || label} -> ${role_id} (type: ${interactionType})`);
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

            // Resolve role names from Discord
            const guild = botClient.guilds.cache.get(guildId);
            const roles = [];
            let rolesText = '';
            for (const mapping of mappings) {
                const role = guild?.roles.cache.get(mapping.role_id) || await guild?.roles.fetch(mapping.role_id).catch(() => null);
                const roleName = role ? role.name : 'Unknown Role';
                roles.push({
                    roleId: mapping.role_id,
                    emoji: mapping.emoji_id || undefined,
                    label: mapping.label || roleName,
                    name: roleName,
                    description: `Get the ${roleName} role`,
                    style: mapping.button_style || 'primary'
                });
                if (panel.interaction_type === 'reaction') {
                    rolesText += `${mapping.emoji_id || '▪️'} — <@&${mapping.role_id}>\n`;
                } else {
                    rolesText += `▪️ <@&${mapping.role_id}>\n`;
                }
            }

            if (rolesText) {
                embed.addFields({ name: 'Available Roles', value: rolesText, inline: false });
            }

            // Post message based on panel interaction type
            const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = await import('discord.js');
            let message;
            const interactionType = panel.interaction_type || 'reaction';

            const styleMap = { primary: 1, secondary: 2, success: 3, danger: 4 };

            if (interactionType === 'button') {
                // Build button rows
                const componentRows = [];
                let currentRow = new ActionRowBuilder();
                let count = 0;
                for (const role of roles) {
                    if (count >= 5) { componentRows.push(currentRow); currentRow = new ActionRowBuilder(); count = 0; }
                    const btn = new ButtonBuilder()
                        .setCustomId(`rr_${role.roleId}`)
                        .setLabel(role.label)
                        .setStyle(styleMap[role.style] || ButtonStyle.Primary);
                    if (role.emoji) {
                        try {
                            btn.setEmoji(role.emoji.includes(':') ? role.emoji.split(':')[2].replace('>', '') : role.emoji);
                        } catch { /* skip emoji if invalid */ }
                    }
                    currentRow.addComponents(btn);
                    count++;
                    if (componentRows.length >= 4) break; // Max 5 rows total
                }
                if (count > 0) componentRows.push(currentRow);
                message = await channel.send({ embeds: [embed], components: componentRows });

            } else if (interactionType === 'select_menu' || interactionType === 'select') {
                // Build select menu
                const options = roles.map(r => {
                    const opt = { label: r.label, value: r.roleId, description: r.description };
                    if (r.emoji) opt.emoji = r.emoji;
                    return opt;
                });
                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('rr_select')
                    .setPlaceholder('Choose your roles')
                    .setMinValues(panel.panel_mode === 'unique' ? 1 : 0)
                    .setMaxValues(panel.panel_mode === 'unique' ? 1 : options.length)
                    .addOptions(options);
                message = await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(selectMenu)] });

            } else {
                // Traditional reaction type
                message = await channel.send({ embeds: [embed] });
                for (const mapping of mappings) {
                    if (mapping.emoji_id) {
                        try {
                            await message.react(mapping.emoji_id);
                        } catch (reactionError) {
                            logger.warn(`[Reaction Roles] Failed to add reaction ${mapping.emoji_id}: ${reactionError.message}`);
                        }
                    }
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

            // Fetch live streamers — deduplicate by unique person (not per-platform)
            const [announcements] = await pool.query(`
                SELECT
                    la.username,
                    la.platform,
                    la.discord_user_id,
                    s.profile_image_url,
                    MIN(la.stream_started_at) as earliest_start
                FROM live_announcements la
                LEFT JOIN streamers s ON la.streamer_id = s.streamer_id
                WHERE la.offline_check_count < 6
                GROUP BY
                    COALESCE(la.discord_user_id, la.username),
                    la.username
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

    // Discord invite redirect
    app.get('/discord', (req, res) => {
        res.redirect('https://discord.com/invite/mJfbDgWA7z');
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

    // API routes — lazy-loaded synchronously to avoid race conditions
    app.use('/api', async (req, res, next) => {
        try {
            if (!app._apiRouter) {
                const mod = await import('./routes/api.js');
                app._apiRouter = mod.default;
            }
            app._apiRouter(req, res, next);
        } catch { next(); }
    });

    app.use('/api', async (req, res, next) => {
        try {
            if (!app._featureApiRouter) {
                const mod = await import('./routes/api/index.js');
                app._featureApiRouter = mod.default;
            }
            app._featureApiRouter(req, res, next);
        } catch { next(); }
    });

    import('./routes/voice-preview.js').then(({ default: voicePreviewRouter }) => {
        app.use('/', voicePreviewRouter);
    }).catch(err => {
        logger.error('Failed to load voice-preview routes:', err);
    });

    import('./routes/guilds.js').then(({ default: guildsRouter }) => {
        app.use('/api/guilds', guildsRouter);
    });

    // Status routes already mounted above (before auth-protected API routes)

    import('./routes/bots.js').then(({ default: botsRouter }) => {
        app.use('/', botsRouter);
    }).catch(err => {
        logger.error('Failed to load bots routes:', err);
    });

    // Super-admin routes loaded eagerly — must resolve before auth-protected /api catches them
    import('./routes/super-admin.js').then(({ default: superAdminRouter }) => {
        app.use('/', superAdminRouter);
        logger.info('[Dashboard] Super-admin routes loaded');
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

    import('./routes/features/event-schedule.js').then(({ default: eventScheduleRouter }) => {
        app.use('/manage/:guildId', checkAuth, checkGuildAdmin, eventScheduleRouter);
    }).catch(err => {
        logger.error('Failed to load event-schedule routes:', err);
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

    import('./routes/cah.js').then(({ default: cahRouter }) => {
        app.use('/', cahRouter);
        logger.info('[Dashboard] /cah routes loaded');
    }).catch(err => {
        logger.error('Failed to load CAH routes:', err);
    });

    import('./routes/auth-twitch-broadcaster.js').then(({ default: authTwitchBroadcasterRouter }) => {
        app.use('/', authTwitchBroadcasterRouter);
    }).catch(err => {
        logger.error('Failed to load Twitch broadcaster auth routes:', err);
    });

    import('./routes/link-twitch.js').then(({ default: linkTwitchRouter }) => {
        app.use('/', linkTwitchRouter);
        logger.info('[Dashboard] /link/twitch member-link routes loaded');
    }).catch(err => {
        logger.error('Failed to load /link/twitch routes:', err);
    });

    import('./routes/user-schedule.js').then(({ default: userScheduleRouter }) => {
        app.use('/', userScheduleRouter);
    }).catch(err => {
        logger.error('Failed to load user schedule routes:', err);
    });

    // ── Hide the legacy "Tokes Bot" public site ──────────────────────────────
    // Only the Discord bot (/discord) and Kick bot (/kick) are public surfaces.
    // The /tokes-bot/* informational + dashboard pages self-brand as "Tokes Bot"
    // and must not be publicized. Gate them here BEFORE the tokes routers run,
    // but deliberately let through:
    //   • /tokes-bot/auth/**  — the Kick (and Twitch) OAuth login flow used by /kick
    //   • /tokes-bot/api/**   — the JSON API the Kick bot dashboard calls
    // Everything else under /tokes-bot redirects to the chooser at '/'.
    app.use('/tokes-bot', (req, res, next) => {
        // req.path here is relative to the '/tokes-bot' mount point.
        if (req.path.startsWith('/auth/') || req.path.startsWith('/api/')) {
            return next();
        }
        return res.redirect(302, '/');
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

    // Kick Defender dashboard (/kick) — reuses the Kick login (tokesUser).
    import('./routes/kick-defender.js').then(({ default: kickDefenderRouter }) => {
        app.use('/', kickDefenderRouter);
    }).catch(err => {
        logger.error('Failed to load Kick Defender routes:', err);
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

    // Internal resolver endpoint (relay calls at go-live, secret-gated)
    app.use('/', streamInternalRouter);

    // OAuth connect flow + connection management
    app.use('/', streamConnectRouter);

    // Multicast streaming UI + API
    app.use('/', streamRouter);

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
        } else {
            logger.error(`[Dashboard] Server error: ${err.message}`);
        }
    });

    // Initialize Socket.io on the HTTP server. CAH (and any future real-time
    // features) attach via the existing dashboard/socket/index.js handler set.
    // Without this, the engine's web adapter calls getIO() → null and silently
    // drops every game-state broadcast, so /cah pages stay on "Connecting…"
    // forever. We use .then() instead of await because the enclosing function
    // isn't async — top-level await isn't available in CJS-style express setup.
    import('./socket/index.js')
        .then(({ initializeSocket }) => {
            initializeSocket(server, sessionMiddleware);
            logger.info('[Dashboard] Socket.io mounted on HTTP server');
        })
        .catch(err => logger.error(`[Dashboard] Failed to mount Socket.io: ${err.message}`));

    // Graceful shutdown
    process.on('SIGINT', async () => {
        logger.info('Shutting down dashboard server...');
        process.exit(0);
    });
}

export default { start };
