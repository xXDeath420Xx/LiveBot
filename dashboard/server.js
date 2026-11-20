import express from 'express';
import passport from 'passport';
import { Strategy as DiscordStrategy } from 'passport-discord';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../utils/db.js';
import { PHRASE_GROUPS as COMMISSION_GROUPS, getGlobalStats as getCommissionGlobalStats, SOFT_SELL_SIGNALS, invalidate as invalidateCommission } from '../core/commission-spam-filter.js';
import { SOCIAL_PLATFORMS, MEDIA_HOSTS, BLOCKED_HOSTS, MONETISATION_HOSTS, registrable as linkRegistrable } from '../core/link-policy.js';
import { invalidate as invalidateLinkPolicy } from '../core/link-filter.js';
import { liveConfigAccess } from '../core/protection-exempt.js';
import logger from '../utils/logger.js';
import configCache from '../utils/configCache.js';
import { getCatalog } from '../core/command-catalog.js';
import { PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fs from 'fs';
import multer from 'multer';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { ZONES as FOURTWENTY_ZONES } from '../utils/fourtwenty.js';
import { getInstalledVoices } from '../utils/piper-tts.js';
import { isSuperAdmin } from '../utils/constants.js';
import { csrfProtection, csrfToken } from '../utils/csrf-protection.js';
import { cfxProxy, attachCfxUpgrade, cfxDiscordSession } from '../services/certifried-extension/integration/dashboard-proxy.js';
import { oldGameRoutes } from '../services/cfx/integrations/cutover.js';
import greenhouseRouter from './routes/greenhouse.js';
import activitiesRouter from './routes/activities/index.js';
import { allLocaleMeta, localeMeta, isSupportedLocale, setLocale, getStoredLocale } from '../utils/i18n.js';
import { getTheme, setTheme, resetTheme, DEFAULT_THEME, THEME_SLOTS } from '../core/guild-theme.js';
import { serverAccentCss } from '../core/accent-tint.js';
import { LOG_ACTIONS, NOT_POSTED as LOG_NOT_POSTED, actionColorRows, defaultActionColors, planActionColorChanges, planDisabledActions, isOptInCategory } from '../core/log-actions.js';
import { invalidateLogActionColors, _invalidateModlogV2Cache } from '../core/log-manager.js';
import { logFeatureEvent, userLabel } from '../core/feature-log.js';
import {
    TYPES as FORM_QUESTION_TYPES,
    MODAL_FIELD_LIMIT as FORM_MODAL_FIELD_LIMIT,
    SELECT_OPTION_LIMIT as FORM_SELECT_OPTION_LIMIT,
    isValidType as isValidFormQuestionType,
    parseOptions as parseFormOptions,
    serialiseOptions as serialiseFormOptions
} from '../core/form-questions.js';
import {
    parseRecipients as parseDmRecipients,
    serialiseRecipients as serialiseDmRecipients,
    buildResponseEmbed as buildFormResponseEmbed,
    deliverToRecipients as deliverFormDm
} from '../core/form-dm.js';
import {
    loadFormWithQuestions,
    pushPanel as pushFormPanel,
    syncPanelsForForm
} from '../core/form-panel.js';
import {
    listTemplates as listReplyTemplates,
    getTemplate as getReplyTemplate,
    rankTemplates as rankReplyTemplates,
    sendReply as sendFormReply,
    renderBody as renderReplyBody,
    REPLY_BODY_LIMIT
} from '../core/form-reply.js';
import { catalogByCategory } from '../core/feature-flags.js';
import { getPreferences, setPreferences, togglePin, noteVisit, resolveSectionOrder, customThemeCss, THEMES, DENSITIES, LAYOUTS, SECTIONS, STYLES, normaliseStyle } from '../core/user-preferences.js';
import { validateCustomTheme, buildCustomTheme } from '../core/custom-theme.js';
import { parseVideoUrl } from '../utils/video-embed.js';
import { randomDropkick } from '../utils/dropkick-places.js';
import { createSessionMiddleware, sessionActivityMiddleware } from './config/session.js';
import ebookRecordRouter from './routes/ebook-record.js';
import fourthwallWebhookRouter from './routes/webhooks/fourthwall.js';
import kofiWebhookRouter from './routes/webhooks/kofi.js';
import kickWebhooksRouter from './routes/kick-webhooks.js';
import twitchEventSubRouter from './routes/webhooks/twitch-eventsub.js';
import throneWebhookRouter from './routes/webhooks/throne.js';
import discordWebhookEventsRouter from './routes/webhooks/discord-events.js';
import publicCheckurlRouter from './routes/public/checkurl.js';
import publicStatusRouter from './routes/public/status.js';
import publicScamsRouter from './routes/public/scams.js';
import publicCountdownRouter from './routes/public/countdown.js';
import streamRouter from './routes/stream.js';
import showcaseRouter from './routes/showcase.js';
import spritesRouter from './routes/sprites.js';
import steamLinkRouter from './routes/steam-link.js';
import musicHealthRouter from './routes/music-health.js';
import featureAdoptionRouter from './routes/feature-adoption.js';
import serviceKeysRouter from './routes/service-keys.js';
import commandUsageReportRouter from './routes/command-usage-report.js';
import streamInternalRouter from './routes/stream-internal.js';
import streamConnectRouter from './routes/stream-connect.js';
import twitchAnalyticsPageRouter from './routes/twitch-analytics-page.js';
import discordNativePageRouter from './routes/discord-native-page.js';
import { GUIDES, AREAS, getGuide, guideImage, inline as guideInline } from './content/guides/index.js';
import { createDocsSearch } from './services/docs-search.js';
import apiOverviewPageRouter from './routes/api-overview-page.js';
import { renderAuditBotPage, registerAuditBotRoutes } from './routes/audit-bot.js';
import { invalidateMusicConfigCache } from '../utils/music_helpers.js';
import encryption from '../utils/encryption.js';
import cookieParser from 'cookie-parser';
import { loadManageSection, parseOverrideId, overrideColumn } from './services/manage-sections.js';
import { manageTemplateFor } from './services/classic-style.js';
import { createViewEngine } from './services/view-engine.js';
import { watchReloadRequests } from './services/dashboard-reload.js';
import { pendingReason, sendReconnecting } from './services/bot-readiness.js';
import { invalidate as invalidateCommandRestriction } from '../core/command-restrictions.js';
import { MOUNTS, slashPath, isContainer } from '../core/command-mounts.js';
// Slash or text, and what to type, for the Commands page (slash/text split, 2026-11-18).
import { describePath as describeCommandPath } from '../core/universal-commands.js';
import { commandType } from '../core/command-registration.js';

dotenv.config();

/**
 * Get deduplicated server count from all bot clients
 * Used by both landing page and status API for consistency
 *
 * `customBotGuilds` is counted in its own Set rather than as "whatever the main
 * bot wasn't already in": the main bot is a member of most custom-bot guilds too,
 * so subtracting would report almost none of them. A guild counts as served by a
 * custom bot whenever any custom client is in it, main bot present or not.
 *
 * botManager.clients also holds the MAIN client, keyed by its defaultBotId — it is
 * a bot registry, not a custom-bot registry. Counting the map wholesale made every
 * guild look custom-branded (the landing page read "72 of 72"), so that one key is
 * skipped here.
 */
function getServerStats(mainClient) {
    const allGuildIds = new Set();
    const customGuildIds = new Set();
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
    const defaultBotId = global.botManager?.defaultBotId || 'default';
    if (global.botManager && global.botManager.clients) {
        for (const [botId, botClient] of global.botManager.clients.entries()) {
            const isCustom = botId !== defaultBotId;
            if (botClient && botClient.guilds && botClient.guilds.cache) {
                botClient.guilds.cache.forEach(guild => {
                    if (isCustom) customGuildIds.add(guild.id);
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

    return {
        guilds: allGuildIds.size,
        users: totalUsers,
        customBotGuilds: customGuildIds.size,
        customBots: Math.max(0, (global.botManager?.clients?.size || 0) - (global.botManager?.clients?.has(defaultBotId) ? 1 : 0))
    };
}

// Make getServerStats available globally for status route
global.getServerStats = getServerStats;

// Fonts a card signature may use. Kept next to the sanitizer so the allowlist and the
// validation that enforces it can never drift apart.
const CARD_SIGNATURE_FONTS = ['Helvetica Neue', 'Arial', 'Georgia', 'Courier New', 'Comic Sans MS', 'Impact', 'Trebuchet MS', 'Verdana', 'Palatino', 'Garamond', 'Bookman', 'Muli', 'Roboto', 'Inter', 'Quicksand', 'Pacifico', 'Dancing Script', 'Lobster', 'Caveat', 'Permanent Marker', 'Satisfy', 'Great Vibes', 'Sacramento', 'Architects Daughter', 'Indie Flower', 'Patrick Hand', 'Shadows Into Light', 'Amatic SC'];

/**
 * Sanitize the look-and-feel + media fields of a card signature.
 *
 * Signing and editing MUST agree on what is allowed, so both go through here: a value the
 * sign form accepts but the edit route silently drops is how a styled note turns plain the
 * first time its author fixes a typo.
 *
 * Every field is declarative — absent or empty means "clear it" — because the edit form
 * always submits the note's complete state.
 *
 * @param {object} body request body
 * @returns {object} column-name → sanitized value
 */
function sanitizeCardSignatureFields(body = {}) {
    const hex = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) ? v : null;

    // Only YouTube/Vimeo links become embeds; anything else is dropped rather than framed.
    // The poster falls back to the provider thumbnail so the card still shows something.
    const video = parseVideoUrl(body.video_url);
    const gifUrl = (typeof body.gif_url === 'string' && body.gif_url.trim())
        ? body.gif_url.trim().substring(0, 512)
        : null;

    const fontSize = parseInt(body.font_size, 10);
    const borderRadius = parseInt(body.card_border_radius, 10);

    return {
        gif_url: gifUrl || (video ? video.thumbnailUrl : null),
        video_url: video ? video.watchUrl : null,
        font_color: hex(body.font_color),
        font_family: CARD_SIGNATURE_FONTS.includes(body.font_family) ? body.font_family : null,
        font_size: (fontSize >= 10 && fontSize <= 28) ? fontSize : null,
        // Uploads only — an arbitrary URL here would let a note point <audio> anywhere.
        audio_url: (typeof body.audio_url === 'string' && body.audio_url.startsWith('/uploads/') && body.audio_url.length < 512) ? body.audio_url : null,
        card_bg_color: hex(body.card_bg_color),
        card_border_radius: [4, 8, 16, 24, 32].includes(borderRadius) ? borderRadius : null,
        card_border_color: hex(body.card_border_color),
        card_shadow: ['none', 'light', 'medium', 'dramatic'].includes(body.card_shadow) ? body.card_shadow : null,
        note_effect: ['hearts', 'confetti', 'stars', 'sparkles'].includes(body.note_effect) ? body.note_effect : null,
    };
}

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
                // Card signatures can embed a video player; nothing else may be framed
                frameSrc: ["https://www.youtube-nocookie.com", "https://www.youtube.com", "https://player.vimeo.com"],
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

    // CertiFried Tycoon (H-411): /game and /cfx/{api,dist,health} are forwarded to the game server on
    // 127.0.0.1:CFX_PORT. Mounted before the session, rate limiter and body parsers so bodies stream
    // through untouched, the dashboard cookie never reaches the game, and the game's own JWT auth and
    // per-player rate limit apply. /cfx/session/discord is a dashboard route (after passport).
    // Once Greenhouse Tycoon is live (GREENHOUSE_LIVE=1, phase 5) oldGameRoutes answers /game and everything under
    // /game, /cfx and /cfx-api first: pages 301 to /greenhouse, API calls 410. Without the flag it only calls next().
    app.use(oldGameRoutes());
    app.use(cfxProxy());

    // Discord Activities (Watch Together, Greenhouse Tycoon in Discord; docs/activities.md). Before the site's per-IP
    // limiter, session and CSRF check: the Activity has no cookies, sends a bearer token, and everyone in it arrives
    // from Discord's proxy addresses. The router sets its own CSP and rate limits.
    app.use('/activity', activitiesRouter());

    // Global rate limiter - 200 requests per minute per IP (pages only)
    const globalLimiter = rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 200,
        message: { error: 'Too many requests, please try again later' },
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: getClientIp,
        skip: (req) => {
            // Skip static assets and API routes (API has its own dedicated limiter).
            // /sprites is a public showcase — auth endpoints under /sprites/auth and
            // /sprites/resync still get individually rate-limited by other layers
            // (Epic side), and the /auth-prefixed authLimiter above covers actual
            // login mutation paths. Throttling /sprites/u/<slug> here just blocks
            // friendly profile views.
            return req.path.startsWith('/css') ||
                   req.path.startsWith('/js') ||
                   req.path.startsWith('/images') ||
                   req.path.startsWith('/ebook') ||
                   req.path.startsWith('/api') ||
                   req.path.startsWith('/sprites') ||
                   // 4:20 OBS overlay: static, no DB, and a 429 would render as
                   // raw JSON on someone's live stream.
                   req.path === '/420' || req.path === '/420-clock';
        }
    });
    app.use(globalLimiter);

    // Stricter rate limiter for auth endpoints - 60 requests per 15 minutes
    // (bumped from 10; OAuth debugging burns the lower cap easily and the
    // real credential-stuffing surface is Discord passport which has its own
    // provider-side throttle anyway.)
    const authLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 60,
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

    // CertiFried Tycoon: game tokens for the logged-in Discord user (the website's "Continue with Discord")
    app.get('/cfx/session/discord', cfxDiscordSession());
    // /game/* reaches the dashboard publicly; /cfx/* is sent to the game server by the front server (H-628).
    app.get('/game/session/discord', cfxDiscordSession());
    // Greenhouse Tycoon (v2 game, phase 3): /greenhouse page + assets and the Discord hand-off
    // /greenhouse/session/discord (dashboard/routes/greenhouse.js). The game API is /gh-api/ (its own process).
    app.use(greenhouseRouter());

    // ── Server log: dashboard actions (the 'http' category) ──────────────────────────────────────────
    // After a successful, authorised change under /manage/:guildId or /api/guilds/:guildId, note what was
    // changed and post ONE summary per (server, user, kind) a minute later — form autosaves fire every few
    // hundred ms. Only the route is recorded, never request bodies (they carry bot tokens, webhook URLs…).
    // Routes with their own log category (backups, Twitch schedules, OwO admin) and non-mutating helpers
    // (previews, tests, uploads, scans) are skipped.
    const DASHBOARD_ACTION_PATH = /^\/(?:manage|api\/guilds)\/(\d{17,20})(\/[^?#]*)?/;
    const DASHBOARD_ACTION_SKIP = /\/(backups?|twitch-schedules|owo)(\/|$)|\/(preview|test|test-dm|scan[\w-]*|upload[\w-]*)(\/|$)/i;
    const dashboardActionBuffer = new Map(); // `${guildId}:${userId}:${kind}` -> { guild, user, kind, items: Map<label, count>, timer }
    const describeDashboardRoute = (subPath) => (subPath || '/')
        .split('/').filter(seg => seg && !/^\d+$/.test(seg) && !/^[0-9a-f-]{20,}$/i.test(seg))
        .map(seg => decodeURIComponent(seg).replace(/[-_]+/g, ' '))
        .join(' › ') || 'settings';
    const managesGuild = (user, guildId) => {
        const entry = (user?.guilds || []).find(g => g.id === guildId);
        if (!entry) return false;
        try { return entry.owner || (BigInt(entry.permissions || 0) & 0x28n) !== 0n; } catch { return !!entry.owner; } // ADMINISTRATOR | MANAGE_GUILD
    };
    const flushDashboardActions = (key) => {
        const batch = dashboardActionBuffer.get(key);
        dashboardActionBuffer.delete(key);
        if (!batch) return;
        const lines = [...batch.items].map(([label, count]) => `• ${label}${count > 1 ? ` ×${count}` : ''}`);
        void logFeatureEvent(() => (batch.guild), () => (batch.kind === 'staff' ? 'http.staffAction'
            : batch.kind === 'deleted' ? 'http.itemDeleted' : 'http.settingsChanged'), () => ({
            title: batch.kind === 'staff' ? '🛡️ Staff Dashboard Action'
                : batch.kind === 'deleted' ? '🗑️ Removed via Dashboard' : '🖥️ Dashboard Settings Changed',
            description: lines.join('\n'),
            fields: [['By', userLabel(batch.user)], ['Where', 'Web dashboard']],
        }));
    };
    app.use((req, res, next) => {
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
        const match = req.originalUrl.match(DASHBOARD_ACTION_PATH);
        if (!match || DASHBOARD_ACTION_SKIP.test(match[2] || '')) return next();
        res.on('finish', () => {
            try {
                const guild = req.guildObject; // set only once the admin check passed
                if (!guild || guild.id !== match[1] || !req.user?.id) return;
                const status = res.statusCode;
                const ok = (status >= 200 && status < 300)
                    || (status >= 300 && status < 400 && !/[?&]error=/.test(res.get('Location') || ''));
                if (!ok) return;
                const label = describeDashboardRoute(match[2]);
                const kind = req.isSuperAdmin && !managesGuild(req.user, guild.id) ? 'staff'
                    : (req.method === 'DELETE' || /(^|\W)(delete|remove)/i.test(label)) ? 'deleted' : 'settings';
                const key = `${guild.id}:${req.user.id}:${kind}`;
                let batch = dashboardActionBuffer.get(key);
                if (!batch) {
                    batch = { guild, user: { id: req.user.id, username: req.user.username }, kind, items: new Map() };
                    batch.timer = setTimeout(() => flushDashboardActions(key), 60_000);
                    batch.timer.unref?.();
                    dashboardActionBuffer.set(key, batch);
                }
                batch.items.set(label, (batch.items.get(label) || 0) + 1);
            } catch (error) {
                logger.debug(`[Dashboard actions log] ${error.message}`);
            }
        });
        next();
    });

    // Fourthwall webhook receiver — mounted BEFORE body parser to preserve raw body for HMAC verify
    app.use('/webhooks/fourthwall', fourthwallWebhookRouter);

    // Kick event webhooks — same pre-body-parser mount (RSA signature over raw bytes)
    app.use('/kick/webhooks', kickWebhooksRouter);

    // Twitch EventSub — instant go-live push. Pre-body-parser: Twitch's HMAC signs the raw bytes.
    app.use('/webhooks/twitch/eventsub', twitchEventSubRouter);

    // Throne webhook probe/receiver — pre-body-parser so we can HMAC-verify the raw bytes once
    // we observe Throne's signature header shape and promote subscriptions to purpose=production.
    app.use('/webhooks/throne', throneWebhookRouter);

    // Discord outgoing webhook events (APPLICATION_AUTHORIZED, ENTITLEMENT_CREATE, QUEST_USER_ENROLLMENT).
    // Pre-body-parser mount: Discord signs the raw bytes with Ed25519. The handler verifies the
    // signature itself and ACKs within <3s; see dashboard/routes/webhooks/discord-events.js.
    app.use('/webhooks/discord/events', discordWebhookEventsRouter);

    // Public unauthenticated threat intel — mounted before auth middleware so it stays open.
    // Rate-limited at 30/min per IP in the router itself.
    app.use('/api/public', publicCheckurlRouter);

    // Public status: JSON at /api/status/public/overview, HTML at /api/status/public/page.
    // Expose a short public URL `/status` that redirects to the HTML page.
    app.use('/api/status/public', publicStatusRouter);
    // /status itself is the site page further down (status-tailwind.ejs), which reads the same
    // overview JSON; a redirect here used to shadow it, so the site's Status link left the site.

    // Public scam-domain lookup: JSON at /api/public/scams/lookup, HTML at /api/public/scams/page.
    app.use('/api/public/scams', publicScamsRouter);
    app.get('/scams', (_req, res) => res.redirect(302, '/api/public/scams/page'));

    // Public pricing page — HTML only, no billing flow yet. Ko-fi handles Supporter tier.
    // Nothing is sold (owner rule): the old tier page is retired; donations are voluntary.
    app.get('/pricing', (_req, res) => res.redirect(301, '/donate'));

    // Public holiday countdown pages — /countdown/:slug (HTML, OG unfurl), .png, .json.
    // Mounted at '/' because the router owns the full /countdown/* path prefix.
    app.use('/', publicCountdownRouter);

    // Ko-fi webhook receiver — form-urlencoded, parsed by the router itself. No signature
    // header exists; auth is the URL token + the verification_token inside the payload.
    app.use('/webhooks/kofi', kofiWebhookRouter);

    // Creator Showcase — public tokenized HLS player + segment serving (no session auth;
    // access is gated by the per-playback signed token, not login).
    app.use('/', showcaseRouter);

    // Fortnite Sprite Tracker — public; users connect their own Epic account (no Discord
    // login). Epic session lives in req.session.epicAccountId; images served from public/sprites/img.
    app.use('/sprites', spritesRouter);

    // Steam library tally — Steam OpenID sign-in (needs the Discord session, so after passport)
    // and the public, frameable /steam-library/<token> list. Admin API is under /api/guilds.
    app.use('/', steamLinkRouter);

    // StreamElements' $(customapi) prints whatever the endpoint returns straight into chat,
    // so the chat-action counters must never answer with the limiter's JSON error. They get
    // their own, looser limiter that replies in plain text — see the routes below.
    const CHAT_ACTION_PATHS = ['/api/hug', '/api/dropkick'];
    const chatActionLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 300, // chat-triggered, and StreamElements calls arrive from shared SE egress IPs
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: getClientIp,
        // Still has to read like the command it belongs to — a bare "0" would land
        // mid-sentence in chat.
        handler: (req, res) => res.type('text').send(
            req.originalUrl.startsWith('/api/dropkick') ? `${randomDropkick()}!` : '0'),
    });
    for (const p of CHAT_ACTION_PATHS) app.use(p, chatActionLimiter);

    // Apply API rate limiter after passport so req.user is available for admin bypass
    app.use('/api', (req, res, next) =>
        (CHAT_ACTION_PATHS.includes(`/api${req.path}`) ? next() : apiLimiter(req, res, next)));
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
            '/webhooks/kofi',
            '/webhooks/twitch/eventsub',
            '/webhooks/discord/events',
            '/manage',
            '/card',
            '/cards',
            '/supporters',
            '/api/public/stream-team', // public anonymous signup — protected by honeypot + rate-limit + Twitch-resolve gate, not session CSRF
            // Capability URL, no session. CSRF defends against a third-party page abusing a
            // credential the browser attaches AMBIENTLY (a cookie). These carry no cookie and no
            // session — the only credential is the 256-bit token in the path, which an attacking
            // page has no way to obtain. If it somehow had it, it could POST directly and a CSRF
            // token would change nothing. The real gates here are the unguessable token, a strict
            // key/value whitelist, and a rate limit. See routes/kabster.js.
            '/owner',
            '/kabster',
            // CertiFried Studio pairing (no session, no cookie): a 10-minute single-use code is the credential,
            // with per-IP and global rate limits (dashboard/routes/stream-bot.js, core/stream-bot/pairing.js).
            '/stream/bot/api/pair',
            // "Sign in with CertiFried" from Studio (no session): a request id plus a 256-bit polling secret only the
            // app holds; rate limited per IP (dashboard/routes/stream-bot-link.js). Approve itself is NOT exempt.
            '/stream/bot/api/link/request',
            '/stream/bot/api/link/poll',
            // Song requests' OBS browser source (no session): the per-profile music key in the path is the credential,
            // reports only move the player it is already playing; audio links are signed and short-lived
            // (dashboard/routes/stream-bot-music.js, core/stream-bot/music/audio.js).
            '/stream/bot/overlay/music/',
            // Stream bot overlays (no session, no cookie): the overlay key in the path is the credential; the only POST is
            // the page acknowledging an overlay action it was sent (dashboard/routes/stream-bot-overlays.js).
            '/stream/bot/overlay/alerts/',
            '/stream/bot/overlay/chat/',
            '/stream/bot/overlay/events/',
            '/stream/bot/overlay/goal/',
            '/stream/bot/overlay/counter/',
            '/stream/bot/overlay/nowplaying/',
            '/stream/bot/overlay/canvas/',
            '/stream/bot/overlay/scene/',
            // OBS docks (no session, no cookie): the credential is the dock key in the X-Dock-Key header, scoped to read
            // the feed and run an automation, rate limited per key and IP (dashboard/routes/stream-bot-dock.js).
            '/stream/bot/dock/api/run',
        ]
    }));

    // Make CSRF token available to all templates
    app.use(csrfToken);

    // -----------------------------------------------------------------------
    // UI preferences for every template.
    //
    // Set on res.locals rather than passed per-render: there are 75 views and
    // ~40 res.render calls, and threading a prop through all of them would
    // guarantee some get missed — which is exactly how the theme picker ended
    // up writing to localStorage and affecting nothing.
    //
    // Rendered server-side onto <html> so there is no flash of the wrong theme.
    // Unauthenticated pages fall back to the anti-flash inline script, which
    // reads the same value from localStorage before first paint.
    // -----------------------------------------------------------------------
    app.use(async (req, res, next) => {
        res.locals.uiTheme = 'dark';
        res.locals.uiDensity = 'comfortable';
        res.locals.uiLayout = 'grid';
        res.locals.uiStyle = 'cards';

        if (req.user?.id) {
            try {
                const prefs = await getPreferences(req.user.id);
                res.locals.uiTheme = prefs.theme || 'dark';
                res.locals.uiDensity = prefs.density || 'comfortable';
                res.locals.uiLayout = prefs.dashboardLayout || 'grid';
                res.locals.uiStyle = prefs.siteStyle || 'cards';
                res.locals.userPrefs = prefs;
                // Generated from validated token data, never from user-supplied
                // CSS — see core/custom-theme.js for why that distinction matters.
                res.locals.uiCustomCss = customThemeCss(prefs);
                res.locals.uiSectionOrder = resolveSectionOrder(prefs);
            } catch (error) {
                // Defaults are a working answer; never fail a page over a preference.
                logger.debug(`[UI] preference load failed: ${error.message}`);
            }

            // ?style=<name> previews a site style for this one page view without saving it
            // (the "Preview" links on the Settings page). Only a known style value is used.
            const previewStyle = normaliseStyle(req.query?.style);
            if (previewStyle) {
                res.locals.uiStylePreview = previewStyle !== res.locals.uiStyle ? previewStyle : null;
                res.locals.uiStyle = previewStyle;
            }

            // Vault membership for nav display. Set HERE rather than in checkAuth because the
            // -tailwind pages carry their own inline navbars and several of them render from
            // routes that never touch checkAuth. Display only — every /vault route re-checks
            // the allowlist itself and never trusts this flag.
            try {
                const [vaultRows] = await pool.execute(
                    'SELECT 1 FROM vault_members WHERE user_id = ?', [req.user.id]);
                req.user.isVaultMember = vaultRows.length > 0;
            } catch (error) {
                req.user.isVaultMember = false;
            }

            // Site header (views/partials/site-header.ejs): the signed-in user for pages whose
            // route passes no Discord user, and the Owner console link. Display only — the owner
            // routes check isSuperAdmin themselves.
            req.user.isSuperAdmin = isSuperAdmin(req.user.id);
            res.locals.siteUser = req.user;
        }
        // Where "Log in" in the site header comes back to.
        if (req.method === 'GET') res.locals.sitePath = req.originalUrl;
        next();
    });

    // Global request logger for debugging (only logs at debug level)
    app.use((req, res, next) => {
        if (req.method === 'POST') {
            logger.debug('[Dashboard POST]', { method: req.method, path: req.path, bodyKeys: Object.keys(req.body || {}) });
        }
        next();
    });

    // Many /manage/:guildId/* routes are fetch()-driven JSON endpoints rather than
    // page loads. Rendering an HTML error page into a fetch() surfaces to the
    // caller as a silent no-op, so negotiate the denial format off the request.
    // Matches the req.accepts() style already used by the handlers further down.
    const wantsJson = (req) =>
        req.xhr ||
        Boolean(req.is('application/json')) ||
        req.accepts(['html', 'json']) === 'json';

    const denyAccess = (req, res, status, message) => {
        if (wantsJson(req)) return res.status(status).json({ error: message });
        return res.status(status).render('error-tailwind', { user: req.user, error: message });
    };

    // Middleware
    const checkAuth = async (req, res, next) => {
        if (req.isAuthenticated()) {
            // The /manage/:guildId namespace is gated wholesale further down, and
            // most routes underneath it also carry checkAuth at their own mount.
            // Without this short-circuit that double-application costs a second
            // bot_creator_permissions query on every admin request.
            if (req._checkAuthDone) return next();
            req._checkAuthDone = true;

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
        // A fetch() that follows a 302 to the Discord OAuth page gets an opaque
        // HTML body and no usable error, so the dashboard JS surfaces nothing.
        // Give XHR/JSON callers a status they can branch on.
        if (wantsJson(req)) {
            return res.status(401).json({ error: 'Not authenticated', loginUrl: '/auth/discord' });
        }
        res.redirect('/auth/discord');
    };

    // No bot has this guild in cache. Right after a restart that usually means its bot has not
    // logged back in yet: answer "Reconnecting to Discord" (503, the page re-checks every 5 s and
    // shows `message` itself after ~2 min) instead of a 403 (services/bot-readiness.js).
    const notInGuild = (req, res, message) => {
        const pending = pendingReason(req.params.guildId, { fallbackClient: client });
        if (pending) return sendReconnecting(req, res, pending, message);
        return denyAccess(req, res, 403, message);
    };

    const checkGuildAdmin = (req, res, next) => {
        try {
            // Same reasoning as checkAuth: the namespace guard and the per-mount
            // middleware both run for most requests. Resolving the guild twice is
            // wasted cache lookups, and re-running the permission check against an
            // already-resolved guild can only produce the same answer.
            if (req.guildObject && req._checkGuildAdminFor === req.params.guildId) return next();

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

                // Auxiliary bots (core/bot-manager.js auxClients, e.g. the audit bot) are not
                // regular clients. Their servers are reachable for super-admins only, and only on
                // their own page (dashboard/routes/audit-bot.js): every other feature page would
                // edit settings no running bot reads there.
                let auxBot = null;
                if (!guildObject && global.botManager?.getAuxiliaryForGuild) {
                    auxBot = global.botManager.getAuxiliaryForGuild(req.params.guildId);
                    guildObject = auxBot?.client.guilds.cache.get(req.params.guildId) || null;
                }

                if (!guildObject) {
                    return notInGuild(req, res, 'The bot is not in this server.');
                }

                if (auxBot) {
                    const base = `/manage/${req.params.guildId}`;
                    const path = (req.originalUrl || '').split('?')[0].replace(/\/+$/, '');
                    const allowed = (req.method === 'GET' && path === base) || path.startsWith(`${base}/${auxBot.page}/`);
                    if (!allowed) {
                        if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') return res.redirect(base);
                        return res.status(404).json({ error: 'not_available', message: `This server is run by the ${auxBot.label}, which does not run this feature.` });
                    }
                    req.auxBot = auxBot;
                }

                req.guildObject = guildObject;
                req._checkGuildAdminFor = req.params.guildId;
                req.isSuperAdmin = true;
                logger.info(`[Dashboard] Super-admin ${req.user.username} accessing guild ${guildObject.name} (${req.params.guildId})`);
                return next();
            }

            // Regular user permission check
            const guild = req.user.guilds.find(g => g.id === req.params.guildId);
            const hasManageGuild = !!guild && new PermissionsBitField(BigInt(guild.permissions)).has(PermissionsBitField.Flags.ManageGuild);

            // Check if ANY bot is in this guild
            let guildObject = null;
            if (global.botManager) {
                const botClient = global.botManager.getClientForGuild(req.params.guildId);
                guildObject = botClient?.guilds.cache.get(req.params.guildId);
            } else {
                guildObject = client.guilds.cache.get(req.params.guildId);
            }

            if (!hasManageGuild) {
                // Bot-manager roles (core/protection-exempt.js): no Manage Server in the login-time
                // OAuth bitfield, but a role this server's owner/admins made a bot manager. Checked
                // LIVE against the member of THIS guild only — never any other guild.
                if (!guildObject) return notInGuild(req, res, 'You do not have permissions for this server.');
                return liveConfigAccess(guildObject, req.user.id).then(access => {
                    if (!access.ok) return denyAccess(req, res, 403, 'You do not have permissions for this server.');
                    req.guildObject = guildObject;
                    req._checkGuildAdminFor = req.params.guildId;
                    req.isBotManager = access.viaManager;
                    return next();
                }).catch(e => {
                    logger.error('[checkGuildAdmin manager check Error]', e);
                    denyAccess(req, res, 500, 'An unexpected error occurred while checking permissions.');
                });
            }

            if (!guildObject) {
                return notInGuild(req, res, 'The bot is not in this server.');
            }

            req.guildObject = guildObject;
            req._checkGuildAdminFor = req.params.guildId;
            return next();
        } catch (e) {
            logger.error('[checkGuildAdmin Error]', e);
            denyAccess(req, res, 500, 'An unexpected error occurred while checking permissions.');
        }
    };

    // Serve static files
    app.use(express.static(path.join(__dirname, 'public')));

    // Ticket transcripts (H-654). These were served as public static files at guessable addresses
    // (transcript-<ticket id>-<guild id>.html). Now they need a login, and the viewer must be the member who
    // opened the ticket or an admin of that server. Only that exact file name pattern is served.
    const TRANSCRIPT_DIR = path.join(__dirname, '..', 'transcripts');
    app.get('/transcripts/:file', checkAuth, async (req, res, next) => {
        const m = String(req.params.file || '').match(/^transcript-(\d{1,12})-(\d{17,20})\.html$/);
        if (!m) return next();
        const [, ticketId, guildId] = m;
        const file = path.join(TRANSCRIPT_DIR, `transcript-${ticketId}-${guildId}.html`);
        if (!fs.existsSync(file)) return next();
        const send = () => {
            res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
            res.sendFile(file);
        };
        try {
            const [rows] = await pool.query('SELECT user_id FROM tickets WHERE id = ? AND guild_id = ? LIMIT 1', [ticketId, guildId]);
            if (rows[0] && String(rows[0].user_id) === String(req.user.id)) return send();
        } catch (err) {
            logger.warn(`[transcripts] opener lookup failed: ${err.message}`);
        }
        req.params.guildId = guildId;
        return checkGuildAdmin(req, res, send);
    });

    // View engine (services/view-engine.js): include() resolves caller-relative first, then from
    // views/; the Classic manage page's includes get their original CSS back (classicCss).
    // Compiled templates are cached until a reload request (scripts/reload-dashboard.mjs), which
    // also re-hashes the ?v= on local css/js links, so views/public changes go live without a
    // restart. Express's own view-path cache is cleared with it.
    const viewsDir = path.join(__dirname, 'views');
    const views = createViewEngine({ viewsDir, publicDir: path.join(__dirname, 'public') });
    app.engine('ejs', views.engine);
    watchReloadRequests({
        logger,
        onReload: () => {
            for (const key of Object.keys(app.cache || {})) delete app.cache[key];
            return views.reload();
        },
    });
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    // Ebook recording upload (no auth required, large file support)
    app.use('/api/ebook', ebookRecordRouter);

    // ─── StreamElements chat-action counters (public, no auth) ──────────────────
    //
    // One endpoint per action, e.g. GET /api/hug?c=<channel>&u=<target>. Each call
    // increments and returns the new per-channel total for that user.
    //
    //   !hug      $(sender) just ran up to $(touser) and hugged the everloving life out of
    //             them! This user has been hugged a total of
    //             $(customapi https://certifriedmultitool.com/api/hug?c=${channel}&u=${queryescape ${touser}})
    //             times in this channel
    //
    //   !dropkick $(sender) just dropkicked $(touser)'s ass
    //             $(customapi https://certifriedmultitool.com/api/dropkick?c=${channel}&u=${queryescape ${touser}})
    //
    // Whatever this returns is pasted verbatim into chat, so every path — bad input,
    // rate limit, database error — answers with usable text and never JSON or HTML.
    //
    // `format` turns the new total into that text. hug returns the bare number its command
    // already expects; dropkick finishes the sentence with a random place and the tally.
    // A count of null means the count is unavailable (bad input or a database error) — the
    // reply still has to read like a sentence, so dropkick just drops the tally.
    const CHAT_ACTIONS = {
        hug: (count) => String(count ?? 0),
        dropkick: (count) => (count == null
            ? `${randomDropkick()}!`
            : `${randomDropkick()}. For being annoying, this user has been dropkicked #${count} times in this channel.`),
    };

    const chatActionCounter = (action, format) => async (req, res) => {
        res.type('text').set('Cache-Control', 'no-store');

        const clean = v => String(v || '').trim().toLowerCase().replace(/^[@#]+/, '');
        const channel = clean(req.query.c);
        const user = clean(req.query.u);

        // Twitch login rules both sides: an unresolved $(touser) or a stray mention
        // would otherwise create junk rows keyed on garbage.
        const VALID = /^[a-z0-9_]{3,25}$/;
        if (!VALID.test(channel) || !VALID.test(user)) return res.send(format(null));

        try {
            // One atomic statement: LAST_INSERT_ID(count + 1) hands the new total back on
            // insertId, so two calls landing at once can't both report the same number the
            // way a separate INSERT-then-SELECT would.
            const [result] = await pool.execute(
                `INSERT INTO chat_action_counts (channel, action, username, count) VALUES (?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE count = LAST_INSERT_ID(count + 1)`,
                [channel, action, user]
            );
            // affectedRows === 1 means a fresh row (first time); 2 means it incremented
            res.send(format(result.affectedRows === 1 ? 1 : result.insertId));
        } catch (error) {
            logger.error(`[ChatAction] ${action} counter failed:`, { channel, user, error: error.message });
            res.send(format(null));
        }
    };

    for (const [action, format] of Object.entries(CHAT_ACTIONS)) {
        app.get(`/api/${action}`, chatActionCounter(action, format));
    }

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
            if (!/^[A-Za-z0-9_]{3,25}$/.test(username)) return res.status(400).send('bad username');
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

    app.get('/schedule/:username', async (req, res, next) => {
        const username = req.params.username.trim();
        // /schedule/<slug> is also the public event-schedule page (routes/public-schedule.js,
        // mounted later). This route used to answer first for every slug, so event pages
        // could never be opened. An active event with this slug goes to that router.
        try {
            const [[ev]] = await pool.execute('SELECT id FROM schedule_events WHERE slug = ? AND is_active = 1 LIMIT 1', [username]);
            if (ev) return next();
        } catch (_) { /* no events table: treat it as a Twitch login */ }
        // Only a valid Twitch login gets this page (H-655: the raw name was put into the HTML unescaped).
        if (!/^[A-Za-z0-9_]{3,25}$/.test(username)) return next();
        const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const name = esc(username);
        const imgUrl = `/schedule/${encodeURIComponent(username)}.png`;
        const imgAbs = `https://certifriedmultitool.com${imgUrl}`;
        // Shared site frame (services/schedule-share-page.js + services/site-frame.js). private: the
        // site header can carry the signed-in user's name and avatar.
        res.set('Cache-Control', 'private, max-age=60');
        try {
            const [{ scheduleSharePage }, { sendFramed }] = await Promise.all([import('./services/schedule-share-page.js'), import('./services/site-frame.js')]);
            return await sendFramed(req, res, scheduleSharePage(username));
        } catch (err) { return next(err); }
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

        // Live "reach" counts for the landing cards. Each source is isolated so a
        // failure (bot not ready, DB hiccup, missing table) never blocks the page.
        let discordUsers = 0;
        let customBotServers = 0;
        let kickEnrolled = 0;
        let phishingBlocked = 0;
        try {
            // getServerStats() dedupes guilds across the main client AND every
            // custom bot in global.botManager — same number used by /discord and /status.
            if (typeof getServerStats === 'function') {
                const s = getServerStats(client);
                discordServers = s?.guilds || 0;
                discordUsers = s?.users || 0;
                customBotServers = s?.customBotGuilds || 0;
            }
        } catch (err) {
            logger.warn('[Landing Chooser] Failed to get Discord server count:', { error: err.message });
        }
        try {
            const [[row]] = await pool.execute(
                "SELECT COUNT(*) AS c FROM tokes_channels WHERE platform = 'kick' AND is_enabled = 1"
            );
            kickChannels = row?.c || 0;
            const [[enr]] = await pool.execute(
                "SELECT COUNT(*) AS c FROM tokes_channels WHERE platform = 'kick' AND defender_enabled = 1"
            );
            kickEnrolled = enr?.c || 0;
        } catch (err) {
            logger.warn('[Landing Chooser] Failed to get Kick channel count:', { error: err.message });
        }
        try {
            const mod = await import('./../services/certifried-bot/defender/phishing-domains.js');
            phishingBlocked = (typeof mod.size === 'function' ? mod.size() : 0) || 0;
        } catch (err) { /* optional stat */ }

        const viewData = {
            user: req.user || null,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID,
            discordLoggedIn,
            kickLoggedIn,
            discordHref: discordLoggedIn ? '/dashboard' : '/auth/discord',
            kickHref: kickLoggedIn ? '/kick' : '/tokes-bot/auth/kick',
            discordServers,
            discordUsers,
            customBotServers,
            kickChannels,
            kickEnrolled,
            phishingBlocked,
            // Public app listing for the main bot. Built from the same client id the
            // OAuth flow uses so the link can't drift from the application it describes.
            discoveryUrl: process.env.DISCORD_CLIENT_ID
                ? `https://discord.com/discovery/applications/${process.env.DISCORD_CLIENT_ID}`
                : null
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
    // NOTE: `/discord` is intentionally NOT the landing page. It is the public invite short-link,
    // handled by the redirect route further down (→ discord.com/invite/…). This used to render the
    // landing template, which — being registered first — shadowed that redirect, so the invite link
    // silently served a web page instead. The landing page already lives at `/`.

    // 4:20 world clock as a standalone OBS browser source (transparent, no auth).
    // Drop the full URL into an OBS "Browser" source. Tunable via query string:
    //   ?bg=dark|<hex>  ?accent=<hex>  ?accent2=<hex>  ?ticker=0  ?scale=1.4
    app.get(['/420', '/420-clock'], (req, res) => {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.render('fourtwenty-overlay', { zones: FOURTWENTY_ZONES });
    });

    // Public setup page for the overlay above: options, live preview, copyable URL.
    app.get(['/420/obs', '/420-clock/obs'], (req, res) => {
        // The live preview iframes /420. The global CSP's frame-src lists only video
        // hosts, so allow same-origin frames on this one page rather than sitewide.
        const csp = res.getHeader('Content-Security-Policy');
        if (typeof csp === 'string') {
            res.setHeader('Content-Security-Policy', csp.replace(/(^|;)frame-src /, "$1frame-src 'self' "));
        }
        res.render('fourtwenty-obs-builder');
    });

    app.get('/auth/discord', (req, res, next) => {
        // Only same-origin paths may be stored. This previously accepted any
        // value, so /auth/discord?returnTo=https://evil.example redirected the
        // user off-site the instant their Discord login succeeded — the highest
        // trust moment in the session, and an ideal place to phish.
        //
        // The negative lookahead matters as much as the leading slash: `//evil.example`
        // and `/\evil.example` are protocol-relative URLs that browsers treat as
        // absolute, so a bare startsWith('/') check does not close this.
        if (req.query.returnTo && /^\/(?![/\\])/.test(req.query.returnTo)) {
            req.session.returnTo = req.query.returnTo;
        } else if (req.query.returnTo) {
            logger.warn('[Auth] Rejected off-site returnTo', { returnTo: String(req.query.returnTo).slice(0, 200) });
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

            /* Goes through the shared generator rather than one hard-coded key.
               This route named GOOGLE_AI_KEY specifically, and that key's daily
               image quota is spent — so the button returned "AI generation
               failed" no matter what anyone typed, while a second working key
               sat unused in the same environment. */
            const { generateImage, persistImage } = await import('../utils/image-generation.js');
            const safePrompt = `A greeting card cover image: ${prompt.substring(0, 400)}. Style: colorful, celebratory, festive, high quality.`;

            let imageUrl = null;
            try {
                const made = await generateImage({ prompt: safePrompt, aspect: 'portrait' });
                imageUrl = (await persistImage(made.buffer,
                    { prefix: 'ai_cover_standalone', contentType: made.contentType })).url;
            } catch (e) {
                logger.warn(`[Cards] cover generation failed: ${e.message}`);
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
                // Shared links get mangled in chat apps — a trailing `_`, `.`, `)` or `>` from
                // markdown/punctuation lands inside the URL. Slugs and tokens are [a-z0-9-] only,
                // so trailing junk is never ours: strip it and retry before giving up.
                const cleaned = shareToken.replace(/[^a-zA-Z0-9-]+$/, '');
                if (cleaned && cleaned !== shareToken) {
                    const [retry] = await pool.execute(
                        'SELECT slug, share_token FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1',
                        [cleaned, cleaned]
                    );
                    if (retry.length) {
                        return res.redirect(301, '/card/' + (retry[0].slug || retry[0].share_token));
                    }
                }
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

            // Resolve embeddable video links once here so every card layout renders them the same way
            for (const s of signatures) {
                s.video = s.video_url ? parseVideoUrl(s.video_url) : null;
            }

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
            // Site owner can moderate any card — including the ones created anonymously,
            // which have no creator_user_id and so would otherwise have nobody who can moderate them.
            const canModerate = !!isCreator || (req.user && req.user.id === process.env.BOT_OWNER_ID);
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

            // The card's "Embed code" button hands out an <iframe> for other websites, but
            // helmet's SAMEORIGIN / frame-ancestors 'self' made every embed a blank box.
            // Only the card view itself may be framed.
            res.removeHeader('X-Frame-Options');
            const cardCsp = res.getHeader('Content-Security-Policy');
            if (typeof cardCsp === 'string') res.setHeader('Content-Security-Policy', cardCsp.replace(/frame-ancestors [^;]*/, 'frame-ancestors *'));
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
                canModerate: !!canModerate,
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
            // Style + media fields are read straight off req.body by sanitizeCardSignatureFields()
            const { message, guest_name, guest_password, gift_code, gift_platform } = req.body;

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

            const style = sanitizeCardSignatureFields(req.body);

            // Random rotation like RecoCards: ~16% of cards get a rotation between -5 and +5 degrees
            const rotation = Math.random() < 0.3 ? parseFloat((Math.random() * 6 - 3).toFixed(1)) : null;

            // Encrypt gift card code if provided
            let encryptedGiftCode = null;
            const safeGiftPlatform = (gift_platform && gift_platform.length <= 100) ? gift_platform.trim() : null;
            if (gift_code && gift_code.trim()) {
                try {
                    encryptedGiftCode = JSON.stringify(encryption.encrypt(gift_code.trim().substring(0, 2000)));
                } catch { encryptedGiftCode = null; }
            }

            // Hash optional guest password for later editing
            const crypto = await import('crypto');
            const guestPasswordHash = (guest_password && guest_password.trim())
                ? crypto.createHash('sha256').update(guest_password.trim()).digest('hex')
                : null;

            await pool.execute(`
                INSERT INTO birthday_card_signatures (card_id, signer_user_id, signer_username, signer_avatar_url, message, gif_url, video_url, font_color, font_family, font_size, rotation, audio_url, gift_code_encrypted, gift_platform, card_bg_color, card_border_radius, card_border_color, card_shadow, note_effect, guest_password_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [card.id, signerUserId, signerUsername, avatarUrl, message.trim().substring(0, 2000), style.gif_url, style.video_url, style.font_color, style.font_family, style.font_size, rotation, style.audio_url, encryptedGiftCode, safeGiftPlatform, style.card_bg_color, style.card_border_radius, style.card_border_color, style.card_shadow, style.note_effect, guestPasswordHash]);

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

    // Edit a signature (logged-in user edits own, guest uses password).
    // The edit form submits the note's complete state, so every style/media field is
    // rewritten from the request — omitting one means "clear it", not "leave it alone".
    // The lone exception is the gift code, which is encrypted and never sent back to the
    // browser, so it can only be replaced or removed explicitly.
    app.post('/card/:shareToken/edit-signature/:signatureId', async (req, res) => {
        try {
            const { shareToken, signatureId } = req.params;
            const { message, guest_password, gift_code, gift_platform, remove_gift } = req.body;

            if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty' });

            const [cards] = await pool.execute('SELECT id FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1', [shareToken, shareToken]);
            if (!cards.length) return res.status(404).json({ error: 'Card not found' });
            const card = cards[0];

            // Scope the signature to the card in the URL, so a token for one card can't
            // reach a note on another.
            const [sigs] = await pool.execute('SELECT signer_user_id, guest_password_hash FROM birthday_card_signatures WHERE id = ? AND card_id = ?', [signatureId, card.id]);
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

            const style = sanitizeCardSignatureFields(req.body);

            const sets = [
                'message = ?', 'gif_url = ?', 'video_url = ?', 'font_color = ?', 'font_family = ?',
                'font_size = ?', 'audio_url = ?', 'card_bg_color = ?', 'card_border_radius = ?',
                'card_border_color = ?', 'card_shadow = ?', 'note_effect = ?',
            ];
            const params = [
                message.trim().substring(0, 2000), style.gif_url, style.video_url, style.font_color,
                style.font_family, style.font_size, style.audio_url, style.card_bg_color,
                style.card_border_radius, style.card_border_color, style.card_shadow, style.note_effect,
            ];

            if (gift_code && gift_code.trim()) {
                let encryptedGiftCode = null;
                try {
                    encryptedGiftCode = JSON.stringify(encryption.encrypt(gift_code.trim().substring(0, 2000)));
                } catch { encryptedGiftCode = null; }
                if (!encryptedGiftCode) return res.status(500).json({ error: 'Could not secure the gift code — nothing was changed' });
                sets.push('gift_code_encrypted = ?', 'gift_platform = ?');
                params.push(encryptedGiftCode, (gift_platform && gift_platform.length <= 100) ? gift_platform.trim() : null);
            } else if (remove_gift) {
                sets.push('gift_code_encrypted = NULL', 'gift_platform = NULL');
            }

            params.push(signatureId);
            await pool.execute(`UPDATE birthday_card_signatures SET ${sets.join(', ')} WHERE id = ?`, params);

            logger.info(`[Birthday Card] ${req.user?.username || 'guest'} edited signature ${signatureId} on card ${card.id}`);
            res.json({ success: true });
        } catch (error) {
            logger.error('[Birthday Card] Error editing signature:', error);
            res.status(500).json({ error: 'Failed to edit signature' });
        }
    });

    // Delete a signature (logged-in user deletes own, guest uses password)
    app.post('/card/:shareToken/delete-signature/:signatureId', async (req, res) => {
        try {
            const { shareToken, signatureId } = req.params;
            const { guest_password } = req.body;

            const [cards] = await pool.execute('SELECT id, user_id, creator_user_id FROM birthday_cards WHERE slug = ? OR share_token = ? LIMIT 1', [shareToken, shareToken]);
            if (!cards.length) return res.status(404).json({ error: 'Card not found' });
            const card = cards[0];

            const [sigs] = await pool.execute('SELECT signer_user_id, guest_password_hash FROM birthday_card_signatures WHERE id = ? AND card_id = ?', [signatureId, card.id]);
            if (!sigs.length) return res.status(404).json({ error: 'Signature not found' });

            const sig = sigs[0];

            if (req.user) {
                // Card owner/creator (and the site owner) moderate the whole card, not just their own message
                const canModerate = card.creator_user_id === req.user.id
                    || card.user_id === req.user.id
                    || req.user.id === process.env.BOT_OWNER_ID;
                if (sig.signer_user_id !== req.user.id && !canModerate) {
                    return res.status(403).json({ error: 'You can only delete your own signature' });
                }
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
            const isCreator = card.creator_user_id === req.user.id || card.user_id === req.user.id || req.user.id === process.env.BOT_OWNER_ID;
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

            const isCreator = card.creator_user_id === req.user.id || card.user_id === req.user.id || req.user.id === process.env.BOT_OWNER_ID;
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
    // ── Encrypted transcript viewer (#72 remnant) ──
    app.get('/transcripts/:guildId/:kind/:id', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, kind, id } = req.params;
            if (!['ticket', 'modmail'].includes(kind)) return res.status(400).send('bad kind');
            const { loadTranscript, transcriptPage } = await import('../core/ticket-transcripts.js');
            const transcript = await loadTranscript(guildId, kind, id);
            if (!transcript) return res.status(404).send('Transcript not found or failed to decrypt.');
            const guildName = req.guildObject?.name || guildId;
            // Shared site frame (services/site-frame.js); the page parts come from core/ticket-transcripts.js.
            const [{ sendFramed }, { stylesheetTag }] = await Promise.all([import('./services/site-frame.js'), import('./services/framed-assets.js')]);
            res.set('Cache-Control', 'private, no-store');
            await sendFramed(req, res, transcriptPage(transcript, { guildName, guildId, kind, title: transcript.title || `${kind === 'modmail' ? 'Modmail' : 'Ticket'} #${id}`, stylesheet: stylesheetTag('/css/cf-public-pages.css') }));
        } catch (err) {
            logger.warn(`[transcript-viewer] ${err.message}`);
            res.status(500).send('transcript render failed');
        }
    });

    // ── Universal message editor (#73) ──
    app.get('/manage/:guildId/bot-message/:id/content', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { getBotMessage } = await import('../core/bot-messages.js');
            const row = await getBotMessage(req.params.guildId, req.params.id);
            if (!row) return res.status(404).json({ ok: false, error: 'not found' });
            const client = botManager?.getClientForGuild?.(String(req.params.guildId));
            if (!client) return res.status(503).json({ ok: false, error: 'no bot client' });
            const channel = await client.channels.fetch(row.channel_id).catch(() => null);
            if (!channel) return res.status(404).json({ ok: false, error: 'channel gone' });
            const msg = await channel.messages.fetch(row.message_id).catch(() => null);
            if (!msg) return res.status(404).json({ ok: false, error: 'message gone' });
            res.json({ ok: true, content: msg.content || '', hasEmbeds: (msg.embeds || []).length > 0 });
        } catch (err) {
            logger.warn(`[bot-message content] ${err.message}`);
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    app.post('/manage/:guildId/bot-message/:id/edit', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { getBotMessage, markEdited } = await import('../core/bot-messages.js');
            const content = String(req.body?.content ?? '').slice(0, 2000);
            const row = await getBotMessage(req.params.guildId, req.params.id);
            if (!row) return res.status(404).json({ ok: false, error: 'not found' });
            const client = botManager?.getClientForGuild?.(String(req.params.guildId));
            if (!client) return res.status(503).json({ ok: false, error: 'no bot client' });
            const channel = await client.channels.fetch(row.channel_id).catch(() => null);
            if (!channel) return res.status(404).json({ ok: false, error: 'channel gone' });
            const msg = await channel.messages.fetch(row.message_id).catch(() => null);
            if (!msg) return res.status(404).json({ ok: false, error: 'message gone' });
            await msg.edit({ content, embeds: msg.embeds || [] });
            await markEdited(row.id, req.user.id);
            res.json({ ok: true });
        } catch (err) {
            logger.warn(`[bot-message edit] ${err.message}`);
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ── Dashboard ticket + modmail reply (TicketsBot bundle, #72) ──
    app.post('/manage/:guildId/ticket/:ticketId/reply', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId, ticketId } = req.params;
        const content = String(req.body?.content || '').slice(0, 2000).trim();
        if (!content) return res.status(400).json({ ok: false, error: 'empty content' });
        try {
            const [[ticket]] = await pool.execute(
                'SELECT id, channel_id, status FROM tickets WHERE id = ? AND guild_id = ?',
                [ticketId, guildId]);
            if (!ticket) return res.status(404).json({ ok: false, error: 'ticket not found' });
            if (ticket.status !== 'open') return res.status(409).json({ ok: false, error: 'ticket is closed' });
            const client = botManager?.getClientForGuild?.(String(guildId));
            if (!client) return res.status(503).json({ ok: false, error: 'no bot client for this guild' });
            const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
            if (!channel) return res.status(404).json({ ok: false, error: 'ticket channel is gone' });
            const posted = await channel.send({
                content: `**Staff reply** (from dashboard, <@${req.user.id}>):\n${content}`,
                allowedMentions: { users: [req.user.id], roles: [], parse: [] },
            });
            await pool.execute('UPDATE tickets SET last_staff_reply_at = NOW() WHERE id = ?', [ticket.id]);
            res.json({ ok: true, message_id: posted.id, channel_id: posted.channelId });
        } catch (err) {
            logger.warn(`[ticket-reply] ${err.message}`);
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    app.post('/manage/:guildId/modmail/:threadId/reply', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId, threadId } = req.params;
        const content = String(req.body?.content || '').slice(0, 2000).trim();
        if (!content) return res.status(400).json({ ok: false, error: 'empty content' });
        try {
            const [[thread]] = await pool.execute(
                'SELECT id, user_id, channel_id, status FROM modmail_threads WHERE id = ? AND guild_id = ?',
                [threadId, guildId]);
            if (!thread) return res.status(404).json({ ok: false, error: 'thread not found' });
            if (thread.status !== 'open') return res.status(409).json({ ok: false, error: 'thread is closed' });
            const client = botManager?.getClientForGuild?.(String(guildId));
            if (!client) return res.status(503).json({ ok: false, error: 'no bot client for this guild' });
            const guild = await client.guilds.fetch(guildId).catch(() => null);
            if (!guild) return res.status(503).json({ ok: false, error: 'guild unavailable' });

            const { EmbedBuilder } = await import('discord.js');
            const dmEmbed = new EmbedBuilder()
                .setColor(0x2ECC71)
                .setAuthor({ name: `${guild.name} Staff (via dashboard)`, iconURL: guild.iconURL() ?? undefined })
                .setDescription(content)
                .setFooter({ text: `${guild.name} · reply to this DM to answer` })
                .setTimestamp(new Date());
            let dmOk = true, dmErr = null;
            try {
                const user = await client.users.fetch(thread.user_id);
                await user.send({ embeds: [dmEmbed] });
            } catch (err) {
                dmOk = false;
                dmErr = err.code === 50007
                    ? "member isn't accepting DMs (closed, or no shared server)"
                    : err.message;
            }
            // Mirror to staff channel so the modmail log stays complete.
            const channel = await client.channels.fetch(thread.channel_id).catch(() => null);
            if (channel) {
                const mirror = new EmbedBuilder()
                    .setColor(dmOk ? 0x2ECC71 : 0xE35858)
                    .setAuthor({ name: `Dashboard reply by ${req.user.username || req.user.id}` })
                    .setDescription(content)
                    .setFooter({ text: dmOk ? 'Delivered to user via DM' : `DM failed: ${dmErr}` })
                    .setTimestamp(new Date());
                await channel.send({ embeds: [mirror] }).catch(() => {});
            }
            await pool.execute(
                `INSERT INTO modmail_messages
                   (thread_id, author_id, author_type, message_content, attachments, is_internal, is_anonymous)
                 VALUES (?, ?, 'staff', ?, NULL, 0, 0)`,
                [thread.id, req.user.id, content]);
            await pool.execute(
                'UPDATE modmail_threads SET last_staff_reply_at = NOW(), last_activity_at = NOW() WHERE id = ?',
                [thread.id]);
            res.json({ ok: true, delivered: dmOk, error: dmErr });
        } catch (err) {
            logger.warn(`[modmail-reply] ${err.message}`);
            res.status(500).json({ ok: false, error: err.message });
        }
    });

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
                    subtitle_font_color = COALESCE(?, subtitle_font_color)
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
                // Unchanged picker = keep what is stored (an unset subtitle colour stays unset).
                (subtitle_font_color && subtitle_font_color !== req.body.subtitle_font_color_shown) ? subtitle_font_color : null,
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

            // Same shared generator as every other picture the bot makes.
            const { generateImage, persistImage } = await import('../utils/image-generation.js');
            const safePrompt = `A birthday card cover image: ${prompt.substring(0, 400)}. Style: colorful, celebratory, festive, high quality.`;

            let imageUrl = null;
            try {
                const made = await generateImage({ prompt: safePrompt, aspect: 'portrait' });
                imageUrl = (await persistImage(made.buffer,
                    { prefix: `ai_cover_${cardId}`, contentType: made.contentType })).url;
            } catch (e) {
                logger.warn(`[Birthday Card] AI cover generation failed: ${e.message}`);
            }

            if (!imageUrl) return res.redirect(`/manage/${guildId}?page=birthday&error=ai_no_image`);

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

            const { card_name, recipient_name, background_music_url, wishlist_url, card_background_url, board_bg_image_url, board_bg_color, is_frozen, password, custom_slug, remove_password } = req.body;

            let passwordHash = undefined;
            if (password && password.trim()) {
                const crypto = await import('crypto');
                passwordHash = crypto.createHash('sha256').update(password.trim()).digest('hex');
            } else if (remove_password === '1' || remove_password === true) {
                // The edit page had no way to take a password off a card.
                passwordHash = null;
            }

            let newSlug = undefined;
            if (custom_slug && custom_slug.trim()) {
                newSlug = custom_slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-|-$/g, '').substring(0, 200) || undefined;
            }
            // Card links are looked up by slug OR share token with LIMIT 1, so a link that
            // another card already uses would make one of the two cards unreachable.
            if (newSlug && newSlug !== card.slug) {
                const [taken] = await pool.execute('SELECT id FROM birthday_cards WHERE (slug = ? OR share_token = ?) AND id <> ? LIMIT 1', [newSlug, newSlug, card.id]);
                if (taken.length) return res.status(409).json({ error: 'That link is already used by another card. Pick a different one.' });
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
            // Bot creators see their own bots; super-admins also get every owner's bots (?scope=all),
            // which is the owner console's bot list. Super-admins were refused here before unless
            // they also had a bot_creator_permissions row.
            const superAdmin = isSuperAdmin(req.user.id);
            if (!superAdmin && !req.user.canCreateBots) {
                return res.status(403).render('error-tailwind', { user: req.user, error: 'You do not have permission to manage custom bots. Ask the bot owner for access.' });
            }

            res.render('bot-management-tailwind', {
                user: req.user,
                isSuperAdmin: superAdmin,
                scope: superAdmin && req.query.scope !== 'mine' ? (req.query.scope === 'all' || !req.user.canCreateBots ? 'all' : 'mine') : 'mine',
                csrfToken: res.locals.csrfToken
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
                    // `db` was never in scope here (the pool is imported as `pool`), so this threw a
                    // ReferenceError into an empty catch and the Streamers stat always rendered 0.
                    // Streamers a guild tracks are its subscriptions (guild_streamers never existed).
                    const [streamers] = await pool.query(
                        'SELECT COUNT(DISTINCT streamer_id) as count FROM subscriptions WHERE guild_id = ? AND departed_at IS NULL',
                        [guild.id]);
                    totalStreamers += streamers[0]?.count || 0;
                } catch (e) { logger.warn(`[Profile] streamer count failed for ${guild.id}: ${e.message}`); }
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
    // Music health page + API (super-admin only) — dashboard/routes/music-health.js
    app.use('/', musicHealthRouter);
    // Feature adoption page + API (super-admin only) — dashboard/routes/feature-adoption.js
    app.use('/', featureAdoptionRouter);
    // Service keys page + API (super-admin only) — dashboard/routes/service-keys.js
    app.use('/', serviceKeysRouter);
    // Command usage report (super-admin only) — dashboard/routes/command-usage-report.js
    app.use('/', commandUsageReportRouter);

    // Owner console: the audit bot's own page lives under /manage/<its server>; this finds the server.
    app.get('/super-admin/audit-bot', checkAuth, (req, res) => {
        if (!isSuperAdmin(req.user.id)) return res.status(403).render('error-tailwind', { user: req.user, error: 'Super admin access required.' });
        const aux = global.botManager?.auxClients ? [...global.botManager.auxClients.values()].find(a => a.page === 'audit-bot' || a.key === 'audit') : null;
        const guildId = aux?.client?.isReady?.() ? aux.client.guilds.cache.first()?.id : null;
        if (!guildId) return res.status(503).render('error-tailwind', { user: req.user, error: 'The audit bot is not connected right now.' });
        res.redirect(`/manage/${guildId}`);
    });

    app.get('/super-admin', checkAuth, async (req, res) => {
        try {
            // Only allow super admin (bot owner)
            if (!isSuperAdmin(req.user.id)) {
                return res.status(403).render('error-tailwind', { user: req.user, error: 'Super admin access required.' });
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
            const superAdmin = isSuperAdmin(req.user.id);
            if (!superAdmin && !req.user.canCreateBots) {
                return res.status(403).render('error-tailwind', { user: req.user, error: 'You do not have permission to manage custom bots.' });
            }

            // Owner of the bot, or a super-admin (any bot)
            const { botId } = req.params;
            const [bots] = await pool.execute(
                'SELECT bot_id, bot_name, client_id, owner_user_id, enabled, approved FROM custom_bots WHERE bot_id = ?',
                [botId]
            );

            if (bots.length === 0 || (!superAdmin && bots[0].owner_user_id !== req.user.id)) {
                return res.status(403).render('error-tailwind', { user: req.user, error: 'You do not own this bot.' });
            }
            const bot = bots[0];

            // Servers this person administers (Administrator, as POST /api/bots/:id/assign requires),
            // plus every server already assigned to this bot so a super-admin can see and undo those.
            const adminGuilds = (req.user.guilds || []).filter(g =>
                new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.Administrator)
            );
            const [mapped] = await pool.execute('SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?', [botId]);
            const byId = new Map(adminGuilds.map(g => [g.id, { id: g.id, name: g.name, icon: g.icon, canEdit: true }]));
            for (const m of mapped) {
                if (byId.has(m.guild_id)) continue;
                const g = global.botManager?.getGuildFromAnyClient?.(m.guild_id);
                byId.set(m.guild_id, { id: m.guild_id, name: g?.name || m.guild_id, icon: g?.icon || null, canEdit: superAdmin });
            }
            const ids = [...byId.keys()];
            const [assignRows] = ids.length
                ? await pool.query('SELECT guild_id, bot_id FROM guild_bot_mapping WHERE guild_id IN (?)', [ids])
                : [[]];
            const assigned = new Map(assignRows.map(r => [r.guild_id, r.bot_id]));
            const botClient = global.botManager?.getClient?.(botId) || null;
            const status = global.botManager?.getBotStatus?.(botId) || null;
            const userGuilds = [...byId.values()].map(g => ({
                ...g,
                currentBot: assigned.get(g.id) || 'default',
                present: !!botClient?.guilds.cache.has(g.id),
            })).sort((a, b) => (b.currentBot === botId) - (a.currentBot === botId) || String(a.name).localeCompare(String(b.name)));

            res.render('bot-assignment', {
                user: req.user,
                botId,
                bot: {
                    id: bot.bot_id,
                    name: (status?.isReady && status.username) ? status.username : bot.bot_name,
                    avatar: status?.avatar || null,
                    online: !!status?.isReady,
                    enabled: !!bot.enabled,
                    approved: !!bot.approved,
                    servers: status?.guilds || 0,
                    inviteBase: `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(bot.client_id || bot.bot_id)}&permissions=1643797540086&scope=bot+applications.commands`,
                },
                userGuilds,
                csrfToken: res.locals.csrfToken
            });
        } catch (error) {
            logger.error('[Bot Assignment Page] Error:', error);
            res.status(500).send('Error loading bot assignment page');
        }
    });

    // The servers a user may manage, as Discord's partial guild objects ({ id, name, icon, ... }):
    // super-admins see every server any bot is in; everyone else the servers where they have
    // Manage Server and a bot is present, plus those where they hold a bot-manager role
    // (core/protection-exempt.js). Used by /dashboard and the manage sidebar's server switcher.
    async function manageableGuildsFor(req) {
        let manageableGuilds;

        // Super-admin gets ALL bot guilds
        if (isSuperAdmin(req.user.id)) {
            manageableGuilds = [];
            const seenGuilds = new Set();

            // Get all guilds from all bots
            // A guild Discord has flagged UNAVAILABLE — an outage, or a shard that has not
            // finished its GUILD_CREATE burst — sits in the cache carrying an id and almost
            // nothing else. `guild.name` is undefined for it. That reached the alphabetical
            // sort at the end of this route, threw, and dropped the request into the catch
            // below, which renders the page with an EMPTY guild list: 83 servers displayed as
            // "No Servers Found". Never let one unnamed guild decide the whole page.
            const describe = (guild) => {
                if (!guild.name) {
                    logger.warn(`[Dashboard] Guild ${guild.id} is cached with no name ` +
                        `(unavailable=${guild.available === false}) — showing a placeholder`);
                }
                return {
                    id: guild.id,
                    name: guild.name || `Unavailable server (${guild.id})`,
                    unavailable: !guild.name,
                    icon: guild.icon || null,
                    permissions: '32', // Fake MANAGE_GUILD for display
                    owner: false
                };
            };

            if (global.botManager) {
                for (const [, botClient] of global.botManager.clients.entries()) {
                    botClient.guilds.cache.forEach(guild => {
                        // Avoid duplicates
                        if (!seenGuilds.has(guild.id)) {
                            seenGuilds.add(guild.id);
                            manageableGuilds.push(describe(guild));
                        }
                    });
                }
                // Servers only an auxiliary bot is in (super-admins only; see checkGuildAdmin).
                for (const aux of global.botManager.auxClients?.values() || []) {
                    if (!aux.client?.isReady?.()) continue;
                    aux.client.guilds.cache.forEach(guild => {
                        if (!seenGuilds.has(guild.id)) {
                            seenGuilds.add(guild.id);
                            manageableGuilds.push({ ...describe(guild), auxBot: aux.label });
                        }
                    });
                }
            } else {
                client.guilds.cache.forEach(guild => manageableGuilds.push(describe(guild)));
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

            // Plus servers where they hold a bot-manager role instead of Manage Server
            // (core/protection-exempt.js). One query for every candidate, then a live check of
            // their roles in each server that has manager roles at all.
            const have = new Set(manageableGuilds.map(g => g.id));
            const candidates = (req.user.guilds || []).filter(g => !have.has(g.id));
            if (candidates.length) {
                try {
                    const [rows] = await pool.query(
                        "SELECT DISTINCT guild_id FROM protection_allowlist WHERE kind = 'manager' AND guild_id IN (?)", [candidates.map(g => g.id)]);
                    for (const { guild_id: id } of rows) {
                        const botGuild = global.botManager
                            ? global.botManager.getClientForGuild(id)?.guilds.cache.get(id)
                            : client.guilds.cache.get(id);
                        if (!botGuild) continue;
                        const access = await liveConfigAccess(botGuild, req.user.id).catch(() => null);
                        if (access?.ok) manageableGuilds.push(candidates.find(g => g.id === id));
                    }
                } catch (err) {
                    logger.warn(`[Dashboard] bot-manager server lookup failed: ${err.message}`);
                }
            }
        }

        return manageableGuilds;
    }

    // Server selection page (dashboard)
    app.get('/dashboard', checkAuth, async (req, res) => {
        try {
            const manageableGuilds = await manageableGuildsFor(req);

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
                    botGuild = botClient?.guilds.cache.get(guildData.id)
                        || global.botManager.getAuxiliaryForGuild?.(guildData.id)?.client.guilds.cache.get(guildData.id);
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
                        botGuild = botClient?.guilds.cache.get(guildData.id)
                            || global.botManager.getAuxiliaryForGuild?.(guildData.id)?.client.guilds.cache.get(guildData.id);
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
                // Raid badges come from the raid system's own row: anti_raid_config and raid_protection_config
                // were never enforced (nothing reads them to protect anyone), so they no longer light badges.
                const [gbRows] = await pool.query('SELECT guild_id FROM global_ban_config WHERE enabled = 1');
                const [rdRows] = await pool.query('SELECT guild_id, enabled, auto_lockdown_enabled FROM raid_detection_config WHERE enabled = 1 OR auto_lockdown_enabled = 1');

                const gbSet = new Set(gbRows.map(r => r.guild_id));
                const rdSet = new Set(rdRows.filter(r => Number(r.enabled)).map(r => r.guild_id));
                const alSet = new Set(rdRows.filter(r => Number(r.auto_lockdown_enabled)).map(r => r.guild_id));

                for (const guildData of manageableGuilds) {
                    const features = [];
                    if (gbSet.has(guildData.id)) features.push('Global Ban');
                    if (rdSet.has(guildData.id)) features.push('Raid Detection');
                    if (alSet.has(guildData.id)) features.push('Auto Lockdown');
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

            // Sort servers alphabetically by name. Coerced because a nameless guild must cost
            // the user its position in the list, never the entire list.
            manageableGuilds.sort((a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? '')));

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
            // An empty list here is indistinguishable from "this account manages nothing", which
            // is how a one-line TypeError read as "No Servers Found" to somebody with 83 servers.
            // Say that the load failed instead of quietly asserting the wrong thing.
            logger.error('[/dashboard Error]', error);
            res.render('servers-tailwind', {
                guilds: [],
                manageableGuilds: [],
                loadError: 'Your servers could not be loaded just now — this is a problem on our side, not an empty account. Please refresh in a moment.',
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

    // -----------------------------------------------------------------------
    // Blanket auth guard for the whole /manage/:guildId/* namespace.
    //
    // Feature routers get mounted in two different shapes. Some are mounted at
    // '/manage/:guildId' WITH checkAuth+checkGuildAdmin at the mount point
    // (backups, event-schedule). Others are mounted at '/' with the full path
    // declared inside the router and no middleware at all — confessions,
    // achievements, statistics, content-management, weather and schedule were
    // all in that second shape, which meant no guild-scoping: any authenticated
    // user could address another guild's rows by editing the ID in the URL.
    // Confessions are anonymous-by-design, so that one leaked private content.
    //
    // Gating the namespace here rather than per-mount means a future router
    // cannot reintroduce the gap by forgetting the middleware. This registers
    // synchronously during setup, so it is always in the stack ahead of the
    // dynamically-imported routers further down. Routers that already carry the
    // middleware just run it twice, which is harmless.
    // -----------------------------------------------------------------------
    // Any successful dashboard change to a server clears that server's cached settings, so it applies at
    // once instead of after the 60-second config cache expires. Covers every save route, present and future,
    // instead of an invalidate call per table (2026-11-18 audit: 5 cached settings had no invalidation).
    app.use(['/manage/:guildId', '/api/guilds/:guildId'], (req, res, next) => {
        const gid = req.params.guildId;
        if (req.method !== 'GET' && req.method !== 'HEAD' && /^\d{17,20}$/.test(gid)) {
            res.on('finish', () => { if (res.statusCode < 400) configCache.invalidateGuild(gid); });
        }
        next();
    });

    app.use('/manage/:guildId', checkAuth, checkGuildAdmin);

    // Server management page
    registerAuditBotRoutes(app, { checkAuth, checkGuildAdmin });

    app.get('/manage/:guildId', checkAuth, checkGuildAdmin, async (req, res) => {
        // A server run only by an auxiliary bot gets that bot's own page (dashboard/routes/audit-bot.js).
        if (req.auxBot) return renderAuditBotPage(req, res);
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

            // Build the category channel map from log_event_config (its embed_color is legacy and unused)
            const categoryChannels = {};
            logEventConfigRows.forEach(row => {
                if (row.log_channel_id) {
                    categoryChannels[row.event_type] = row.log_channel_id;
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
                    "automodRuleCreate","automodRuleUpdate","automodRuleDelete","automod",
                    "system","sticky-roles","temp-channels","join-gate","poll"
                ];
                // Remove events explicitly disabled in log_event_config
                const disabledEvents = new Set(
                    logEventConfigRows.filter(r => r.enabled === 0).map(r => r.event_type)
                );
                enabledLogs = JSON.stringify(allEvents.filter(e => !disabledEvents.has(e)));
            }
            // Categories wired on 2026-10-06 show unticked until this page has been saved since then
            // (core/log-actions.js OPT_IN_CATEGORIES): old saved lists had them ticked by default, not by choice.
            if (!logConfigRaw.events_saved_at) {
                let list = [];
                try { list = Array.isArray(enabledLogs) ? enabledLogs : (JSON.parse(enabledLogs) || []); } catch { list = []; }
                enabledLogs = JSON.stringify(list.filter(e => !isOptInCategory(e)));
            }
            // Per-action colour pickers: the colour each action logs with (the server's pick, else its default).
            let customActionColors = {};
            try {
                const [colorRows] = await pool.execute('SELECT action, color FROM log_action_colors WHERE guild_id = ?', [guildId]);
                customActionColors = Object.fromEntries(colorRows.map(r => [r.action, r.color]));
            } catch (error) {
                logger.warn(`[Logging page] Could not read log action colours: ${error.message}`);
            }
            // Single actions the server switched off (log_action_disabled, migration 413).
            let disabledActions = new Set();
            try {
                const [offRows] = await pool.execute('SELECT action FROM log_action_disabled WHERE guild_id = ?', [guildId]);
                disabledActions = new Set(offRows.map(r => r.action));
            } catch (error) {
                logger.warn(`[Logging page] Could not read switched-off log actions: ${error.message}`);
            }
            const logConfig = {
                log_channel_id: logConfigRaw.log_channel_id || null,
                enabled_logs: enabledLogs,
                log_categories: JSON.stringify(categoryChannels),
                action_color_rows: actionColorRows(guildId, customActionColors, undefined, disabledActions)
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

            // Get member join/leave statistics (last 30 days). Daily counts are kept in activity_stats by
            // core/server-stats-manager.js (member_logs was never written, so this always showed 0).
            try {
                const [[memberStats]] = await pool.execute(
                    `SELECT COALESCE(SUM(members_joined), 0) AS joins, COALESCE(SUM(members_left), 0) AS leaves
                     FROM activity_stats
                     WHERE guild_id = ?
                     AND stat_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`,
                    [guildId]
                );
                analyticsData.memberJoins = parseInt(memberStats.joins) || 0;
                analyticsData.memberLeaves = parseInt(memberStats.leaves) || 0;
            } catch (error) {
                logger.error('Error fetching member stats:', error);
            }

            // Daily server stats for the Analytics page: the last 30 days, each day carrying the same
            // day of the 30 before it (prev_*) so the page can compare periods. Messages come from
            // activity_logs; joins, leaves, commands and voice minutes from activity_stats
            // (core/server-stats-manager.js). Member totals are worked back from today's count with the
            // recorded joins and leaves, so they are an estimate where the bot missed events.
            const serverStats = [];
            try {
                const [dailyMessages] = await pool.execute(
                    `SELECT
                        log_date as date,
                        SUM(count) as message_count
                     FROM activity_logs
                     WHERE guild_id = ?
                     AND type = 'message'
                     AND log_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
                     GROUP BY log_date
                     ORDER BY log_date ASC`,
                    [guildId]
                );
                const messageMap = new Map();
                dailyMessages.forEach(row => {
                    messageMap.set(row.date.toISOString().split('T')[0], parseInt(row.message_count) || 0);
                });

                const activityMap = new Map();
                try {
                    const [activityRows] = await pool.execute(
                        `SELECT stat_date, members_joined, members_left, commands_used, voice_minutes
                         FROM activity_stats
                         WHERE guild_id = ? AND stat_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)`,
                        [guildId]
                    );
                    activityRows.forEach(row => {
                        activityMap.set(row.stat_date.toISOString().split('T')[0], row);
                    });
                } catch (error) {
                    logger.error('Error fetching daily activity stats:', error);
                }

                // 60 days, oldest first.
                const days = [];
                for (let i = 59; i >= 0; i--) {
                    const date = new Date();
                    date.setDate(date.getDate() - i);
                    const dateStr = date.toISOString().split('T')[0];
                    const a = activityMap.get(dateStr) || {};
                    days.push({
                        date: dateStr,
                        message_count: messageMap.get(dateStr) || 0,
                        joins: parseInt(a.members_joined) || 0,
                        leaves: parseInt(a.members_left) || 0,
                        commands: parseInt(a.commands_used) || 0,
                        voice_minutes: parseInt(a.voice_minutes) || 0,
                    });
                }
                // Members at the end of each day, worked back from today's count.
                let members = guild.memberCount || 0;
                for (let i = days.length - 1; i >= 0; i--) {
                    days[i].total_members = Math.max(0, members);
                    members -= days[i].joins - days[i].leaves;
                }

                for (let i = 30; i < days.length; i++) {
                    const d = days[i];
                    const p = days[i - 30];
                    serverStats.push({
                        date: d.date,
                        total_members: d.total_members,
                        online_members: i === days.length - 1 ? analyticsData.onlineMembers : 0, // only known for today
                        message_count: d.message_count,
                        joins: d.joins,
                        leaves: d.leaves,
                        commands: d.commands,
                        voice_minutes: d.voice_minutes,
                        prev_date: p.date,
                        prev_total_members: p.total_members,
                        prev_message_count: p.message_count,
                        prev_joins: p.joins,
                        prev_leaves: p.leaves,
                        prev_commands: p.commands,
                        prev_voice_minutes: p.voice_minutes,
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
                // The AI DJ switch lives in ai_dj_config (one switch for the Music and AI DJ pages, H-667).
                const [djRows] = await pool.execute('SELECT enabled FROM ai_dj_config WHERE guild_id = ?', [guildId]);
                musicConfig = { ...musicConfig, ai_dj_enabled: Number(djRows[0]?.enabled) === 1 ? 1 : 0 };
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
                        sub.custom_message, sub.delete_on_end, sub.override_nickname, sub.override_avatar_url, sub.post_as_streamer,
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
                    // Live if any of the person's platforms is live, not only the first row read.
                    if (row.is_live > 0) streamer.is_live = true;
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
                        post_as_streamer: row.post_as_streamer ?? null,
                        team_subscription_id: row.team_subscription_id,
                        notify_videos: row.notify_videos,
                        video_announcement_channel_id: row.video_announcement_channel_id,
                        is_live: row.is_live > 0
                    });
                });

                // "Last notified" for the streamer list and the edit dialog (subscriptions.last_announced_at,
                // migration 426). Read on its own so the list still loads before the column exists.
                try {
                    const [lastRows] = await pool.execute(
                        'SELECT subscription_id, last_announced_at FROM subscriptions WHERE guild_id = ? AND last_announced_at IS NOT NULL',
                        [guildId]
                    );
                    const lastById = new Map(lastRows.map(r => [String(r.subscription_id), r.last_announced_at]));
                    for (const s of streamerMap.values()) {
                        for (const sub of s.subscriptions) {
                            const at = lastById.get(String(sub.subscription_id)) || null;
                            sub.last_announced_at = at;
                            if (at && (!s.last_announced_at || at > s.last_announced_at)) s.last_announced_at = at;
                        }
                    }
                } catch (lastErr) {
                    if (lastErr.code !== 'ER_BAD_FIELD_ERROR') logger.warn('[Streamers] Could not load last_announced_at:', lastErr.message);
                }

                // Go-live filters for the edit dialog, read on their own so the streamer list still
                // loads on a database without the columns (see core/stream-alert-filters.js).
                try {
                    const [filterRows] = await pool.execute(
                        'SELECT subscription_id, filter_categories, filter_title_keywords FROM subscriptions WHERE guild_id = ?',
                        [guildId]
                    );
                    const filtersById = new Map(filterRows.map(r => [String(r.subscription_id), r]));
                    for (const s of streamerMap.values()) {
                        for (const sub of s.subscriptions) {
                            const f = filtersById.get(String(sub.subscription_id));
                            sub.filter_categories = f?.filter_categories || '';
                            sub.filter_title_keywords = f?.filter_title_keywords || '';
                        }
                    }
                } catch (filterErr) {
                    if (filterErr.code !== 'ER_BAD_FIELD_ERROR') logger.warn('[Streamers] Could not load go-live filters:', filterErr.message);
                }

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
                            webhook_name, webhook_avatar_url, live_board_channel_id
                     FROM twitch_teams
                     WHERE guild_id = ?
                     ORDER BY team_name`,
                    [guildId]
                );
                teamSubscriptions = teamsData;
                // Who on each team is live now (same source as the Discord live board).
                const { teamLiveState } = await import('../core/team-live-board.js');
                for (const t of teamSubscriptions) {
                    const st = await teamLiveState(t).catch(() => null);
                    t.memberCount = st ? st.members : null;
                    t.liveNow = st ? st.live.map(m => ({ name: m.name, login: m.login, game: m.game, viewers: m.viewers, startedAt: m.startedAt })) : [];
                }
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
                    'SELECT bot_nickname, bot_avatar_url, embed_color, modlog_components_v2 FROM guild_config WHERE guild_id = ?',
                    [guildId]
                );
                if (appearanceData.length > 0) {
                    // Merge appearance settings into guildConfig
                    guildConfig.bot_nickname = appearanceData[0].bot_nickname || guildConfig.bot_nickname;
                    guildConfig.bot_avatar_url = appearanceData[0].bot_avatar_url;
                    guildConfig.embed_color = appearanceData[0].embed_color || '#a78bfa';
                    guildConfig.modlog_components_v2 = appearanceData[0].modlog_components_v2 ? 1 : 0;
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
                        if (botData[0].owner_user_id) {
                            try {
                                const owner = await client.users.fetch(String(botData[0].owner_user_id));
                                ownerName = owner?.globalName || owner?.username || null;
                            } catch (e) {
                                logger.warn(`[Manage] could not resolve custom bot owner ${botData[0].owner_user_id}: ${e.message}`);
                            }
                        }
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
                // Guild-wide stream-end behaviour new subscriptions inherit (migration 202).
                // Absent guild row => the historical behaviour: delete on end.
                default_edit_on_end: guildConfig.default_edit_on_end ? 1 : 0,
                default_delete_on_end: guildConfig.default_delete_on_end === undefined
                    ? 1
                    : (guildConfig.default_delete_on_end ? 1 : 0),
                leveling_enabled: levelingConfig.enabled,
                leveling_xp_rate: levelingConfig.xp_per_message,
                leveling_xp_cooldown: levelingConfig.xp_cooldown_seconds,
                level_up_channel_id: levelingConfig.level_up_channel_id,
                leveling_ignored_channels: levelingConfig.ignored_channels ? JSON.parse(levelingConfig.ignored_channels) : [],
                leveling_ignored_roles: levelingConfig.ignored_roles ? JSON.parse(levelingConfig.ignored_roles) : [],
                monthly_reset_enabled: levelingConfig.monthly_reset_enabled,
                reset_interval_days: levelingConfig.reset_interval_days,
                reset_exempt_staff: levelingConfig.reset_exempt_staff,
                last_reset_at: levelingConfig.last_reset_at,
                // Whole level_config row: the page's announcement, voice, boost and reward options
                leveling_config: levelingConfig,
                // Appearance settings from guild_config
                bot_nickname: guildConfig.bot_nickname,
                bot_avatar_url: guildConfig.bot_avatar_url,
                embed_color: guildConfig.embed_color,
                // The Bot appearance page's modlog layout switch. Missing here, it always showed off
                // and every save of that page switched the layout back off.
                modlog_components_v2: guildConfig.modlog_components_v2 ? 1 : 0
            };

            // Fetch Twitch schedule syncs
            let twitchScheduleSyncs = [];
            try {
                const [syncsData] = await pool.execute(
                    `SELECT
                        tss.*,
                        tss.discord_channel_id AS channel_id,
                        tss.is_enabled, tss.sync_interval_minutes, tss.weekly_refresh,
                        tss.last_weekly_refresh, tss.mention_role_id, tss.custom_message,
                        tss.last_synced, tss.schedule_hash, tss.last_message_id,
                        tss.view_mode, tss.layout, tss.background_mode, tss.background_url,
                        tss.background_prompt, tss.background_cache_url, tss.background_rotation,
                        tss.accent_color, tss.card_title, tss.card_footer,
                        tss.schedule_source, tss.side_art_url, tss.card_disclaimer,
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

            // Example schedules the owner uploaded for the bot to imitate.
            let scheduleTemplates = [];
            try {
                const [tplRows] = await pool.execute(
                    `SELECT id, label, source_url, mode, cache_url, prompt, enabled, sort_order, created_at
                     FROM schedule_templates WHERE guild_id = ? ORDER BY sort_order, id`,
                    [guildId]
                );
                scheduleTemplates = tplRows;
            } catch (error) {
                logger.error('Error fetching schedule templates:', error);
            }

            // Fetch Twitch role sync config
            let twitchRoleSyncConfig = null;
            let twitchRoleSyncMembers = [];
            try {
                // sub_role_id is deliberately not selected — Discord's native Twitch integration
                // grants subscriber roles itself, and nothing here has ever synced them. See the
                // settings POST handler below.
                const [configRows] = await pool.execute('SELECT guild_id, broadcaster_twitch_id, broadcaster_twitch_username, vip_role_id, mod_role_id, remove_vip_on_leave, enabled, last_synced, token_scopes, broadcaster_token_status FROM twitch_role_sync_config WHERE guild_id = ?', [guildId]);
                if (configRows.length > 0) twitchRoleSyncConfig = configRows[0];
                const [memberRows] = await pool.execute('SELECT * FROM twitch_role_sync_members WHERE guild_id = ? ORDER BY twitch_username', [guildId]);
                twitchRoleSyncMembers = memberRows;
            } catch {}

            // Fetch Twitch analytics data (config + recent alerts + 12h summary) for the bound broadcaster.
            // Keyed off twitchRoleSyncConfig.broadcaster_twitch_id — if the guild has no broadcaster bound,
            // analytics data stays empty and the UI shows the "connect your broadcaster account first" state.
            let twitchAnalyticsData = { config: null, alerts: [], summary: null, scopesGranted: null };
            if (twitchRoleSyncConfig?.broadcaster_twitch_id) {
                try {
                    const bid = String(twitchRoleSyncConfig.broadcaster_twitch_id);
                    const [cfgRows] = await pool.execute('SELECT * FROM twitch_analytics_config WHERE broadcaster_id = ?', [bid]);
                    twitchAnalyticsData.config = cfgRows[0] || null;
                    const [alertRows] = await pool.execute(
                        "SELECT id, alert_type, severity, score, evidence_json, created_at FROM twitch_anomaly_alerts WHERE broadcaster_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 10",
                        [bid]);
                    twitchAnalyticsData.alerts = alertRows;
                    const [sumRows] = await pool.execute(
                        `SELECT MIN(recorded_at) AS from_time, MAX(recorded_at) AS to_time,
                                AVG(viewer_count) AS avg_viewers, MAX(viewer_count) AS peak_viewers,
                                SUM(msg_count) AS total_msgs, SUM(follow_count) AS total_follows,
                                SUM(sub_count) AS total_subs, SUM(bit_count) AS total_bits,
                                SUM(raid_in_count) AS total_raids
                           FROM twitch_stream_snapshots
                          WHERE broadcaster_id = ? AND recorded_at > DATE_SUB(NOW(), INTERVAL 12 HOUR) AND is_live = 1`,
                        [bid]);
                    if (sumRows[0] && sumRows[0].from_time) twitchAnalyticsData.summary = sumRows[0];
                    twitchAnalyticsData.scopesGranted = twitchRoleSyncConfig.token_scopes || '';

                    // Latest snapshot drives the live-state pill. The aggregator only writes a
                    // row when the stream is live OR events arrived that minute — so an absence
                    // of recent rows legitimately means "offline". We give 'live' a 3-minute
                    // tolerance to cover one missed poll + the per-minute cadence.
                    // Top mention targets in the last hour — read-only visibility into the
                    // harassment-detection rolling buckets. Lets a mod see "who is getting @-ed
                    // most right now" without needing to tail chat manually. Nothing writes here.
                    const [mentionRows] = await pool.execute(
                        `SELECT target_login, SUM(mention_count) AS mention_count,
                                MAX(unique_senders) AS unique_senders,
                                MAX(window_start) AS latest
                           FROM twitch_mention_targets
                          WHERE broadcaster_id = ? AND window_start > DATE_SUB(NOW(), INTERVAL 1 HOUR)
                          GROUP BY target_login
                          ORDER BY mention_count DESC
                          LIMIT 5`, [bid]);
                    twitchAnalyticsData.mentionTargets = mentionRows;

                    // ─── v2 analytics (2026-10-18): growth + engagement surfaces ───────────
                    // All v2 queries are additive. If a table is empty (e.g. broadcaster hasn't
                    // granted the scope yet), the EJS renders a "no data yet" placeholder.
                    try {
                        // Recent stream sessions (last 10 — includes the currently-open one).
                        const [sessions] = await pool.execute(
                            `SELECT id, started_at, ended_at, duration_minutes, peak_viewers,
                                    avg_viewers, total_msgs, unique_chatters, total_follows,
                                    total_subs, total_gift_subs, total_bits, total_raids_in,
                                    primary_category_name, title_at_start,
                                    title_change_count, category_change_count
                               FROM twitch_stream_sessions
                              WHERE broadcaster_id = ?
                              ORDER BY started_at DESC LIMIT 10`, [bid]);
                        twitchAnalyticsData.sessions = sessions;

                        // Week-over-week deltas on the 7 KPIs we have per-minute data for.
                        const [thisWeek] = await pool.execute(
                            `SELECT COALESCE(SUM(msg_count),0) AS msgs, COALESCE(SUM(follow_count),0) AS follows,
                                    COALESCE(SUM(sub_count),0) AS subs, COALESCE(SUM(bit_count),0) AS bits,
                                    COALESCE(SUM(raid_in_count),0) AS raids,
                                    COALESCE(MAX(viewer_count),0) AS peak_v,
                                    COALESCE(AVG(NULLIF(viewer_count,0)),0) AS avg_v
                               FROM twitch_stream_snapshots
                              WHERE broadcaster_id = ?
                                AND recorded_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`, [bid]);
                        const [lastWeek] = await pool.execute(
                            `SELECT COALESCE(SUM(msg_count),0) AS msgs, COALESCE(SUM(follow_count),0) AS follows,
                                    COALESCE(SUM(sub_count),0) AS subs, COALESCE(SUM(bit_count),0) AS bits,
                                    COALESCE(SUM(raid_in_count),0) AS raids,
                                    COALESCE(MAX(viewer_count),0) AS peak_v,
                                    COALESCE(AVG(NULLIF(viewer_count,0)),0) AS avg_v
                               FROM twitch_stream_snapshots
                              WHERE broadcaster_id = ?
                                AND recorded_at > DATE_SUB(NOW(), INTERVAL 14 DAY)
                                AND recorded_at <= DATE_SUB(NOW(), INTERVAL 7 DAY)`, [bid]);
                        twitchAnalyticsData.wow = { thisWeek: thisWeek[0] || {}, lastWeek: lastWeek[0] || {} };

                        // Engagement rates — derived from the 12h summary + chatters.
                        const sum = twitchAnalyticsData.summary;
                        if (sum) {
                            const [chatSum] = await pool.execute(
                                `SELECT COALESCE(SUM(total_count),0) AS c, COUNT(*) AS n
                                   FROM twitch_chatters_snapshots
                                  WHERE broadcaster_id = ? AND recorded_at > DATE_SUB(NOW(), INTERVAL 12 HOUR)`,
                                [bid]);
                            const avgChatters = chatSum[0]?.n ? Number(chatSum[0].c) / Number(chatSum[0].n) : 0;
                            const avgV = Number(sum.avg_viewers) || 0;
                            const msgs = Number(sum.total_msgs) || 0;
                            const follows = Number(sum.total_follows) || 0;
                            const subs = Number(sum.total_subs) || 0;
                            const bits = Number(sum.total_bits) || 0;
                            // minutes = count of snapshots in the window
                            const [n] = await pool.execute(
                                `SELECT COUNT(*) AS n FROM twitch_stream_snapshots
                                  WHERE broadcaster_id = ? AND recorded_at > DATE_SUB(NOW(), INTERVAL 12 HOUR) AND is_live = 1`,
                                [bid]);
                            const liveMinutes = Number(n[0]?.n) || 0;
                            const viewerHours = (avgV * liveMinutes) / 60;
                            twitchAnalyticsData.engagement = {
                                msgs_per_chatter: avgChatters > 0 ? msgs / avgChatters : null,
                                follows_per_viewer_hour: viewerHours > 0 ? follows / viewerHours : null,
                                subs_per_viewer_hour: viewerHours > 0 ? subs / viewerHours : null,
                                bits_per_viewer_hour: viewerHours > 0 ? bits / viewerHours : null,
                                mod_actions_per_1k_msgs: msgs > 0 ? (Number(sum.total_mod_actions || 0) / msgs) * 1000 : null,
                                avg_chatters: avgChatters,
                            };
                        }

                        // Category / title history (last 20 — small spool).
                        const [catHistory] = await pool.execute(
                            `SELECT changed_at, title, category_name, language
                               FROM twitch_category_history
                              WHERE broadcaster_id = ? ORDER BY changed_at DESC LIMIT 20`, [bid]);
                        twitchAnalyticsData.categoryHistory = catHistory;

                        // Hype trains — last 10 begins/ends.
                        const [hypeTrains] = await pool.execute(
                            `SELECT hype_train_id, event_type, level, total_bits, total_subs,
                                    goal, progress, is_golden, occurred_at
                               FROM twitch_hype_train_events
                              WHERE broadcaster_id = ? AND event_type IN ('begin','end')
                              ORDER BY occurred_at DESC LIMIT 10`, [bid]);
                        twitchAnalyticsData.hypeTrains = hypeTrains;

                        // Goals — active (latest row per goal_id with event_type != 'end').
                        const [goals] = await pool.execute(
                            `SELECT g.* FROM twitch_goal_events g
                               INNER JOIN (
                                 SELECT goal_id, MAX(occurred_at) AS latest
                                   FROM twitch_goal_events
                                  WHERE broadcaster_id = ?
                                  GROUP BY goal_id
                               ) latest ON g.goal_id = latest.goal_id AND g.occurred_at = latest.latest
                              WHERE g.broadcaster_id = ?
                              ORDER BY g.occurred_at DESC LIMIT 10`, [bid, bid]);
                        twitchAnalyticsData.goals = goals;

                        // Ad breaks — last 20.
                        const [adBreaks] = await pool.execute(
                            `SELECT duration_seconds, is_automatic, requester_user_login, started_at
                               FROM twitch_ad_breaks
                              WHERE broadcaster_id = ? ORDER BY started_at DESC LIMIT 20`, [bid]);
                        twitchAnalyticsData.adBreaks = adBreaks;
                        // Ads rollup: total ads + total ad seconds in last 7 days.
                        const [adRoll] = await pool.execute(
                            `SELECT COUNT(*) AS n, COALESCE(SUM(duration_seconds),0) AS s
                               FROM twitch_ad_breaks
                              WHERE broadcaster_id = ? AND started_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`, [bid]);
                        twitchAnalyticsData.adBreaksSummary = adRoll[0] || { n: 0, s: 0 };

                        // Charity — last 10 events + lifetime total raised.
                        const [charity] = await pool.execute(
                            `SELECT campaign_id, event_type, charity_name, donor_user_login,
                                    donation_amount, donation_currency, current_amount, target_amount, occurred_at
                               FROM twitch_charity_events
                              WHERE broadcaster_id = ? ORDER BY occurred_at DESC LIMIT 10`, [bid]);
                        twitchAnalyticsData.charity = charity;

                        // Polls — last 5 completed.
                        const [polls] = await pool.execute(
                            `SELECT p.* FROM twitch_poll_events p
                               INNER JOIN (
                                 SELECT poll_id, MAX(occurred_at) AS latest
                                   FROM twitch_poll_events
                                  WHERE broadcaster_id = ? AND event_type = 'end'
                                  GROUP BY poll_id
                               ) latest ON p.poll_id = latest.poll_id AND p.occurred_at = latest.latest
                              WHERE p.broadcaster_id = ?
                              ORDER BY p.occurred_at DESC LIMIT 5`, [bid, bid]);
                        twitchAnalyticsData.polls = polls;

                        // Predictions — last 5.
                        const [predictions] = await pool.execute(
                            `SELECT p.* FROM twitch_prediction_events p
                               INNER JOIN (
                                 SELECT prediction_id, MAX(occurred_at) AS latest
                                   FROM twitch_prediction_events
                                  WHERE broadcaster_id = ? AND event_type = 'end'
                                  GROUP BY prediction_id
                               ) latest ON p.prediction_id = latest.prediction_id AND p.occurred_at = latest.latest
                              WHERE p.broadcaster_id = ?
                              ORDER BY p.occurred_at DESC LIMIT 5`, [bid, bid]);
                        twitchAnalyticsData.predictions = predictions;

                        // Shoutouts given + received (last 10 each).
                        const [shoutouts] = await pool.execute(
                            `SELECT direction, counterpart_user_login, moderator_user_login,
                                    viewer_count, occurred_at
                               FROM twitch_shoutout_events
                              WHERE broadcaster_id = ? ORDER BY occurred_at DESC LIMIT 10`, [bid]);
                        twitchAnalyticsData.shoutouts = shoutouts;

                        // Top redeemed rewards (last 7 days, top 10 by count).
                        const [topRewards] = await pool.execute(
                            `SELECT reward_title, reward_cost, COUNT(*) AS redemption_count,
                                    MAX(redeemed_at) AS last_redeemed
                               FROM twitch_redemption_events
                              WHERE broadcaster_id = ? AND redeemed_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
                                AND reward_title IS NOT NULL
                              GROUP BY reward_title, reward_cost
                              ORDER BY redemption_count DESC LIMIT 10`, [bid]);
                        twitchAnalyticsData.topRewards = topRewards;

                        // Sub churn: endings vs new subs in last 7 days.
                        const [subEnd7d] = await pool.execute(
                            `SELECT COUNT(*) AS n FROM twitch_sub_endings
                              WHERE broadcaster_id = ? AND occurred_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`, [bid]);
                        const [subNew7d] = await pool.execute(
                            `SELECT COALESCE(SUM(sub_count),0) AS n FROM twitch_stream_snapshots
                              WHERE broadcaster_id = ? AND recorded_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`, [bid]);
                        twitchAnalyticsData.churn = {
                            new_subs_7d: Number(subNew7d[0]?.n) || 0,
                            ended_subs_7d: Number(subEnd7d[0]?.n) || 0,
                        };

                        // Recent resub messages (last 10, with messages that aren't null).
                        const [resubs] = await pool.execute(
                            `SELECT user_login, tier, cumulative_months, streak_months, message, occurred_at
                               FROM twitch_resub_messages
                              WHERE broadcaster_id = ? AND message IS NOT NULL AND message != ''
                              ORDER BY occurred_at DESC LIMIT 10`, [bid]);
                        twitchAnalyticsData.resubs = resubs;

                        // VIP + moderator churn (last 10).
                        const [vipMod] = await pool.execute(
                            `SELECT role, action, target_user_login, occurred_at
                               FROM twitch_vip_mod_changes
                              WHERE broadcaster_id = ? ORDER BY occurred_at DESC LIMIT 10`, [bid]);
                        twitchAnalyticsData.vipModChanges = vipMod;
                    } catch (v2err) {
                        logger.warn('[TwitchAnalytics] v2 queries failed', { err: v2err.message, guildId });
                    }

                    const [latestRows] = await pool.execute(
                        `SELECT recorded_at, is_live FROM twitch_stream_snapshots
                          WHERE broadcaster_id = ? ORDER BY recorded_at DESC LIMIT 1`, [bid]);
                    const latest = latestRows[0];
                    if (!latest) twitchAnalyticsData.liveState = 'untracked';
                    else {
                        const ageMs = Date.now() - new Date(latest.recorded_at).getTime();
                        twitchAnalyticsData.liveState = (latest.is_live && ageMs < 3 * 60_000) ? 'live' : 'offline';
                    }
                } catch (e) {
                    logger.warn('[TwitchAnalytics] view-load error', { err: e.message, guildId });
                }
            }

            // Fetch temp channel configuration
            let tempChannelConfig = {};
            try {
                const [tempChannelData] = await pool.execute(
                    'SELECT * FROM temp_channel_config WHERE guild_id = ?',
                    [guildId]
                );
                // The page edits the first creator channel; the others (/admin temp-channel) are counted (H-810).
                tempChannelConfig = tempChannelData[0] ? { ...tempChannelData[0], extra_creators: tempChannelData.length - 1 } : {};
                logger.info('[GET /manage/:guildId] Temp channel config:', tempChannelConfig);
            } catch (error) {
                logger.error('Error fetching temp channel config:', error);
            }

            // Fetch bot_messages for the Messages page (universal message editor)
            let botMessagesData = { items: [], total: 0, features: [], filter: null };
            try {
                if (req.query.page === 'messages') {
                    const bm = await import('../core/bot-messages.js');
                    const filter = req.query.feature ? String(req.query.feature).slice(0, 40) : null;
                    const [items, total, features] = await Promise.all([
                        bm.listBotMessages(guildId, { limit: 50, feature: filter }),
                        bm.countBotMessages(guildId, { feature: filter }),
                        bm.listFeatures(guildId),
                    ]);
                    botMessagesData = { items, total, features, filter };
                }
            } catch (e) { logger.warn('[dashboard] botMessages load: ' + e.message); }

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

            // Fetch OPEN tickets + modmail threads for the dashboard list. Compute awaiting_response
            // = user replied after staff last. Both tables got last_staff_reply_at + last_user_reply_at
            // in migration 348.
            let openTickets = [], openModmail = [];
            try {
                const [tRows] = await pool.execute(
                    `SELECT id, ticket_number, channel_id, user_id, subject, status, claimed_by_id,
                            created_at, last_staff_reply_at, last_user_reply_at,
                            (last_user_reply_at IS NOT NULL
                             AND (last_staff_reply_at IS NULL OR last_user_reply_at > last_staff_reply_at)
                            ) AS awaiting_response
                       FROM tickets WHERE guild_id = ? AND status = 'open'
                       ORDER BY awaiting_response DESC, created_at DESC
                       LIMIT 50`, [guildId]);
                openTickets = tRows;
            } catch (e) { logger.warn('[dashboard] openTickets load: ' + e.message); }
            try {
                const [mRows] = await pool.execute(
                    `SELECT id, channel_id, user_id, status, created_at,
                            last_staff_reply_at, last_user_reply_at,
                            (last_user_reply_at IS NOT NULL
                             AND (last_staff_reply_at IS NULL OR last_user_reply_at > last_staff_reply_at)
                            ) AS awaiting_response
                       FROM modmail_threads WHERE guild_id = ? AND status = 'open'
                       ORDER BY awaiting_response DESC, created_at DESC
                       LIMIT 50`, [guildId]);
                openModmail = mRows;
            } catch (e) { logger.warn('[dashboard] openModmail load: ' + e.message); }

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
                        (SELECT COUNT(*) FROM ticket_form_questions WHERE form_id = f.form_id) as question_count,
                        (SELECT COUNT(*) FROM form_submissions WHERE form_id = f.form_id AND guild_id = f.guild_id) as submission_count,
                        (SELECT COUNT(*) FROM ticket_panels WHERE form_id = f.form_id AND guild_id = f.guild_id) as panel_count
                    FROM ticket_forms f
                    WHERE f.guild_id = ?
                    ORDER BY f.form_id DESC
                `, [guildId]);
                forms = formsData;
            } catch (error) {
                logger.error('Error fetching forms:', error);
                forms = [];
            }

            // Fetch starboard configuration: every board (starboard_config is one row per board since
            // migration 423), and the one being edited: ?board=<id>, ?board=new, or the first board.
            let starboardConfig = {};
            let starboardBoards = [];
            let starboardNew = false;
            try {
                const [starboardData] = await pool.execute(
                    'SELECT * FROM starboard_config WHERE guild_id = ? ORDER BY id ASC',
                    [guildId]
                );
                starboardBoards = starboardData;
                const wantBoard = String(req.query.board || '');
                if (wantBoard === 'new' && starboardData.length < 10) {
                    starboardNew = true;
                } else {
                    starboardConfig = starboardData.find(b => String(b.id) === wantBoard) || starboardData[0] || {};
                }
                // Map star_threshold to threshold for template compatibility
                if (starboardConfig.star_threshold !== undefined) {
                    starboardConfig.threshold = starboardConfig.star_threshold;
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

            // Feature keys drive both the generated pageMap entries and the generated nav
            // cards in manage-tailwind.ejs, so a spec entry always has a reachable page.
            let featureConfigKeys = [];
            let featureConfigSpecs = {};
            try {
                const specModule = await import('../core/feature-config-spec.js');
                featureConfigKeys = specModule.FEATURE_KEYS;
                featureConfigSpecs = specModule.FEATURE_SPECS;
            } catch (error) {
                logger.error('Error loading feature config specs:', error);
            }

            // Sections + pages for the overview lists, the sub-page sidebar and search
            // (core/manage-nav.js). Built after the specs so generated pages are filed too.
            let manageNav = [];
            let relatedPageList = [];
            try {
                const navModule = await import('../core/manage-nav.js');
                manageNav = navModule.buildManageNav(featureConfigSpecs);
                // "Related pages" at the bottom of a feature page (core/manage-nav.js RELATED).
                if (req.query.page && req.query.page !== 'overview') relatedPageList = navModule.relatedPages(String(req.query.page), manageNav);
            } catch (error) {
                logger.error('Error building manage navigation:', error);
            }

            // "What this does" and the Recommended settings values for a feature page (core/page-help.js).
            let pageHelpEntry = null;
            if (req.query.page && req.query.page !== 'overview') {
                try {
                    pageHelpEntry = (await import('../core/page-help.js')).pageHelp(String(req.query.page));
                } catch (error) {
                    logger.error('Error loading page help:', error);
                }
            }

            // Wave 17 (nav polish): this server's embed colour as the accent, for users who turned
            // on "Use each server's colour" (core/accent-tint.js); the overview's setup checklist
            // unless this user dismissed it here (core/setup-checklist.js, loaded by the page).
            const guildThemeNow = await getTheme(guildId).catch(() => ({ ...DEFAULT_THEME }));
            const navPrefs = res.locals.userPrefs || {};
            const serverAccentStyle = navPrefs.serverAccent ? serverAccentCss(guildThemeNow.primary || DEFAULT_THEME.primary) : '';

            // Real data for pages whose keys below are still placeholders ({} / []); only the page
            // being viewed is loaded. Spread last so it wins over the placeholders.
            const manageSection = await loadManageSection(req.query.page || 'overview', guildId, guild, req.query);

            // Site style "classic" (saved, or ?style=classic) renders the original pre-redesign
            // page from the same locals; cards and compact share manage-tailwind.ejs.
            const manageTemplate = manageTemplateFor(res.locals.uiStyle);
            const classic = manageTemplate === 'manage-classic';
            res.render(manageTemplate, {
                classicCss: classic,
                siteStyles: STYLES.map((s) => ({ value: s.value, label: s.label })),
                user: req.user,
                guild: guild,
                page: req.query.page || 'overview',
                featureConfigKeys,
                featureConfigSpecs,
                manageNav,
                relatedPages: relatedPageList,
                pageHelp: pageHelpEntry,
                serverAccentCss: serverAccentStyle,
                checklistHidden: Array.isArray(navPrefs.hiddenChecklists) && navPrefs.hiddenChecklists.includes(guildId),
                settingsIndexVersion: views.stats().generation,
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
                purgeRules: await (async () => {
                    try {
                        const [rows] = await pool.execute('SELECT * FROM channel_purge_rules WHERE guild_id = ? ORDER BY created_at DESC', [guildId]);
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
                starboardBoards: starboardBoards,
                starboardNew: starboardNew,
                starboardEmojis: guild.emojis?.cache ? [...guild.emojis.cache.values()].map(e => ({ id: e.id, name: e.name, animated: !!e.animated })).sort((a, b) => a.name.localeCompare(b.name)) : [],
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
                        // Names, not ids, for the user and moderator (core/user-display.js).
                        const { userBits } = await import('../core/user-display.js');
                        return rows.map((r) => ({ ...r, user: userBits(guild, r.user_id), moderator: userBits(guild, r.moderator_id) }));
                    } catch (error) {
                        logger.error('Error fetching recent infractions:', error);
                        return [];
                    }
                })(),
                // /ban (and so Ban requests) only exists where it is registered: an opted-in server on the
                // main bot, or a server a custom bot serves (core/guild-scoped-access.js, H-712).
                banCommandAvailable: await (async () => {
                    try {
                        const { isCommandAvailableInGuild } = await import('../core/guild-scoped-access.js');
                        return await isCommandAvailableInGuild(guildId, 'ban');
                    } catch (error) {
                        logger.error('Error checking where /ban is available:', error);
                        return true;
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
                // The AutoMod page says when heat scoring changes what its rules do (automod_heat_config.is_enabled).
                heatConfig: req.query.page === 'automod'
                    ? await pool.execute('SELECT is_enabled FROM automod_heat_config WHERE guild_id = ?', [guildId]).then(([r]) => r[0] || {}).catch(() => ({}))
                    : {},
                joinGateConfig: await (async () => {
                    try {
                        const [rows] = await pool.execute(
                            'SELECT * FROM join_gate_config WHERE guild_id = ?',
                            [guildId]
                        );
                        // Verification itself is verify_config (core/verification.js; migration 328 folded
                        // join_gate_config.is_enabled / verification_role_id into it — nothing enforced those).
                        const [[verify]] = await pool.execute(
                            'SELECT enabled, verified_role_id, mode FROM verify_config WHERE guild_id = ?',
                            [guildId]
                        ).catch(() => [[null]]);
                        if (rows[0] || verify) {
                            // The whole row: the account-age gate's settings live here too, and
                            // hand-picking two fields is why they could not be edited from here.
                            return {
                                ...(rows[0] || {}),
                                enabled: verify ? !!verify.enabled : false,
                                role_id: verify ? verify.verified_role_id : null,
                                verify_mode: verify ? verify.mode : null
                            };
                        }
                        return {};
                    } catch (error) {
                        logger.error('Error fetching join gate config:', error);
                        return {};
                    }
                })(),
                // "Anti-raid" is the raid lockdown auto-trigger now (migrations/325_raid_lockdown.js copied the
                // old anti_raid_config numbers onto it; nothing ever read that table). Same shape as before
                // for the Security page and the module-card checks.
                antiRaidConfig: await (async () => {
                    try {
                        const [rows] = await pool.execute(
                            `SELECT enabled, auto_lockdown_enabled, auto_lockdown_joins, auto_lockdown_window_seconds,
                                    auto_lockdown_duration_minutes, auto_lockdown_action, same_name_enabled, alert_channel_id
                               FROM raid_detection_config WHERE guild_id = ?`,
                            [guildId]
                        );
                        if (rows[0]) {
                            return {
                                enabled: !!(rows[0].auto_lockdown_enabled || rows[0].enabled || rows[0].same_name_enabled),
                                auto_lockdown: !!rows[0].auto_lockdown_enabled,
                                threshold: rows[0].auto_lockdown_joins,
                                time_period: rows[0].auto_lockdown_window_seconds,
                                duration_minutes: rows[0].auto_lockdown_duration_minutes,
                                action: rows[0].auto_lockdown_action,
                                alert_channel_id: rows[0].alert_channel_id,
                                raid_detection: !!rows[0].enabled,
                                same_name: !!rows[0].same_name_enabled
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
                                alert_channel_id: rows[0].alert_channel_id,
                                max_channel_deletes: rows[0].max_channel_deletes,
                                max_role_deletes: rows[0].max_role_deletes,
                                max_kick_bans: rows[0].max_kick_bans,
                                action_on_trigger: rows[0].action_on_trigger
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

                        // Battles fought: monster and boss fights won (per-character counters) plus PvP matches
                        // played. Combat itself is held in memory, so these counters are the durable record.
                        let battlesFought = 0;
                        try {
                            const [[battleStats]] = await pool.execute(`
                                SELECT
                                    (SELECT COALESCE(SUM(total_monsters_killed + bosses_killed), 0) FROM dnd_characters WHERE guild_id = ?)
                                  + (SELECT COALESCE(SUM(wins + losses + draws), 0) FROM dnd_pvp_stats WHERE guild_id = ?) AS battles
                            `, [guildId, guildId]);
                            battlesFought = Number(battleStats.battles) || 0;
                        } catch (err) {
                            logger.error('Error counting RPG battles:', err);
                        }

                        // Quests completed by this guild's characters (dnd_quest_log never existed)
                        let questsCompleted = 0;
                        try {
                            const [[questStats]] = await pool.execute(`
                                SELECT COUNT(*) as completed
                                FROM dnd_character_quests q
                                JOIN dnd_characters c ON c.character_id = q.character_id
                                WHERE c.guild_id = ? AND q.status = 'completed'
                            `, [guildId]);
                            questsCompleted = Number(questStats.completed) || 0;
                        } catch (err) {
                            logger.error('Error counting RPG quests:', err);
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
                        // Dates as the announcements see them: New York, with 29 February on the 28th in
                        // common years (core/birthday-helpers.js). "Next 7 days" is today and the six after.
                        const { dateIn, birthdaysOn } = await import('../core/birthday-helpers.js');
                        const today = dateIn();
                        const m = today.month;
                        const [thisMonth] = await pool.execute('SELECT COUNT(*) as count FROM user_birthdays WHERE guild_id = ? AND month = ?', [guildId, m]);
                        let upcoming = 0;
                        for (let d = 0; d < 7; d++) {
                            const at = new Date(Date.UTC(today.year, today.month - 1, today.day + d));
                            for (const b of birthdaysOn({ year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() })) {
                                const [r] = await pool.execute('SELECT COUNT(*) as c FROM user_birthdays WHERE guild_id = ? AND month = ? AND day = ?', [guildId, b.month, b.day]);
                                upcoming += r[0].c;
                            }
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
                // Channel reminders still to come (a row is deleted after its last send). DM reminders stay private.
                reminders: await (async () => {
                    try {
                        const [rows] = await pool.execute('SELECT * FROM reminders WHERE guild_id = ? AND is_dm = 0 ORDER BY remind_at ASC LIMIT 500', [guildId]);
                        return rows;
                    } catch { return []; }
                })(),
                tags: [],
                // Additional variables
                twitchScheduleSyncs: twitchScheduleSyncs,
                scheduleTemplates: scheduleTemplates,
                twitchRoleSyncConfig: twitchRoleSyncConfig,
                twitchAnalyticsData: twitchAnalyticsData,
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
                        // Kokoro voices (the second engine) get their own groups, after Piper's English ones.
                        if (voiceData.engine === 'kokoro') {
                            return {
                                value: voiceId,
                                label: `${voiceData.displayName}, ${voiceData.gender}`,
                                category: `Kokoro · ${localeCategories[voiceData.locale] || voiceData.locale}`,
                                engine: 'kokoro',
                            };
                        }
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
                rssFeeds:       await pool.execute('SELECT * FROM rss_feeds       WHERE guild_id = ? ORDER BY id DESC', [guildId]).then(r => r[0]).catch(() => []),
                commissionConfig: await pool.execute('SELECT * FROM commission_spam_config WHERE guild_id = ?', [guildId]).then(r => r[0][0] || null).catch(() => null),
                commissionGroups: COMMISSION_GROUPS,
                commissionGlobalStats: await getCommissionGlobalStats().catch(() => ({ enabledCount: 0, totalRemoved: 0 })),
                // Removal log, moderator exemptions and the pending review queue. Every removal is
                // kept with its full text so a disputed one can be checked and reversed from here.
                commissionRemovals: await pool.execute(
                    `SELECT id, user_id, channel_id, message_id, content, score, signals, via, rule, matched,
                            verdict, restored_by, restored_at, created_at
                     FROM commission_spam_decisions
                     WHERE guild_id = ? AND deleted = 1 ORDER BY id DESC LIMIT 25`, [guildId]).then(r => r[0]).catch(() => []),
                commissionPending: await pool.execute(
                    `SELECT id, user_id, channel_id, message_id, content, score, signals, created_at
                     FROM commission_spam_decisions
                     WHERE guild_id = ? AND verdict = 'pending' ORDER BY id DESC LIMIT 25`, [guildId]).then(r => r[0]).catch(() => []),
                commissionExemptions: await pool.execute(
                    `SELECT id, kind, value, note, created_by, created_at
                     FROM commission_spam_exemptions WHERE guild_id = ? ORDER BY created_at DESC LIMIT 50`,
                    [guildId]).then(r => r[0]).catch(() => []),
                commissionSignals: SOFT_SELL_SIGNALS,
                // Link policy: config, this guild's own domain rules, the queue and recent removals.
                linkConfig: await pool.execute('SELECT * FROM link_policy_config WHERE guild_id = ?', [guildId]).then(r => r[0][0] || null).catch(() => null),
                linkDomains: await pool.execute('SELECT * FROM link_policy_domains WHERE guild_id = ? ORDER BY kind, domain', [guildId]).then(r => r[0]).catch(() => []),
                linkQueue: await pool.execute(
                    "SELECT * FROM link_policy_decisions WHERE guild_id = ? AND decision = 'pending' ORDER BY id DESC LIMIT 25",
                    [guildId]).then(r => r[0]).catch(() => []),
                linkRemovals: await pool.execute(
                    "SELECT * FROM link_policy_decisions WHERE guild_id = ? AND deleted = 1 ORDER BY id DESC LIMIT 25",
                    [guildId]).then(r => r[0]).catch(() => []),
                linkDefaults: { social: SOCIAL_PLATFORMS, media: MEDIA_HOSTS, blocked: BLOCKED_HOSTS, monetisation: MONETISATION_HOSTS },
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
                            // Dropped aliases are no longer commands, and /creator and /moderation only hold
                            // moved ones, which list on their own (core/command-mounts.js).
                            if (MOUNTS[data.name]?.drop || isContainer(data.name, data.toJSON?.())) return;

                            // { type, slash, text } for one chat path; null if the bridge index is not ready.
                            const formOf = (p) => { try { return describeCommandPath(p); } catch { return null; } };
                            const entry = {
                                // `name` stays the key restriction rows are saved under; `slash` is what to show.
                                name: data.name,
                                slash: slashPath(data.name),
                                // 'slash' | 'text' | 'mixed' (core/command-registration.js) and, for a command
                                // without subcommands, how it is run.
                                type: (() => { try { return commandType(data.name, cmd); } catch { return 'slash'; } })(),
                                form: formOf(data.name),
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
                                                        form: formOf(`${data.name} ${optJson.name} ${subJson.name}`),
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
                                            form: formOf(`${data.name} ${subJson.name}`),
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
                            'SELECT * FROM guild_command_restrictions WHERE guild_id = ?',
                            [guildId]
                        );
                        const map = {};
                        const ids = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
                        rows.forEach(r => {
                            // allowed/admin_only drive the access select; the rest fills the Commands
                            // page's settings drawer (channel_id, the original single-channel lock, is
                            // shown as one of the allowed channels). Keys may be 'command:sub'.
                            map[r.command_name] = {
                                allowed: r.allowed, admin_only: r.admin_only,
                                allowed_roles: ids(r.allowed_roles), denied_roles: ids(r.denied_roles),
                                allowed_channels: [...new Set([...ids(r.allowed_channels), ...(r.channel_id ? [String(r.channel_id)] : [])])],
                                denied_channels: ids(r.denied_channels),
                                cooldown_seconds: Number(r.cooldown_seconds) || 0, cooldown_scope: r.cooldown_scope || 'user',
                                ephemeral: Number(r.ephemeral) === 1,
                                autodelete_reply_seconds: Number(r.autodelete_reply_seconds) || 0,
                                denial_message: r.denial_message || '',
                            };
                        });
                        return map;
                    } catch { return {}; }
                })(),
                forms: forms,
                ticketConfig: {},
                ticketFormsList: [],
                ticketPanels: ticketPanels,
                openTickets: openTickets,
                botMessagesData: botMessagesData,
                openModmail: openModmail,
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
                liveRoutingRules: await (async () => {
                    try {
                        const [rows] = await pool.execute(
                            'SELECT * FROM guild_live_channel_rules WHERE guild_id = ? ORDER BY priority DESC, rule_id ASC',
                            [guildId]
                        );
                        for (const row of rows) {
                            for (const col of ['role_ids', 'source_channel_ids', 'excluded_user_ids']) {
                                try { row[col] = row[col] ? JSON.parse(row[col]) : []; } catch { row[col] = []; }
                            }
                        }
                        return rows;
                    } catch { return []; }
                })(),
                // Integration-managed roles (Twitch subscriber tiers etc.) are filtered out of
                // `roles` above, so the routing picker gets its own list.
                integrationRoles: Array.from(
                    allRoles.filter(r => r.managed && r.tags?.integrationId && !r.tags?.premiumSubscriberRole).values()
                ).map(r => ({ id: r.id, name: r.name })).sort((a, b) => a.name.localeCompare(b.name)),
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
                // Language page: the catalogues we hold, plus this guild's stored
                // choice (null = follow each member's own Discord locale).
                availableLocaleMeta: allLocaleMeta(),
                guildLocale: await getStoredLocale('guild', guildId).catch(() => null),
                guildTheme: guildThemeNow,
                featureCatalog: await catalogByCategory(guildId).catch(() => new Map()),
                // Sidebar dots and overview badges: page -> 'on' | 'off' | 'none' (core/page-status.js, cached).
                pageStatus: await import('../core/page-status.js').then((m) => m.pageStatusFor(guildId)).catch(() => ({})),
                // Per-user layout. Defaults reproduce today's behaviour exactly,
                // so a user who never opens settings sees no change.
                userPrefs: await getPreferences(req.user.id).catch(() => null),
                defaultTheme: DEFAULT_THEME,
                clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID,
                ...manageSection
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
    // Per-user dashboard preferences. Not guild-scoped — these follow the person
    // across every server they administer, so they hang off checkAuth only.
    app.post('/api/me/preferences', checkAuth, async (req, res) => {
        try {
            // Surface contrast findings so the editor can warn rather than
            // silently shipping something unreadable. Computed from the SAME
            // builder that generates the CSS, so the warning can't drift from
            // what actually renders.
            let warnings = [];
            if (req.body.customTheme) {
                const check = validateCustomTheme(req.body.customTheme);
                if (check.ok) warnings = buildCustomTheme(check.theme).warnings;
            }

            const prefs = await setPreferences(req.user.id, {
                ...(req.body.dashboardLayout !== undefined ? { dashboardLayout: req.body.dashboardLayout } : {}),
                ...(req.body.compactMode !== undefined ? { compactMode: Boolean(req.body.compactMode) } : {}),
                ...(req.body.density !== undefined ? { density: req.body.density } : {}),
                ...(req.body.customTheme !== undefined ? { customTheme: req.body.customTheme } : {}),
                ...(req.body.sectionOrder !== undefined ? { sectionOrder: req.body.sectionOrder } : {}),
                ...(req.body.hiddenSections !== undefined ? { hiddenSections: req.body.hiddenSections } : {}),
                ...(req.body.theme !== undefined ? { theme: req.body.theme } : {}),
                ...(req.body.siteStyle !== undefined ? { siteStyle: req.body.siteStyle } : {}),
                // ui_options (migration 335): the server-colour switch and the overview setup
                // checklist's per-server dismissal.
                ...(req.body.serverAccent !== undefined ? { serverAccent: req.body.serverAccent === true } : {}),
                ...(req.body.hideChecklist !== undefined ? { hideChecklist: String(req.body.hideChecklist) } : {}),
                ...(req.body.showChecklist !== undefined ? { showChecklist: String(req.body.showChecklist) } : {}),
                ...(req.body.showAllChecklists === true ? { showAllChecklists: true } : {}),
            });
            return res.json({ ok: true, preferences: prefs, warnings });
        } catch (error) {
            // A bad layout value is user input, not a server fault.
            const isValidation = /Unknown layout|Unknown theme|Unknown style|Unknown density|Invalid page|Invalid server id|hex colour|section must stay/.test(error.message);
            logger[isValidation ? 'warn' : 'error']('[Dashboard] Preference save failed', { userId: req.user.id, error: error.message });
            return res.status(isValidation ? 400 : 500).json({
                error: isValidation ? error.message : 'Could not save your preferences.',
            });
        }
    });

    app.post('/api/me/pin', checkAuth, async (req, res) => {
        try {
            const pinned = await togglePin(req.user.id, String(req.body.page || ''));
            return res.json({ ok: true, pinnedPages: pinned });
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }
    });

    // The manage sidebar's server switcher: the same servers /dashboard lists for this user
    // (manageableGuildsFor), as { id, name, icon } sorted by name.
    app.get('/api/me/servers', checkAuth, async (req, res) => {
        try {
            const list = await manageableGuildsFor(req);
            const servers = list
                .filter((g) => g && g.id)
                .map((g) => ({ id: String(g.id), name: String(g.name || g.id), icon: g.icon || null }))
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
            res.set('Cache-Control', 'private, max-age=60');
            return res.json({ servers });
        } catch (error) {
            logger.error('[Dashboard] server list for the switcher failed', { userId: req.user.id, error: error.message });
            return res.status(500).json({ error: 'Could not load your servers.' });
        }
    });

    // Settings-field search (core/settings-index.js): field labels -> page + element id, built from
    // the templates and rebuilt when the view engine reloads. Same for every server; the page's
    // ?v= (the view generation) makes a reload fetch a fresh copy.
    app.get('/api/settings-index', checkAuth, async (req, res) => {
        try {
            const [{ getSettingsIndex }, { buildManageNav }, specModule] = await Promise.all([
                import('../core/settings-index.js'),
                import('../core/manage-nav.js'),
                import('../core/feature-config-spec.js'),
            ]);
            const generation = views.stats().generation;
            const nav = buildManageNav(specModule.FEATURE_SPECS);
            const index = getSettingsIndex({ viewsDir, nav, specs: specModule.FEATURE_SPECS, generation });
            const titles = {};
            for (const sec of nav) for (const it of sec.items) if (index[it.page]) titles[it.page] = it.title;
            res.set('Cache-Control', 'private, max-age=3600');
            return res.json({ generation, pages: index, titles });
        } catch (error) {
            logger.error('[Dashboard] settings index failed', { error: error.message });
            return res.status(500).json({ error: 'Could not build the settings index.' });
        }
    });

    // Per-guild embed theme. Slots are semantic (success/danger/...) rather than
    // colours, so a call site never has to know which guild it is rendering for.
    app.post('/manage/:guildId/theme', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        try {
            if (req.body?.reset) {
                await resetTheme(guildId);
                return res.json({ ok: true, theme: DEFAULT_THEME, message: 'Theme reset to defaults.' });
            }

            const updates = {};
            for (const slot of THEME_SLOTS) {
                if (slot in req.body) updates[slot] = req.body[slot] || null;
            }
            for (const key of ['footerText', 'footerIconUrl', 'thumbnailUrl']) {
                if (key in req.body) updates[key] = req.body[key] || null;
            }
            if ('enabled' in req.body) updates.enabled = req.body.enabled === true || req.body.enabled === 1 || req.body.enabled === '1' || req.body.enabled === 'on';
            if (updates.footerText) updates.footerText = String(updates.footerText).slice(0, 2048);
            for (const key of ['footerIconUrl', 'thumbnailUrl']) {
                if (updates[key] && (!/^https?:\/\/\S+$/i.test(String(updates[key])) || String(updates[key]).length > 512)) {
                    return res.status(400).json({ error: 'Image links must start with http:// or https:// and be at most 512 characters.' });
                }
            }

            const theme = await setTheme(guildId, updates, req.user.id);
            return res.json({ ok: true, theme, message: 'Theme saved.' });
        } catch (error) {
            // setTheme throws on a malformed hex — that is a user input problem,
            // not a server fault, so surface the message rather than a generic 500.
            const isValidation = /hex colour/i.test(error.message);
            logger[isValidation ? 'warn' : 'error']('[Dashboard] Theme save failed', { guildId, error: error.message });
            return res.status(isValidation ? 400 : 500).json({
                error: isValidation ? error.message : 'Could not save the theme.',
            });
        }
    });

    // Theme page "Send test": one embed per colour slot, in the saved theme (the defaults when the
    // theme is switched off), posted by the bot that serves this server.
    app.post('/manage/:guildId/theme/test', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        try {
            const channelId = String(req.body?.channel_id || '');
            const botClient = global.botManager?.getClientForGuild?.(guildId) || client;
            const g = botClient?.guilds?.cache?.get(guildId);
            const channel = /^\d{17,20}$/.test(channelId) ? g?.channels?.cache?.get(channelId) : null;
            if (!g || !channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased() || channel.isVoiceBased?.()) {
                return res.status(400).json({ error: 'Pick a text channel in this server.' });
            }
            const perms = g.members.me ? channel.permissionsFor(g.members.me) : null;
            if (!perms || !perms.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks])) {
                return res.status(400).json({ error: `The bot cannot post embeds in #${channel.name}.` });
            }
            const saved = await getTheme(guildId);
            const t = saved.enabled === false ? { ...DEFAULT_THEME } : saved;
            const labels = { primary: 'Primary: most messages', success: 'Success: something worked', danger: 'Danger: something failed or was removed', warning: 'Warning: needs attention', info: 'Info: secondary information', accent: 'Accent: highlights' };
            const embeds = THEME_SLOTS.map((slot) => {
                const e = new EmbedBuilder().setColor(t[slot] || DEFAULT_THEME[slot]).setDescription(labels[slot] || slot);
                if (t.footerText) e.setFooter({ text: String(t.footerText).slice(0, 2048), ...(t.footerIconUrl ? { iconURL: t.footerIconUrl } : {}) });
                return e;
            });
            embeds[0].setTitle('Theme test');
            await channel.send({ embeds, allowedMentions: { parse: [] } });
            return res.json({ ok: true, message: `Sent to #${channel.name}.` });
        } catch (error) {
            logger.warn('[Dashboard] Theme test failed', { guildId, error: error.message });
            return res.status(500).json({ error: 'Could not send the test message.' });
        }
    });

    // Server default language. Members can still override for themselves with
    // /settings language, so this writes the guild default only.
    app.post('/manage/:guildId/language', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const requested = String(req.body?.locale ?? '').trim();

        try {
            if (requested === '') {
                await setLocale('guild', guildId, null);
                return res.json({ ok: true, locale: null, message: "Cleared — members will follow their own Discord language." });
            }

            if (!isSupportedLocale(requested)) {
                return res.status(400).json({ error: `"${requested}" is not an available language.` });
            }

            const saved = await setLocale('guild', guildId, requested, req.user.id);
            const meta = localeMeta(saved);
            return res.json({ ok: true, locale: saved, message: `Server language set to ${meta?.nativeName ?? saved}.` });
        } catch (error) {
            logger.error('[Dashboard] Failed to set guild language', { guildId, requested, error: error.message });
            return res.status(500).json({ error: 'Could not save the language setting.' });
        }
    });

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
            // 'female'/'male' were placeholders, not voices (the DJ fell back to Amy); 'amy' is the default voice.
            const voice = String(djVoice || '').trim().slice(0, 255);
            const djVoiceValue = !voice || voice === 'female' || voice === 'male' ? 'amy' : voice;

            await pool.execute(`
                INSERT INTO music_config (guild_id, dj_voice)
                VALUES (?, ?)
                ON DUPLICATE KEY UPDATE dj_voice = VALUES(dj_voice)
            `, [guildId, djVoiceValue]);

            // The one AI DJ switch (H-667): /music dj, the panel and the AI DJ page all read ai_dj_config.enabled.
            await pool.execute(`
                INSERT INTO ai_dj_config (guild_id, enabled)
                VALUES (?, ?)
                ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)
            `, [guildId, isEnabled]);

            logger.info(`[DJ Config] Saved to DB: djEnabled=${isEnabled}, djVoice=${djVoiceValue}`);
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
                // 1-100, as the page and /music settings voteskip allow.
                Math.min(100, Math.max(1, parseInt(voteSkipPercentage, 10) || 50))
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
            // Only known filter names are stored (core/music-filters.js); none ticked = every filter allowed.
            const { normaliseFilterSubmission } = await import('../core/music-filters.js');
            const filtersJson = normaliseFilterSubmission(req.body['filters[]'] || req.body.filters || []);

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
            const lvl = parseInt(level, 10);
            const roleGuild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
            if (!Number.isInteger(lvl) || lvl < 1 || lvl > 1000 || !/^\d{15,25}$/.test(String(role_id || ''))
                || (roleGuild && !roleGuild.roles.cache.has(String(role_id)))) {
                return res.redirect(`/manage/${guildId}?page=leveling&error=missing_fields`);
            }
            await pool.execute('INSERT INTO level_role_rewards (guild_id, level, role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)', [guildId, lvl, String(role_id)]);
            res.redirect(`/manage/${guildId}?page=leveling&success=created`);
        } catch (error) { logger.error('[LevelReward] Error:', error.message); res.redirect(`/manage/${guildId}?page=leveling&error=failed`); }
    });

    app.post('/manage/:guildId/remove-role-reward', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { level, rewardId } = req.body;
            if (rewardId !== undefined && rewardId !== '') {
                await pool.execute('DELETE FROM level_role_rewards WHERE guild_id = ? AND id = ?', [guildId, parseInt(rewardId, 10) || 0]);
            } else {
                await pool.execute('DELETE FROM level_role_rewards WHERE guild_id = ? AND level = ?', [guildId, parseInt(level, 10) || 0]);
            }
            res.redirect(`/manage/${guildId}?page=leveling&success=deleted`);
        } catch (error) { logger.error('[LevelReward] Error:', error.message); res.redirect(`/manage/${guildId}?page=leveling&error=failed`); }
    });

    // --- Tags ---
    app.post('/manage/:guildId/delete-tag', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            // The Tags page posts the row id as tagId.
            const { tagId } = req.body;
            await pool.execute('DELETE FROM tags WHERE guild_id = ? AND id = ?', [guildId, tagId]);
            res.redirect(`/manage/${guildId}?page=tags&success=deleted`);
        } catch (error) { logger.error('[Tags] Error:', error.message); res.redirect(`/manage/${guildId}?page=tags&error=failed`); }
    });

    // --- Permissions ---
    // Overrides live on guild_command_restrictions' role/channel lists, which core/command-restrictions.js
    // enforces for slash and prefix commands (bot_permissions was never read by anything).
    // Command keys are 'command' or 'command:subcommand', the same keys the restrictions module looks up.
    const normaliseCommandKey = (name) => String(name || '').trim().toLowerCase()
        .replace(/^\//, '').split(/[\s:]+/).filter(Boolean).slice(0, 2).join(':');

    async function editOverrideList(guildId, command, column, target, add) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const [[row]] = await conn.execute(
                `SELECT ${column} AS list FROM guild_command_restrictions WHERE guild_id = ? AND command_name = ? FOR UPDATE`,
                [guildId, command]);
            let list = [];
            try { list = row?.list ? JSON.parse(row.list) : []; } catch { list = []; }
            if (!Array.isArray(list)) list = [];
            list = add ? [...new Set([...list.map(String), target])] : list.map(String).filter((id) => id !== target);
            if (row) {
                await conn.execute(
                    `UPDATE guild_command_restrictions SET ${column} = ? WHERE guild_id = ? AND command_name = ?`,
                    [list.length ? JSON.stringify(list) : null, guildId, command]);
            } else if (add) {
                await conn.execute(
                    `INSERT INTO guild_command_restrictions (guild_id, command_name, allowed, admin_only, ${column}) VALUES (?, ?, 1, 0, ?)`,
                    [guildId, command, JSON.stringify(list)]);
            }
            await conn.commit();
        } catch (err) {
            await conn.rollback().catch(() => {});
            throw err;
        } finally {
            conn.release();
        }
        invalidateCommandRestriction(guildId, command);
    }

    app.post('/manage/:guildId/create-permission-override', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { command_name, type, role_id, channel_id, allowed } = req.body;
            const command = normaliseCommandKey(command_name);
            const target = type === 'channel' ? channel_id : role_id;
            if (!command || !['role', 'channel'].includes(type) || !/^\d{5,25}$/.test(target || '')) {
                return res.redirect(`/manage/${guildId}?page=permissions&error=missing_fields`);
            }
            // The form sends "true"/"false" strings.
            await editOverrideList(guildId, command, overrideColumn(type, allowed === 'true'), String(target), true);
            res.redirect(`/manage/${guildId}?page=permissions&success=created`);
        } catch (error) { logger.error('[Permissions] Error:', error.message); res.redirect(`/manage/${guildId}?page=permissions&error=failed`); }
    });

    app.post('/manage/:guildId/delete-permission-override', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const parsed = parseOverrideId(req.body.overrideId);
            if (!parsed) return res.redirect(`/manage/${guildId}?page=permissions&error=missing_fields`);
            await editOverrideList(guildId, parsed.command, overrideColumn(parsed.type, parsed.allowed), parsed.target, false);
            res.redirect(`/manage/${guildId}?page=permissions&success=deleted`);
        } catch (error) { logger.error('[Permissions] Error:', error.message); res.redirect(`/manage/${guildId}?page=permissions&error=failed`); }
    });

    // --- Reminders ---
    app.post('/manage/:guildId/create-reminder', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            // The form sends a delay like "30m", "2h", "1d" or "1w" in `when`, and optionally
            // `repeat` (seconds between sends) and `repeat_count` (sends in all; empty = until deleted).
            const { channel_id, message, when, repeat, repeat_count } = req.body;
            const m = String(when || '').trim().toLowerCase().match(/^(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/);
            const unitMs = m && { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[m[2][0]];
            const delayMs = m ? Number(m[1]) * unitMs : 0;
            const guild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId) || req.guildObject || null;
            const channel = guild && /^\d{17,20}$/.test(String(channel_id || '')) ? guild.channels.cache.get(String(channel_id)) : null;
            if (!channel || !channel.isTextBased?.() || !String(message || '').trim() || !delayMs || delayMs > 365 * 86400e3) {
                return res.redirect(`/manage/${guildId}?page=reminders&error=missing_fields`);
            }
            const REPEATS = new Set([3600, 86400, 604800, 1209600, 2419200]);
            const interval = REPEATS.has(Number(repeat)) ? Number(repeat) : null;
            let count = null;
            if (interval) {
                const n = Number.parseInt(repeat_count, 10);
                count = String(repeat_count ?? '').trim() === '' ? -1 : n;
                if (!Number.isInteger(count) || (count !== -1 && (count < 2 || count > 1000))) {
                    return res.redirect(`/manage/${guildId}?page=reminders&error=repeat_times_must_be_2_to_1000`);
                }
            }
            const remindAt = new Date(Date.now() + delayMs);
            await pool.execute(
                `INSERT INTO reminders (user_id, guild_id, channel_id, is_dm, remind_at, message, recurring_interval, recurring_count, next_occurrence, occurrences_sent)
                 VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 0)`,
                [req.user.id, guildId, channel.id, remindAt, String(message).slice(0, 2000), interval, count, interval ? remindAt : null]);
            res.redirect(`/manage/${guildId}?page=reminders&success=created`);
        } catch (error) { logger.error('[Reminders] Error:', error.message); res.redirect(`/manage/${guildId}?page=reminders&error=failed`); }
    });

    app.post('/manage/:guildId/delete-reminder', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { reminderId } = req.body;   // the Reminders page posts reminderId
            await pool.execute('DELETE FROM reminders WHERE guild_id = ? AND id = ?', [guildId, reminderId]);
            res.redirect(`/manage/${guildId}?page=reminders&success=deleted`);
        } catch (error) { logger.error('[Reminders] Error:', error.message); res.redirect(`/manage/${guildId}?page=reminders&error=failed`); }
    });

    // --- Tickets ---
    app.post('/manage/:guildId/create-ticket-panel', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            // "Deploy Ticket Panel" on the Tickets page: post the open-a-ticket button for the guild's
            // ticket_config to its panel channel. The plain `ticket_create` button is handled by
            // interactions/buttons/ticket_create.js, which falls back to ticket_config when no panel id is given.
            const [[config]] = await pool.execute(
                'SELECT panel_channel_id, panel_message_id, ticket_category_id FROM ticket_config WHERE guild_id = ?', [guildId]);
            if (!config?.panel_channel_id || !config?.ticket_category_id) {
                return res.redirect(`/manage/${guildId}?page=tickets&error=missing_fields`);
            }
            const channel = await client.channels.fetch(config.panel_channel_id).catch(() => null);
            if (!channel?.isTextBased?.() || String(channel.guildId) !== String(guildId)) {
                return res.redirect(`/manage/${guildId}?page=tickets&error=channel_not_found`);
            }
            // Replace a previously deployed panel instead of stacking duplicates.
            if (config.panel_message_id) {
                await channel.messages.delete(config.panel_message_id).catch(() => {});
            }
            const embed = new EmbedBuilder()
                .setColor(0xa78bfa)
                .setTitle('Support Ticket')
                .setDescription('Click the button below to open a private support ticket. Our team will be with you shortly.');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('ticket_create').setLabel('Create Ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary));
            const message = await channel.send({ embeds: [embed], components: [row] });
            await pool.execute('UPDATE ticket_config SET panel_message_id = ? WHERE guild_id = ?', [message.id, guildId]);
            res.redirect(`/manage/${guildId}?page=tickets&success=created`);
        } catch (error) { logger.error('[Tickets] Error:', error.message); res.redirect(`/manage/${guildId}?page=tickets&error=failed`); }
    });

    // --- Economy Shop ---
    // Fields as the Economy page's add/edit forms post them, mapped onto shop_items' columns.
    const SHOP_ITEM_TYPES = ['role', 'consumable', 'collectible', 'tool', 'decoration'];
    function shopItemFromForm(body) {
        const stock = String(body.stock ?? '').trim();
        const role = /^\d{5,25}$/.test(body.role_id || '') ? body.role_id : null;
        const type = SHOP_ITEM_TYPES.includes(body.item_type) ? body.item_type : 'decoration';
        return {
            name: String(body.item_name || '').trim().slice(0, 100),
            description: String(body.item_description || '').trim() || null,
            emoji: String(body.item_emoji || '').trim().slice(0, 100) || null,
            type,
            price: Math.max(0, parseInt(body.price, 10) || 0),
            stock: stock === '' ? -1 : Math.max(0, parseInt(stock, 10) || 0),
            roleId: type === 'role' ? role : null,
            usable: body.usable ? 1 : 0,
            tradeable: body.tradeable ? 1 : 0,
            sellable: body.sellable ? 1 : 0,
            sellValue: body.sellable ? Math.max(0, parseInt(body.sell_value, 10) || 0) : 0,
            // "Per member" on the Economy page: blank = no limit (-1, what core/shop-manager.js treats as none).
            maxPerUser: String(body.max_per_user ?? '').trim() === '' ? -1 : Math.min(1000000, Math.max(1, parseInt(body.max_per_user, 10) || 1)),
        };
    }
    // A role item must name a role in this server (when the bot can see the server).
    function shopRoleProblem(guildId, roleId) {
        if (!roleId) return null;
        const g = global.botManager?.getClientForGuild?.(guildId)?.guilds?.cache?.get(guildId);
        if (g && !g.roles.cache.has(roleId)) return 'invalid_role';
        return null;
    }

    app.post('/manage/:guildId/economy/shop/add', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const item = shopItemFromForm(req.body);
            if (!item.name || req.body.price === undefined || req.body.price === '' || (item.type === 'role' && !item.roleId)) {
                return res.redirect(`/manage/${guildId}?page=economy&error=missing_fields`);
            }
            const addRoleProblem = shopRoleProblem(guildId, item.roleId);
            if (addRoleProblem) return res.redirect(`/manage/${guildId}?page=economy&error=${addRoleProblem}`);
            await pool.execute(
                `INSERT INTO shop_items (guild_id, item_name, item_description, item_emoji, item_type, price, stock,
                                         role_id, usable, tradeable, sellable, sell_value, max_per_user)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [guildId, item.name, item.description, item.emoji, item.type, item.price, item.stock,
                    item.roleId, item.usable, item.tradeable, item.sellable, item.sellValue, item.maxPerUser]);
            res.redirect(`/manage/${guildId}?page=economy&success=created`);
        } catch (error) { logger.error('[Economy] Error:', error.message); res.redirect(`/manage/${guildId}?page=economy&error=failed`); }
    });

    app.post('/manage/:guildId/economy/shop/edit', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const item = shopItemFromForm(req.body);
            if (!item.name || (item.type === 'role' && !item.roleId)) {
                return res.redirect(`/manage/${guildId}?page=economy&error=missing_fields`);
            }
            const editRoleProblem = shopRoleProblem(guildId, item.roleId);
            if (editRoleProblem) return res.redirect(`/manage/${guildId}?page=economy&error=${editRoleProblem}`);
            await pool.execute(
                `UPDATE shop_items SET item_name = ?, item_description = ?, item_emoji = ?, item_type = ?, price = ?, stock = ?,
                                       role_id = ?, usable = ?, tradeable = ?, sellable = ?, sell_value = ?
                 WHERE guild_id = ? AND id = ?`,
                [item.name, item.description, item.emoji, item.type, item.price, item.stock,
                    item.roleId, item.usable, item.tradeable, item.sellable, item.sellValue, guildId, req.body.item_id]);
            // Fields the 2026-11-18 edit dialog added; an older form that does not send them leaves them alone.
            if (req.body.max_per_user !== undefined) {
                await pool.execute('UPDATE shop_items SET max_per_user = ? WHERE guild_id = ? AND id = ?', [item.maxPerUser, guildId, req.body.item_id]);
            }
            if (req.body.has_active) {
                await pool.execute('UPDATE shop_items SET is_active = ? WHERE guild_id = ? AND id = ?', [req.body.is_active ? 1 : 0, guildId, req.body.item_id]);
            }
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

    // --- RPG play channel --- (same setting as /rpg settings channel; setRPGChannel keeps the bot's cache in step)
    app.post('/manage/:guildId/rpg/channel', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const raw = String(req.body.channel_id || '').trim();
            let channelId = null;
            if (raw) {
                const g = global.botManager?.getClientForGuild?.(guildId)?.guilds?.cache?.get(guildId);
                const ch = /^\d{15,25}$/.test(raw) ? g?.channels?.cache?.get(raw) : null;
                if (!/^\d{15,25}$/.test(raw) || (g && (!ch || !ch.isTextBased?.()))) {
                    return res.redirect(`/manage/${guildId}?page=rpg&error=invalid_channel`);
                }
                channelId = raw;
            }
            const { setRPGChannel } = await import('../core/rpg-reply-handler.js');
            const ok = await setRPGChannel(guildId, channelId);
            res.redirect(`/manage/${guildId}?page=rpg&${ok ? 'success=saved' : 'error=failed'}`);
        } catch (error) { logger.error('[RPG] Error saving the play channel:', error.message); res.redirect(`/manage/${guildId}?page=rpg&error=failed`); }
    });

    // --- Gambling ---
    app.post('/manage/:guildId/gambling/config', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { enabled, min_bet, max_bet, cooldown } = req.body;
            // house_edge is not read by any game, so the page no longer sends it and it is left alone here.
            const minBet = Math.max(1, parseInt(min_bet, 10) || 10);
            const maxBet = Math.max(minBet, parseInt(max_bet, 10) || 10000);
            await pool.execute('INSERT INTO gambling_config (guild_id, enabled, min_bet, max_bet) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), min_bet = VALUES(min_bet), max_bet = VALUES(max_bet)', [guildId, enabled ? 1 : 0, minBet, maxBet]);
            // "Wait between games", enforced by core/gambling-manager.js validateBet.
            if (cooldown !== undefined && String(cooldown).trim() !== '') {
                const cd = Math.min(3600, Math.max(0, parseInt(cooldown, 10) || 0));
                await pool.execute('UPDATE gambling_config SET cooldown_seconds = ? WHERE guild_id = ?', [cd, guildId]);
            }
            res.redirect(`/manage/${guildId}?page=gambling&success=saved`);
        } catch (error) { logger.error('[Gambling] Error:', error.message); res.redirect(`/manage/${guildId}?page=gambling&error=failed`); }
    });

    // --- Stat Roles ---
    // Validated + saved by core/statrole-manager.js (form posts configs[i][role_id|stat_type|required_amount|remove_below]);
    // a background sweep applies new rules immediately.
    app.post('/manage/:guildId/stat-roles/update', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { replaceGuildRules } = await import('../core/statrole-manager.js');
            const { errors } = await replaceGuildRules(guildId, req.body.configs, { guild: req.guildObject });
            if (errors.length) {
                logger.warn('[StatRoles] Rejected stat role save', { guildId, errors });
                return res.redirect(`/manage/${guildId}?page=stat-roles&error=${encodeURIComponent(errors[0])}`);
            }
            res.redirect(`/manage/${guildId}?page=stat-roles&success=saved`);
        } catch (error) {
            logger.error('[StatRoles] Error saving stat roles', { guildId, error: error.message });
            res.redirect(`/manage/${guildId}?page=stat-roles&error=failed`);
        }
    });

    // --- Suggestions ---
    app.post('/manage/:guildId/suggestions/approve', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { suggestion_id } = req.body;
            // Same path as the review card and /engage suggest approve: a held suggestion is posted for voting now.
            const { decideFromDashboard } = await import('../core/suggestion-review.js');
            const result = await decideFromDashboard({ guildId, suggestionId: Number(suggestion_id), reviewerId: req.user.id, decision: 'approved' });
            if (!result.ok) logger.warn('[Suggestions] Dashboard approve failed', { guildId, suggestion_id, error: result.error });
            res.redirect(`/manage/${guildId}?page=suggestions&${result.ok ? 'success=updated' : 'error=failed'}`);
        } catch (error) { res.redirect(`/manage/${guildId}?page=suggestions&error=failed`); }
    });

    app.post('/manage/:guildId/suggestions/reject', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { suggestion_id } = req.body;
            const { decideFromDashboard } = await import('../core/suggestion-review.js');
            const result = await decideFromDashboard({ guildId, suggestionId: Number(suggestion_id), reviewerId: req.user.id, decision: 'rejected' });
            res.redirect(`/manage/${guildId}?page=suggestions&${result.ok ? 'success=updated' : 'error=failed'}`);
        } catch (error) { res.redirect(`/manage/${guildId}?page=suggestions&error=failed`); }
    });

    // --- Mass Actions ---
    // The forms in views/partials/manage/mass.ejs post camelCase `roleId` plus a
    // comma/newline-separated `userIds` textarea. Older callers used snake_case, so accept both.
    const massRoleId = (body) => String(body?.roleId || body?.role_id || '').trim();
    const massUserIds = (body) => {
        const tokens = String(body?.userIds ?? body?.user_ids ?? '').split(/[\s,]+/).filter(Boolean);
        const valid = tokens.filter(t => /^\d{17,20}$/.test(t));
        return { valid, invalid: tokens.length - valid.length };
    };
    // X-Audit-Log-Reason is ASCII-only — anything else makes Discord reject the whole request.
    const massReason = (reason, fallback) => {
        const clean = String(reason || '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 400);
        return clean || fallback;
    };
    const massResolveMembers = async (guild, ids) => {
        const members = [];
        const notFound = [];
        for (const id of ids) {
            const member = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
            if (member) members.push(member); else notFound.push(id);
        }
        return { members, notFound };
    };

    app.post('/manage/:guildId/mass-assign-role', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const back = (params) => res.redirect(`/manage/${guildId}?page=mass&${params}`);
        try {
            const roleId = massRoleId(req.body);
            const { valid: userIds, invalid } = massUserIds(req.body);
            const targetRoleId = String(req.body.target_role_id || req.body.targetRoleId || '').trim();
            if (!roleId) return back('error=no_role_selected');
            // Explicit user IDs, or an explicit target-role filter, are the only two ways to name
            // recipients. Neither one present would mean "every member in the guild" — never intended.
            if (!userIds.length && !targetRoleId) return back(invalid ? 'error=no_valid_user_ids' : 'error=no_user_ids_given');

            const botClient = global.botManager?.getClientForGuild(guildId) || req.app.locals.client;
            const guild = botClient?.guilds?.cache?.get(guildId);
            if (!guild) return back('error=guild_not_found');
            const role = guild.roles.cache.get(roleId);
            if (!role) return back('error=role_not_found');
            if (!role.editable) return back('error=role_is_above_the_bot');

            let members;
            let notFound = [];
            if (userIds.length) {
                ({ members, notFound } = await massResolveMembers(guild, userIds));
            } else {
                await guild.members.fetch();
                members = [...guild.members.cache.values()].filter(m => m.roles.cache.has(targetRoleId));
            }

            let count = 0, failed = 0, alreadyHad = 0;
            const reason = massReason(req.body.reason, 'Mass assign via dashboard');
            for (const member of members) {
                if (member.roles.cache.has(role.id)) { alreadyHad++; continue; }
                try { await member.roles.add(role, reason); count++; }
                catch (err) { failed++; logger.warn(`[MassAction] Assign failed for ${member.id}: ${err.message}`); }
            }
            logger.info(`[MassAction] Assigned role ${role.name} to ${count} members in ${guild.name} (already had: ${alreadyHad}, failed: ${failed}, not in guild: ${notFound.length}, invalid ids: ${invalid})`);
            if (!count && failed) return back('error=every_assignment_failed');
            if (!count && !alreadyHad) return back('error=no_matching_members_found');
            return back('success=created');
        } catch (error) { logger.error('[MassAction] Error:', error.message); return back('error=failed'); }
    });

    app.post('/manage/:guildId/mass-remove-role', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const back = (params) => res.redirect(`/manage/${guildId}?page=mass&${params}`);
        try {
            const roleId = massRoleId(req.body);
            const { valid: userIds, invalid } = massUserIds(req.body);
            if (!roleId) return back('error=no_role_selected');
            if (invalid && !userIds.length) return back('error=no_valid_user_ids');

            const botClient = global.botManager?.getClientForGuild(guildId) || req.app.locals.client;
            const guild = botClient?.guilds?.cache?.get(guildId);
            if (!guild) return back('error=guild_not_found');
            const role = guild.roles.cache.get(roleId);
            if (!role) return back('error=role_not_found');
            if (!role.editable) return back('error=role_is_above_the_bot');

            // No IDs given here is a coherent request: strip the role from everyone who has it.
            let members, notFound = [];
            if (userIds.length) {
                ({ members, notFound } = await massResolveMembers(guild, userIds));
            } else {
                await guild.members.fetch();
                members = [...role.members.values()];
            }

            let count = 0, failed = 0, didNotHave = 0;
            const reason = massReason(req.body.reason, 'Mass remove via dashboard');
            for (const member of members) {
                if (!member.roles.cache.has(role.id)) { didNotHave++; continue; }
                try { await member.roles.remove(role, reason); count++; }
                catch (err) { failed++; logger.warn(`[MassAction] Remove failed for ${member.id}: ${err.message}`); }
            }
            logger.info(`[MassAction] Removed role ${role.name} from ${count} members in ${guild.name} (didn't have it: ${didNotHave}, failed: ${failed}, not in guild: ${notFound.length}, invalid ids: ${invalid})`);
            if (!count && failed) return back('error=every_removal_failed');
            if (!count && !didNotHave) return back('error=no_matching_members_found');
            return back('success=deleted');
        } catch (error) { logger.error('[MassAction] Error:', error.message); return back('error=failed'); }
    });

    app.post('/manage/:guildId/mass-kick', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const back = (params) => res.redirect(`/manage/${guildId}?page=mass&${params}`);
        try {
            const roleId = massRoleId(req.body);
            const { valid: userIds, invalid } = massUserIds(req.body);
            // The form names targets by ID; role_id is the older API shape. One of the two is required.
            if (!userIds.length && !roleId) return back(invalid ? 'error=no_valid_user_ids' : 'error=no_user_ids_given');

            const botClient = global.botManager?.getClientForGuild(guildId) || req.app.locals.client;
            const guild = botClient?.guilds?.cache?.get(guildId);
            if (!guild) return back('error=guild_not_found');

            let members, notFound = [];
            if (userIds.length) {
                ({ members, notFound } = await massResolveMembers(guild, userIds));
            } else {
                const role = guild.roles.cache.get(roleId);
                if (!role) return back('error=role_not_found');
                await guild.members.fetch();
                members = [...role.members.values()];
            }

            let count = 0, failed = 0, notKickable = 0;
            const reason = massReason(req.body.reason, 'Mass kick via dashboard');
            for (const member of members) {
                if (!member.kickable) { notKickable++; continue; }
                try { await member.kick(reason); count++; }
                catch (err) { failed++; logger.warn(`[MassAction] Kick failed for ${member.id}: ${err.message}`); }
            }
            logger.info(`[MassAction] Kicked ${count} members in ${guild.name} (not kickable: ${notKickable}, failed: ${failed}, not in guild: ${notFound.length}, invalid ids: ${invalid})`);
            if (count) {
                void logFeatureEvent(() => (guild), 'moderation.kick', () => ({
                    title: '👢 Members Kicked (Mass Action)',
                    fields: [['Kicked', count], ['Not kickable', notKickable || null], ['Failed', failed || null],
                        ['Not in server', notFound.length || null], ['Moderator', userLabel(req.user)], ['Where', 'Web dashboard'],
                        ['Reason', reason, false]],
                }));
            }
            if (!count) return back(notKickable ? 'error=those_members_are_above_the_bot' : 'error=no_members_kicked');
            return back('success=deleted');
        } catch (error) { logger.error('[MassAction] Error:', error.message); return back('error=failed'); }
    });

    app.post('/manage/:guildId/mass-ban', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const back = (params) => res.redirect(`/manage/${guildId}?page=mass&${params}`);
        try {
            const roleId = massRoleId(req.body);
            const { valid: userIds, invalid } = massUserIds(req.body);
            const deleteDays = Math.min(7, Math.max(0, parseInt(req.body.deleteMessageDays, 10) || 0));
            if (!userIds.length && !roleId) return back(invalid ? 'error=no_valid_user_ids' : 'error=no_user_ids_given');

            const botClient = global.botManager?.getClientForGuild(guildId) || req.app.locals.client;
            const guild = botClient?.guilds?.cache?.get(guildId);
            if (!guild) return back('error=guild_not_found');

            let members, notFound = [];
            if (userIds.length) {
                ({ members, notFound } = await massResolveMembers(guild, userIds));
            } else {
                const role = guild.roles.cache.get(roleId);
                if (!role) return back('error=role_not_found');
                await guild.members.fetch();
                members = [...role.members.values()];
            }

            let count = 0, failed = 0, notBannable = 0;
            const reason = massReason(req.body.reason, 'Mass ban via dashboard');
            for (const member of members) {
                if (!member.bannable) { notBannable++; continue; }
                try { await member.ban({ reason, deleteMessageSeconds: deleteDays * 86400 }); count++; }
                catch (err) { failed++; logger.warn(`[MassAction] Ban failed for ${member.id}: ${err.message}`); }
            }
            // IDs of people who already left are banned by ID, as the page says (core/mass-moderation.js).
            const { banAbsentIds } = await import('../core/mass-moderation.js');
            const absent = await banAbsentIds(guild, notFound, { reason, deleteMessageSeconds: deleteDays * 86400 });
            count += absent.banned;
            failed += absent.failed;
            logger.info(`[MassAction] Banned ${count} in ${guild.name} (of them not in guild: ${absent.banned}, not bannable: ${notBannable}, failed: ${failed}, invalid ids: ${invalid})`);
            if (count) {
                void logFeatureEvent(() => (guild), 'moderation.ban', () => ({
                    title: '🔨 Members Banned (Mass Action)',
                    fields: [['Banned', count], ['Not bannable', notBannable || null], ['Failed', failed || null],
                        ['Banned by ID (not in the server)', absent.banned || null], ['Messages deleted', deleteDays ? `${deleteDays} day(s)` : null],
                        ['Moderator', userLabel(req.user)], ['Where', 'Web dashboard'], ['Reason', reason, false]],
                }));
            }
            if (!count) return back(notBannable ? 'error=those_members_are_above_the_bot' : 'error=no_members_banned');
            return back('success=deleted');
        } catch (error) { logger.error('[MassAction] Error:', error.message); return back('error=failed'); }
    });

    // Self-assignable "Ranks" routes (table joinable_ranks) removed 2026-11-18: no page posted to them.

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
            // The Music page's "Playlist limits" form; enforced by handlers/music/playlist.js.
            // An empty field saves NULL, which is "no limit" there (H-667: the page used to show 10/100 for NULL).
            const clamp = (v, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
            const blank = (v) => String(v ?? '').trim() === '';
            const maxPlaylists = blank(req.body.maxPlaylists) ? null : clamp(req.body.maxPlaylists, 1, 50);
            const maxSongs = blank(req.body.maxSongsPerPlaylist) ? null : clamp(req.body.maxSongsPerPlaylist, 10, 1000);
            if ((!blank(req.body.maxPlaylists) && maxPlaylists === null) || (!blank(req.body.maxSongsPerPlaylist) && maxSongs === null)) {
                return res.redirect(`/manage/${guildId}?page=music&error=missing_fields`);
            }
            await pool.execute(
                `INSERT INTO music_config (guild_id, max_playlists_per_user, max_songs_per_playlist) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE max_playlists_per_user = VALUES(max_playlists_per_user),
                                         max_songs_per_playlist = VALUES(max_songs_per_playlist)`,
                [guildId, maxPlaylists, maxSongs]);
            invalidateMusicConfigCache(guildId);
            res.redirect(`/manage/${guildId}?page=music&success=updated`);
        } catch (error) { logger.error('[Music] Error:', error.message); res.redirect(`/manage/${guildId}?page=music&error=failed`); }
    });

    // --- Import ---
    // CSV import of streamers (partials/manage/csv.ejs). One row per streamer: platform + username,
    // optionally discord_user_id, announcement_channel_id, live_role_id and custom_message. The
    // export's own headers (Streamer Name, Platform, Channel ID, Role ID, Message, Discord User ID)
    // are accepted too, so an exported file imports back unchanged. Each row goes through the same
    // identity resolution as add-streamer; existing subscriptions get the channel/role/message from
    // the file where the file has one. The page posts with fetch and gets JSON; a plain form post
    // is redirected back with a summary.
    app.post('/manage/:guildId/import-csv', checkAuth, checkGuildAdmin, upload.single('csvFile'), handleMulterError, async (req, res) => {
        const guildId = req.params.guildId;
        const wantsJson = req.get('X-Requested-With') === 'XMLHttpRequest';
        const fail = (code, message) => wantsJson
            ? res.status(400).json({ success: false, error: message })
            : res.redirect(`/manage/${guildId}?page=csv&error=${code}`);
        try {
            if (!req.file || !req.file.buffer || !req.file.buffer.length) return fail('no_file', 'Choose a CSV file first.');
            if (req.file.size > 1024 * 1024) return fail('file_too_large', 'The file is larger than 1 MB.');
            const text = req.file.buffer.toString('utf8').replace(/^﻿/, '');
            // RFC 4180: quoted cells, doubled quotes, commas and newlines inside quotes.
            const table = [];
            let row = [], cell = '', quoted = false;
            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                if (quoted) {
                    if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
                    else cell += ch;
                } else if (ch === '"') quoted = true;
                else if (ch === ',') { row.push(cell); cell = ''; }
                else if (ch === '\n' || ch === '\r') {
                    if (ch === '\r' && text[i + 1] === '\n') i++;
                    row.push(cell); cell = ''; table.push(row); row = [];
                } else cell += ch;
            }
            if (cell !== '' || row.length) { row.push(cell); table.push(row); }
            const lines = table.filter((r) => r.some((c) => String(c).trim() !== ''));
            if (lines.length < 2) return fail('empty_csv', 'The file needs a header row and at least one streamer.');
            const key = (h) => String(h || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
            const ALIASES = {
                platform: 'platform', username: 'username', streamer_name: 'username', streamer: 'username', name: 'username',
                discord_user_id: 'discord_user_id', discord_id: 'discord_user_id',
                announcement_channel_id: 'channel_id', channel_id: 'channel_id',
                live_role_id: 'role_id', role_id: 'role_id', custom_message: 'message', message: 'message',
            };
            const cols = lines[0].map((h) => ALIASES[key(h)] || null);
            if (!cols.includes('platform') || !cols.includes('username')) {
                return fail('missing_columns', 'The header row needs platform and username columns.');
            }
            const MAX_ROWS = 200;
            const dataRows = lines.slice(1, MAX_ROWS + 1);
            const guild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId) || null;
            // The platforms the live checker polls. Facebook has no checker (and Meta platforms are
            // not supported), so a Facebook row would be added and never announced.
            const PLATFORMS = ['twitch', 'youtube', 'kick', 'tiktok', 'rumble'];
            const snowflake = (v) => /^\d{17,20}$/.test(v);
            // Undo the export's formula guard (a leading ' before = + - @).
            const clean = (v) => { const s = String(v ?? '').trim(); return /^'[=+\-@]/.test(s) ? s.slice(1) : s; };
            const { resolveStreamerIdentity, upsertStreamerByIdentity } = await import('../utils/platforms/resolve-identity.js');
            // New subscriptions follow the server's stream-end default, as add-streamer's form does.
            const { getStreamEndDefaults } = await import('../core/stream-end-defaults.js');
            const streamEnd = await getStreamEndDefaults(guildId);
            const result = { added: 0, updated: 0, skipped: 0, errors: [], truncated: lines.length - 1 > MAX_ROWS };
            for (let n = 0; n < dataRows.length; n++) {
                const line = n + 2;
                const rec = {};
                cols.forEach((c, i) => { if (c && rec[c] === undefined) rec[c] = clean(dataRows[n][i]); });
                const platform = String(rec.platform || '').toLowerCase();
                const username = String(rec.username || '').slice(0, 100);
                if (!PLATFORMS.includes(platform)) { result.errors.push({ line, reason: `Unknown platform "${String(rec.platform || '').slice(0, 30)}"` }); continue; }
                if (!username) { result.errors.push({ line, reason: 'No username' }); continue; }
                const discordUserId = rec.discord_user_id && snowflake(rec.discord_user_id) ? rec.discord_user_id : null;
                if (rec.discord_user_id && !discordUserId) { result.errors.push({ line, reason: 'Discord user ID is not an ID' }); continue; }
                let channelId = null;
                if (rec.channel_id) {
                    if (!snowflake(rec.channel_id) || (guild && !guild.channels.cache.has(rec.channel_id))) {
                        result.errors.push({ line, reason: 'Announcement channel is not in this server' }); continue;
                    }
                    channelId = rec.channel_id;
                }
                let roleId = null;
                if (rec.role_id) {
                    if (!snowflake(rec.role_id) || (guild && !guild.roles.cache.has(rec.role_id))) {
                        result.errors.push({ line, reason: 'Live role is not in this server' }); continue;
                    }
                    roleId = rec.role_id;
                }
                const message = rec.message ? String(rec.message).slice(0, 2000) : null;
                const identity = await resolveStreamerIdentity(platform, username);
                if (!identity) { result.errors.push({ line, reason: `${username} was not found on ${platform}` }); continue; }
                const streamerId = await upsertStreamerByIdentity(pool, platform, identity, discordUserId);
                const [existing] = await pool.execute(
                    'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ? LIMIT 1',
                    [guildId, streamerId]);
                if (existing.length) {
                    if (channelId || roleId || message) {
                        await pool.execute(
                            `UPDATE subscriptions SET announcement_channel_id = COALESCE(?, announcement_channel_id),
                                    live_role_id = COALESCE(?, live_role_id), custom_message = COALESCE(?, custom_message)
                              WHERE subscription_id = ? AND guild_id = ?`,
                            [channelId, roleId, message, existing[0].subscription_id, guildId]);
                        result.updated++;
                    } else {
                        result.skipped++;
                    }
                } else {
                    await pool.execute(
                        `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, live_role_id, custom_message, delete_on_end, edit_on_end)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [guildId, streamerId, channelId, roleId, message, streamEnd.edit_on_end ? 1 : streamEnd.delete_on_end, streamEnd.edit_on_end]);
                    result.added++;
                }
            }
            logger.info('[CSV import] streamers', { guildId, added: result.added, updated: result.updated, skipped: result.skipped, errors: result.errors.length });
            if (wantsJson) return res.json({ success: true, ...result });
            return res.redirect(`/manage/${guildId}?page=csv&success=imported`);
        } catch (error) {
            logger.error('[CSV import] failed', { guildId, error: error.message });
            if (wantsJson) return res.status(500).json({ success: false, error: 'The import stopped part-way. Rows before the failure were imported.' });
            return res.redirect(`/manage/${guildId}?page=csv&error=import_failed`);
        }
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
            const { cancelTradeByAdmin } = await import('../core/trade-manager.js');
            await cancelTradeByAdmin(guildId, parseInt(trade_id, 10), req.user?.id);
            res.redirect(`/manage/${guildId}?page=trading&success=updated`);
        } catch (error) {
            logger.error('[Trading] Dashboard cancel failed', { guildId, error: error.message });
            res.redirect(`/manage/${guildId}?page=trading&error=failed`);
        }
    });

    // --- Teams (edit) ---
    app.post('/manage/:guildId/edit-team', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            // The Edit Team modal edits a team subscription (twitch_teams row) plus the per-member
            // announcement message / keep-summary setting, which live on the members' subscriptions.
            const { teamSubscriptionId, announcementChannelId, liveRoleId, webhookName, webhookAvatarUrl, customMessage, keepSummary } = req.body;
            if (!teamSubscriptionId) return res.redirect(`/manage/${guildId}?page=streamers&error=missing_fields`);
            const [result] = await pool.execute(
                `UPDATE twitch_teams
                    SET announcement_channel_id = ?, live_role_id = ?, webhook_name = ?, webhook_avatar_url = ?
                  WHERE id = ? AND guild_id = ?`,
                [announcementChannelId || null, liveRoleId || null, webhookName || null, webhookAvatarUrl || null, teamSubscriptionId, guildId]);
            if (!result.affectedRows) return res.redirect(`/manage/${guildId}?page=streamers&error=not_found`);
            await pool.execute(
                'UPDATE subscriptions SET custom_message = ?, delete_on_end = ? WHERE team_subscription_id = ? AND guild_id = ?',
                [customMessage || null, keepSummary ? 0 : 1, teamSubscriptionId, guildId]);
            res.redirect(`/manage/${guildId}?page=streamers&success=updated`);
        } catch (error) { logger.error('[Teams] Error:', error.message); res.redirect(`/manage/${guildId}?page=streamers&error=failed`); }
    });

    // Voice preview endpoint - serves pre-generated preview audio files
    app.get('/api/voice-preview/:voiceId', checkAuth, async (req, res) => {
        try {
            const { voiceId } = req.params;
            let previewPath = path.join(__dirname, '..', 'piper_models', 'previews', `${voiceId}.wav`);

            // Security: Validate voice ID (alphanumeric and underscores only)
            if (!/^[a-zA-Z0-9_]+$/.test(voiceId)) {
                return res.status(400).json({ error: 'Invalid voice ID' });
            }

            // Kokoro voices: made with Kokoro on first request, then kept in models/kokoro/previews
            // (28 voices at most, so the cost is bounded). Never a Piper stand-in.
            if (voiceId.startsWith('kokoro_')) {
                const kokoro = await import('../utils/kokoro-tts.js');
                if (!kokoro.available()) {
                    return res.status(503).json({ error: 'Kokoro voices are not installed on this server yet' });
                }
                previewPath = await kokoro.kokoroPreviewFile(voiceId).catch((err) => {
                    logger.warn(`[Voice Preview] Kokoro preview for ${voiceId} failed: ${err.message}`);
                    return null;
                });
                if (!previewPath) return res.status(404).json({ error: 'Voice preview not found' });
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
            const { log_channel_id, enabled_logs, log_categories, action_colors, actions_on, action_switches } = req.body;

            // Update main logging config
            await pool.execute(`
                INSERT INTO logging_config (guild_id, log_channel_id, enabled_events, events_saved_at)
                VALUES (?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE
                    log_channel_id = VALUES(log_channel_id),
                    enabled_events = VALUES(enabled_events),
                    events_saved_at = NOW()
            `, [
                guildId,
                log_channel_id || null,
                JSON.stringify(Array.isArray(enabled_logs) ? enabled_logs : (enabled_logs ? [enabled_logs] : []))
            ]);

            // Update log event configs (individual category settings)
            // First, get all enabled log types
            const enabledArray = Array.isArray(enabled_logs) ? enabled_logs : (enabled_logs ? [enabled_logs] : []);
            const categoryOverrides = log_categories || {};

            // Every category on the page (log-actions lists them all), so each one's switch and channel are
            // saved — the old hard-coded list missed the voice-state, invite and OwO rows.
            const allCategories = [...new Set([
                'memberJoin', 'messageDelete', 'messageUpdate', 'memberUpdate', 'memberLeave', 'memberKick',
                'voiceUpdate', 'channelCreate', 'channelDelete', 'channelUpdate',
                'threadCreate', 'threadDelete', 'threadUpdate', 'guildUpdate',
                'ban', 'unban', 'roleCreate', 'roleDelete', 'roleUpdate',
                'emojiCreate', 'emojiDelete', 'emojiUpdate', 'stickerCreate', 'stickerDelete', 'stickerUpdate',
                'webhookUpdate', 'integrationUpdate', 'moderation', 'join-gate', 'system',
                'xp', 'giveaway', 'poll', 'starboard', 'sticky-roles', 'temp-channels',
                'twitch-schedule', 'auto-publisher', 'autorole', 'tickets', 'backup', 'team-sync', 'http',
                ...Object.keys(LOG_ACTIONS), ...Object.keys(LOG_NOT_POSTED)
            ])];

            // embed_color (one colour per category) is legacy and no longer written; colours are per action below.
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

            // Per-action colours: store only the ones that differ from the action's default.
            const { upsert, remove } = planActionColorChanges(action_colors || {}, defaultActionColors(guildId));
            if (remove.length) {
                await pool.query('DELETE FROM log_action_colors WHERE guild_id = ? AND action IN (?)', [guildId, remove]);
            }
            for (const [action, color] of upsert) {
                await pool.execute(`
                    INSERT INTO log_action_colors (guild_id, action, color) VALUES (?, ?, ?)
                    ON DUPLICATE KEY UPDATE color = VALUES(color)
                `, [guildId, action, color]);
            }
            // Per-action switches. Only when the form carried them (action_switches marker), so an older open tab
            // or another form posting here never switches every action off.
            if (action_switches) {
                const off = planDisabledActions(actions_on);
                await pool.execute('DELETE FROM log_action_disabled WHERE guild_id = ?', [guildId]);
                if (off.length) {
                    await pool.query('INSERT INTO log_action_disabled (guild_id, action) VALUES ?', [off.map(a => [guildId, a])]);
                }
            }
            invalidateLogActionColors(guildId);

            res.redirect(`/manage/${guildId}?page=logging&success=config`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-logging Error]', error);
            res.redirect(`/manage/${guildId}?page=logging&error=config`);
        }
    });

    // ===========================
    // CUSTOM EMBEDS
    // ===========================

    // Custom embed form checks (create and edit): the channel is a text channel in this server, the
    // text fits Discord's embed limits (and the custom_embeds columns), the colour is #rrggbb and the
    // links are http(s). Returns an error code for the ?error= toast, or null.
    function customEmbedInputError(guildId, b) {
        if (!/^\d{15,25}$/.test(String(b.channel_id || ''))) return 'missing_channel';
        const g = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
        if (g && !g.channels.cache.get(String(b.channel_id))?.isTextBased?.()) return 'pick_a_text_channel_in_this_server';
        const len = (v) => String(v || '').length;
        if (len(b.title) > 256 || len(b.author_name) > 256) return 'title_and_author_can_be_at_most_256_characters';
        if (len(b.description) > 4096) return 'description_can_be_at_most_4096_characters';
        if (len(b.footer_text) > 2048) return 'footer_can_be_at_most_2048_characters';
        if (len(b.title) + len(b.description) + len(b.author_name) + len(b.footer_text) > 6000) return 'embed_text_can_be_at_most_6000_characters';
        if (b.color && !/^#[0-9a-f]{6}$/i.test(String(b.color))) return 'colour_must_be_a_hex_code';
        for (const k of ['url', 'thumbnail_url', 'image_url', 'author_icon_url']) {
            if (b[k] && (len(b[k]) > 2048 || !/^https?:\/\/\S+$/i.test(String(b[k]).trim()))) return 'links_must_start_with_https';
        }
        return null;
    }

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
            const inputError = customEmbedInputError(guildId, req.body);
            if (inputError) return res.redirect(`/manage/${guildId}?page=custom-embeds&error=${inputError}`);

            const [result] = await pool.execute(`
                INSERT INTO custom_embeds (guild_id, channel_id, title, description, color, thumbnail_url, image_url, footer_text, author_name, author_icon_url, url, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [guildId, channel_id, title || null, description || null, color || '#a78bfa', thumbnail_url || null, image_url || null, footer_text || null, author_name || null, author_icon_url || null, url || null, req.user.id]);

            const embedId = result.insertId;

            // If action is 'post', immediately post to Discord
            let postFailed = false;
            if (action === 'post') {
                postFailed = true;
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
                        postFailed = false;
                    }
                } catch (postErr) {
                    logger.error(`[Custom Embeds] Failed to post embed ${embedId}: ${postErr.message}`);
                }
            }

            // Saved either way; say so when the post itself did not happen (H-806).
            if (postFailed) return res.redirect(`/manage/${guildId}?page=custom-embeds&error=saved_but_not_posted_check_the_channel_and_bot_permissions`);
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
            const inputError = customEmbedInputError(guildId, req.body);
            if (inputError) return res.redirect(`/manage/${guildId}?page=custom-embeds&error=${inputError}`);

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
            // The channel must be a text channel in this server; the time HH:MM; the interval 1-168 hours.
            const purgeGuild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
            if (!/^\d{15,25}$/.test(String(channel_id))
                || (purgeGuild && !purgeGuild.channels.cache.get(String(channel_id))?.isTextBased?.())) {
                return res.redirect(`/manage/${guildId}?page=auto-purge&error=pick_a_text_channel_in_this_server`);
            }

            const isInterval = mode === 'interval';
            const dailyTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(purge_time || '')) ? String(purge_time) : '00:00';
            const everyHours = Math.min(168, Math.max(1, parseInt(interval_hours, 10) || 24));
            await pool.execute(`
                INSERT INTO scheduled_purges (guild_id, channel_id, purge_time, interval_hours, enabled, created_by)
                VALUES (?, ?, ?, ?, 1, ?)
                ON DUPLICATE KEY UPDATE purge_time = VALUES(purge_time), interval_hours = VALUES(interval_hours), enabled = 1
            `, [guildId, String(channel_id), isInterval ? '00:00' : dailyTime, isInterval ? everyHours : null, req.user.id]);

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
    // SMART PURGE RULE ROUTES  (channel_purge_rules — per-message TTL + content filters)
    // ===========================

    /**
     * Normalise a textarea of one-per-line values into a clean array.
     * Used for phrases and for pasted Discord IDs.
     */
    const purgeLines = (value, { digitsOnly = false, max = 50 } = {}) =>
        String(value || '')
            .split(/[\r\n]+/)
            .map(s => s.trim())
            .filter(s => s && (!digitsOnly || /^\d{15,25}$/.test(s)))
            .slice(0, max);

    const purgeIdList = (value) => {
        // <select multiple> arrives as a string when one option is picked.
        if (!value) return [];
        const arr = Array.isArray(value) ? value : [value];
        return arr.map(String).filter(v => /^\d{15,25}$/.test(v));
    };

    app.post('/manage/:guildId/purge-rule/add', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const back = (q) => res.redirect(`/manage/${guildId}?page=smart-purge&${q}`);
        try {
            const b = req.body;
            if (!b.channel_id || !/^\d{15,25}$/.test(b.channel_id)) return back('error=missing_channel');

            // TTL is entered as value + unit so people do not have to do
            // seconds arithmetic to say "3 days".
            const unit = parseInt(b.ttl_unit, 10);
            const value = parseInt(b.ttl_value, 10);
            if (!Number.isFinite(unit) || !Number.isFinite(value) || value < 1) return back('error=bad_ttl');
            const ttlSeconds = unit * value;
            // Floor of 60s matches the 30s sweep cadence; ceiling of 1 year
            // keeps a typo from creating a rule that never fires.
            if (ttlSeconds < 60 || ttlSeconds > 365 * 86400) return back('error=bad_ttl');

            const filters = {};
            for (const key of [
                'has_attachment', 'has_image', 'has_video', 'has_file', 'has_link',
                'has_embed', 'has_sticker', 'has_mention', 'text_only', 'from_bots', 'from_humans',
            ]) {
                if (b[`f_${key}`]) filters[key] = true;
            }

            const phrases = purgeLines(b.phrases, { max: 100 });
            if (phrases.length) filters.phrases = phrases;

            if (b.regex && String(b.regex).trim()) {
                const pattern = String(b.regex).trim().slice(0, 500);
                // Reject here rather than storing it: an invalid pattern makes
                // the rule inert at match time, which looks like the feature
                // being broken instead of like a typo.
                try { new RegExp(pattern, 'i'); }
                catch { return back('error=bad_regex'); }
                filters.regex = pattern;
            }

            const filterRoles = purgeIdList(b.filter_role_ids);
            if (filterRoles.length) filters.role_ids = filterRoles;
            const filterUsers = purgeLines(b.filter_user_ids, { digitsOnly: true });
            if (filterUsers.length) filters.user_ids = filterUsers;

            const minLen = parseInt(b.min_length, 10);
            if (Number.isFinite(minLen) && minLen > 0) filters.min_length = minLen;
            const maxLen = parseInt(b.max_length, 10);
            if (Number.isFinite(maxLen) && maxLen > 0) filters.max_length = maxLen;

            // "Everything except X" with no X selected means "delete nothing",
            // which would look like a broken rule rather than a mis-built one.
            if (b.target === 'non_matching' && Object.keys(filters).length === 0) {
                return back('error=inverted_without_filters');
            }

            const [result] = await pool.execute(
                `INSERT INTO channel_purge_rules
                    (guild_id, channel_id, name, enabled, dry_run, delete_after_seconds,
                     target, match_mode, filters,
                     exempt_pinned, exempt_bots, exempt_role_ids, exempt_user_ids,
                     log_channel_id, created_by)
                 VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    guildId,
                    b.channel_id,
                    String(b.name || 'Untitled rule').slice(0, 100),
                    b.dry_run ? 1 : 0,
                    ttlSeconds,
                    b.target === 'non_matching' ? 'non_matching' : 'matching',
                    b.match_mode === 'all' ? 'all' : 'any',
                    Object.keys(filters).length ? JSON.stringify(filters) : null,
                    b.exempt_pinned ? 1 : 0,
                    b.exempt_bots ? 1 : 0,
                    JSON.stringify(purgeIdList(b.exempt_role_ids)),
                    JSON.stringify(purgeLines(b.exempt_user_ids, { digitsOnly: true })),
                    b.log_channel_id && /^\d{15,25}$/.test(b.log_channel_id) ? b.log_channel_id : null,
                    req.user.id,
                ]
            );

            configCache.invalidate('channel_purge_rules', `${guildId}:${b.channel_id}`);
            logger.info(`[SmartPurge] Rule ${result.insertId} created for channel ${b.channel_id} in guild ${guildId} by ${req.user.id}`, {
                category: 'purge', guildId, channelId: b.channel_id,
            });
            back('success=rule_added');
        } catch (error) {
            logger.error('[POST purge-rule/add Error]', error);
            back('error=add_failed');
        }
    });

    app.post('/manage/:guildId/purge-rule/toggle', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const enable = req.body.enabled === '1' ? 1 : 0;
            // Re-enabling restarts the history scan: while the rule was paused
            // the channel kept filling up, and only a fresh scan reaches the
            // messages that are now behind protected ones.
            await pool.execute(
                `UPDATE channel_purge_rules
                    SET enabled = ?, scan_complete = IF(? = 1, 0, scan_complete), scan_cursor = NULL
                  WHERE id = ? AND guild_id = ?`,
                [enable, enable, req.body.ruleId, guildId]
            );
            configCache.invalidateType('channel_purge_rules');
            res.redirect(`/manage/${guildId}?page=smart-purge&success=toggled`);
        } catch (error) {
            logger.error('[POST purge-rule/toggle Error]', error);
            res.redirect(`/manage/${guildId}?page=smart-purge&error=toggle_failed`);
        }
    });

    app.post('/manage/:guildId/purge-rule/delete', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            await pool.execute('DELETE FROM channel_purge_rules WHERE id = ? AND guild_id = ?', [req.body.ruleId, guildId]);
            configCache.invalidateType('channel_purge_rules');
            logger.info(`[SmartPurge] Rule ${req.body.ruleId} deleted in guild ${guildId} by ${req.user.id}`, { category: 'purge', guildId });
            res.redirect(`/manage/${guildId}?page=smart-purge&success=rule_removed`);
        } catch (error) {
            logger.error('[POST purge-rule/delete Error]', error);
            res.redirect(`/manage/${guildId}?page=smart-purge&error=remove_failed`);
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
            // The form suggests a link or @handle; the checker polls UC… ids only, so resolve it first (H-669).
            const { resolveYouTubeChannelId } = await import('../utils/platforms/youtube-resolve.js');
            let ucId;
            try {
                ({ channelId: ucId } = await resolveYouTubeChannelId(youtube_channel_id));
            } catch (resolveErr) {
                if (wantsJson) return res.status(400).json({ error: resolveErr.message });
                return res.redirect(`/manage/${guildId}?page=feeds&error=youtube_channel_not_found`);
            }
            await pool.execute(
                'INSERT INTO youtube_feeds (guild_id, youtube_channel_id, discord_channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE discord_channel_id = VALUES(discord_channel_id)',
                [guildId, ucId, discordChannelId]
            );
            logger.info(`[Feeds] YouTube feed added: ${youtube_channel_id} → ${ucId} → ${discordChannelId} in guild ${guildId}`);
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
        const { redditAvailable, REDDIT_UNAVAILABLE_NOTE } = await import('../utils/reddit.js');
        if (!redditAvailable()) {
            return wantsJson ? res.status(410).json({ error: REDDIT_UNAVAILABLE_NOTE })
                : res.redirect(`/manage/${guildId}?page=feeds&error=${encodeURIComponent(REDDIT_UNAVAILABLE_NOTE)}`);
        }
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

    // ── Commission / sales filter ──────────────────────────────────────────
    app.post('/manage/:guildId/commission-filter/toggle', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const enable = req.body.enabled === '1' || req.body.enabled === 'true' || req.body.enabled === true;
            await pool.execute(
                `INSERT INTO commission_spam_config (guild_id, enabled) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`, [guildId, enable ? 1 : 0]);
            const { invalidate } = await import('../core/commission-spam-filter.js');
            invalidate(guildId);
            res.redirect(`/manage/${guildId}?page=commission-filter&success=commission_${enable ? 'on' : 'off'}`);
        } catch (e) {
            logger.error('[commission toggle]', e);
            res.redirect(`/manage/${guildId}?page=commission-filter&error=commission`);
        }
    });

    app.post('/manage/:guildId/commission-filter/settings', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const dm = req.body.dm_user === '1' || req.body.dm_user === 'on';
            const logCh = req.body.log_channel_id && /^\d{5,25}$/.test(req.body.log_channel_id) ? req.body.log_channel_id : null;
            await pool.execute(
                `INSERT INTO commission_spam_config (guild_id, enabled, dm_user, log_channel_id) VALUES (?, 1, ?, ?)
                 ON DUPLICATE KEY UPDATE dm_user = VALUES(dm_user), log_channel_id = VALUES(log_channel_id)`,
                [guildId, dm ? 1 : 0, logCh]);
            const { invalidate } = await import('../core/commission-spam-filter.js');
            invalidate(guildId);
            res.redirect(`/manage/${guildId}?page=commission-filter&success=commission_saved`);
        } catch (e) {
            logger.error('[commission settings]', e);
            res.redirect(`/manage/${guildId}?page=commission-filter&error=commission`);
        }
    });

    app.post('/manage/:guildId/commission-filter/phrase', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const action = req.body.action;                          // 'add' | 'remove'
            const phrase = String(req.body.phrase || '').trim().toLowerCase();
            if (!phrase) return res.redirect(`/manage/${guildId}?page=commission-filter&error=phrase`);
            const { DEFAULT_PHRASES, invalidate } = await import('../core/commission-spam-filter.js');
            const [[row]] = await pool.execute('SELECT phrases FROM commission_spam_config WHERE guild_id = ?', [guildId]);
            let list;
            try { const c = JSON.parse(row?.phrases || 'null'); list = Array.isArray(c) && c.length ? c : [...DEFAULT_PHRASES]; }
            catch { list = [...DEFAULT_PHRASES]; }
            if (action === 'remove') list = list.filter(pp => pp !== phrase);
            else if (!list.includes(phrase)) list.push(phrase);
            await pool.execute(
                `INSERT INTO commission_spam_config (guild_id, enabled, phrases) VALUES (?, 1, ?)
                 ON DUPLICATE KEY UPDATE phrases = VALUES(phrases)`, [guildId, JSON.stringify(list)]);
            invalidateCommission(guildId);
            res.redirect(`/manage/${guildId}?page=commission-filter&success=phrase_${action}`);
        } catch (e) {
            logger.error('[commission phrase]', e);
            res.redirect(`/manage/${guildId}?page=commission-filter&error=phrase`);
        }
    });

    // Soft-sell tier: the scored third tier for ads that never actually ask.
    app.post('/manage/:guildId/commission-filter/soft-sell', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const enabled = req.body.soft_sell_enabled ? 1 : 0;
            // Sensitivity moves both bars together; the gap between them is what a moderator gets
            // asked about instead of the filter guessing.
            const LEVELS = { cautious: [7, 5], balanced: [6, 4], strict: [5, 3] };
            const [deleteAt, reviewAt] = LEVELS[req.body.sensitivity] || LEVELS.balanced;
            await pool.execute(
                `INSERT INTO commission_spam_config (guild_id, enabled, soft_sell_enabled, soft_sell_delete_at, soft_sell_review_at, review_channel_id)
                 VALUES (?, 1, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE soft_sell_enabled = VALUES(soft_sell_enabled),
                   soft_sell_delete_at = VALUES(soft_sell_delete_at), soft_sell_review_at = VALUES(soft_sell_review_at),
                   review_channel_id = VALUES(review_channel_id)`,
                [guildId, enabled, deleteAt, reviewAt, req.body.review_channel_id || null]);
            invalidateCommission(guildId);
            res.redirect(`/manage/${guildId}?page=commission-filter&success=softsell_saved`);
        } catch (e) {
            logger.error('[commission soft-sell]', e);
            res.redirect(`/manage/${guildId}?page=commission-filter&error=softsell`);
        }
    });

    // Undo a removal. 'restore' clears this message forever; 'trigger' switches off whatever fired.
    app.post('/manage/:guildId/commission-filter/undo', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const id = Number(req.body.removal_id);
            const mode = req.body.mode === 'trigger' ? 'trigger' : 'restore';
            const [[row]] = await pool.execute(
                'SELECT * FROM commission_spam_decisions WHERE id = ? AND guild_id = ?', [id, guildId]);
            if (!row) return res.redirect(`/manage/${guildId}?page=commission-filter&error=undo_missing`);

            const { contentKey, triggerKeysOf } = await import('../core/commission-spam-filter.js');

            if (mode === 'trigger') {
                const key = triggerKeysOf({ via: row.via, matched: row.matched, rule: row.rule,
                    signals: (row.signals || '').split(',').filter(Boolean) })[0];
                if (!key) return res.redirect(`/manage/${guildId}?page=commission-filter&error=undo_trigger`);
                await pool.execute(
                    `INSERT INTO commission_spam_exemptions (guild_id, kind, value, note, created_by)
                     VALUES (?, 'trigger', ?, ?, ?)
                     ON DUPLICATE KEY UPDATE note = VALUES(note), created_by = VALUES(created_by)`,
                    [guildId, key, `via ${row.via} — removal #${id}`, req.user?.id || null]);
                invalidateCommission(guildId);
                return res.redirect(`/manage/${guildId}?page=commission-filter&success=trigger_off`);
            }

            // Repost through the bot so the member actually gets their message back.
            let reposted = false;
            try {
                // Multi-bot: this guild may be served by a custom bot, so the default client is not
                // necessarily in it. Resolve through the bot manager like every other route does.
                const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient() || client;
                const ch = botClient?.channels?.cache?.get(row.channel_id);
                if (ch?.isTextBased?.() && (row.content || row.attachments)) {
                    const member = await ch.guild.members.fetch(row.user_id).catch(() => null);
                    await ch.send({
                        embeds: [{
                            author: { name: member?.displayName || 'Restored message', icon_url: member?.displayAvatarURL?.() },
                            description: (row.content || '*(attachment only)*').slice(0, 4000),
                            footer: { text: 'Restored — removed in error by the commission filter' },
                        }],
                        allowedMentions: { parse: [] },   // a restore must not re-ping anyone
                    });
                    reposted = true;
                }
            } catch (err) { logger.warn(`[commission undo] repost failed: ${err.message}`); }

            const key = contentKey(row.content);
            if (key) {
                await pool.execute(
                    `INSERT INTO commission_spam_exemptions (guild_id, kind, value, note, created_by)
                     VALUES (?, 'content', ?, ?, ?)
                     ON DUPLICATE KEY UPDATE note = VALUES(note), created_by = VALUES(created_by)`,
                    [guildId, key, `false positive — removal #${id}`, req.user?.id || null]);
            }
            // Not 'confirmed', so the poster drops out of the adaptive boost — a wrong call must
            // never make them easier to catch next time.
            await pool.execute(
                `UPDATE commission_spam_decisions
                 SET verdict = 'false_positive', restored_at = NOW(), restored_by = ?, decided_by = ?, decided_at = NOW()
                 WHERE id = ?`, [req.user?.id || null, req.user?.id || null, id]);
            await pool.execute(
                'UPDATE commission_spam_config SET deleted_count = GREATEST(deleted_count - 1, 0) WHERE guild_id = ?',
                [guildId]).catch(() => {});
            invalidateCommission(guildId);
            res.redirect(`/manage/${guildId}?page=commission-filter&success=restored_${reposted ? 'posted' : 'nopost'}`);
        } catch (e) {
            logger.error('[commission undo]', e);
            res.redirect(`/manage/${guildId}?page=commission-filter&error=undo`);
        }
    });

    app.post('/manage/:guildId/commission-filter/unexempt', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            await pool.execute('DELETE FROM commission_spam_exemptions WHERE guild_id = ? AND id = ?',
                [guildId, Number(req.body.exemption_id)]);
            invalidateCommission(guildId);
            res.redirect(`/manage/${guildId}?page=commission-filter&success=unexempt`);
        } catch (e) {
            logger.error('[commission unexempt]', e);
            res.redirect(`/manage/${guildId}?page=commission-filter&error=unexempt`);
        }
    });

    // ── link filter ──────────────────────────────────────────────────────
    app.post('/manage/:guildId/link-filter/toggle', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const enable = req.body.enabled === '1';
            await pool.execute(
                `INSERT INTO link_policy_config (guild_id, enabled) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`, [guildId, enable ? 1 : 0]);
            invalidateLinkPolicy(guildId);
            res.redirect(`/manage/${guildId}?page=link-filter&success=link_${enable ? 'on' : 'off'}`);
        } catch (e) { logger.error('[link toggle]', e); res.redirect(`/manage/${guildId}?page=link-filter&error=link`); }
    });

    app.post('/manage/:guildId/link-filter/settings', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const pick = (v, allowed, fb) => allowed.includes(v) ? v : fb;
            await pool.execute(
                `INSERT INTO link_policy_config (guild_id, enabled, unknown_action, monetisation_action, blocked_action, dm_user, review_channel_id)
                 VALUES (?, 0, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE unknown_action = VALUES(unknown_action),
                   monetisation_action = VALUES(monetisation_action), blocked_action = VALUES(blocked_action),
                   dm_user = VALUES(dm_user), review_channel_id = VALUES(review_channel_id)`,
                [guildId,
                 pick(req.body.unknown_action, ['review', 'block'], 'review'),
                 pick(req.body.monetisation_action, ['allow', 'review', 'block'], 'review'),
                 pick(req.body.blocked_action, ['delete', 'review'], 'delete'),
                 req.body.dm_user ? 1 : 0,
                 /^\d{17,20}$/.test(String(req.body.review_channel_id || '')) ? String(req.body.review_channel_id) : null]);
            invalidateLinkPolicy(guildId);
            res.redirect(`/manage/${guildId}?page=link-filter&success=link_saved`);
        } catch (e) { logger.error('[link settings]', e); res.redirect(`/manage/${guildId}?page=link-filter&error=link`); }
    });

    // Approve or block a queued/removed link. Shares applyLinkDecision with the buttons and the
    // slash command so all three paths behave identically.
    app.post('/manage/:guildId/link-filter/rule', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { applyLinkDecision } = await import('../interactions/buttons/link_review.js');
            // Multi-bot: this guild may be served by a custom bot, so the default client is not
            // necessarily in it. Resolve through the bot manager like every other route does.
            const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient() || client;
            const guild = botClient?.guilds?.cache?.get(guildId);
            if (!guild) return res.redirect(`/manage/${guildId}?page=link-filter&error=no_guild`);
            const shim = { guild, user: { id: req.user?.id || '0' }, client: botClient };
            await applyLinkDecision(shim, Number(req.body.decision_id), req.body.decision === 'deny' ? 'deny' : 'allow');
            invalidateLinkPolicy(guildId);
            res.redirect(`/manage/${guildId}?page=link-filter&success=link_ruled`);
        } catch (e) { logger.error('[link rule]', e); res.redirect(`/manage/${guildId}?page=link-filter&error=link_rule`); }
    });

    app.post('/manage/:guildId/link-filter/rule-domain', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const raw = String(req.body.domain || '').trim().toLowerCase()
                .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
            if (!raw) return res.redirect(`/manage/${guildId}?page=link-filter&error=domain`);
            await pool.execute(
                `INSERT INTO link_policy_domains (guild_id, domain, kind, note, created_by)
                 VALUES (?, ?, ?, 'set from dashboard', ?)
                 ON DUPLICATE KEY UPDATE kind = VALUES(kind), created_by = VALUES(created_by)`,
                [guildId, linkRegistrable(raw), req.body.kind === 'deny' ? 'deny' : 'allow', req.user?.id || null]);
            invalidateLinkPolicy(guildId);
            res.redirect(`/manage/${guildId}?page=link-filter&success=domain_added`);
        } catch (e) { logger.error('[link domain]', e); res.redirect(`/manage/${guildId}?page=link-filter&error=domain`); }
    });

    app.post('/manage/:guildId/link-filter/unrule', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            await pool.execute('DELETE FROM link_policy_domains WHERE guild_id = ? AND domain = ?',
                [guildId, String(req.body.domain || '').trim().toLowerCase()]);
            invalidateLinkPolicy(guildId);
            res.redirect(`/manage/${guildId}?page=link-filter&success=domain_removed`);
        } catch (e) { logger.error('[link unrule]', e); res.redirect(`/manage/${guildId}?page=link-filter&error=domain`); }
    });

    // Rule on a queued borderline post without leaving the dashboard.
    app.post('/manage/:guildId/commission-filter/review', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const id = Number(req.body.decision_id);
            const confirm = req.body.decision === 'confirm';
            const [[row]] = await pool.execute(
                "SELECT * FROM commission_spam_decisions WHERE id = ? AND guild_id = ? AND verdict = 'pending'",
                [id, guildId]);
            if (!row) return res.redirect(`/manage/${guildId}?page=commission-filter&error=review_missing`);

            let removed = false;
            if (confirm) {
                try {
                    // Multi-bot: this guild may be served by a custom bot, so the default client is
                    // not necessarily in it. Resolve through the bot manager.
                    const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient() || client;
                    const ch = botClient?.channels?.cache?.get(row.channel_id);
                    if (ch?.isTextBased?.() && row.message_id) {
                        await ch.messages.delete(row.message_id);
                        removed = true;
                    }
                } catch (err) { logger.warn(`[commission review] delete failed: ${err.message}`); }
                if (removed) {
                    await pool.execute(
                        'UPDATE commission_spam_config SET deleted_count = deleted_count + 1, soft_sell_deleted_count = soft_sell_deleted_count + 1, last_hit_at = NOW() WHERE guild_id = ?',
                        [guildId]).catch(() => {});
                }
            }
            await pool.execute(
                `UPDATE commission_spam_decisions SET verdict = ?, deleted = ?, decided_by = ?, decided_at = NOW() WHERE id = ?`,
                [confirm ? 'confirmed' : 'allowed', removed ? 1 : 0, req.user?.id || null, id]);
            invalidateCommission(guildId);
            res.redirect(`/manage/${guildId}?page=commission-filter&success=review_${confirm ? 'confirmed' : 'allowed'}`);
        } catch (e) {
            logger.error('[commission review]', e);
            res.redirect(`/manage/${guildId}?page=commission-filter&error=review`);
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
            // The channel and role must belong to this server; the message is capped at Discord's 2000.
            const ttGuild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId) || client.guilds.cache.get(guildId);
            if (!/^\d{17,20}$/.test(String(channel_id)) || (ttGuild && !ttGuild.channels.cache.get(String(channel_id))?.isTextBased?.())) {
                return res.redirect(`/manage/${guildId}?page=tiktok&error=missing_fields`);
            }
            mention_role_id = mention_role_id === 'everyone' ? 'everyone'
                : (/^\d{17,20}$/.test(String(mention_role_id || '')) && (!ttGuild || ttGuild.roles.cache.has(String(mention_role_id))) ? String(mention_role_id) : null);
            custom_message = typeof custom_message === 'string' && custom_message.trim() ? custom_message.trim().slice(0, 2000) : null;
            username = String(username).slice(0, 100);

            username = username.trim().replace(/^@/, '').toLowerCase();

            // Resolve the real TikTok user id before persisting — never insert temp_ placeholders.
            const { resolveStreamerIdentity, upsertStreamerByIdentity } = await import('../utils/platforms/resolve-identity.js');
            const identity = await resolveStreamerIdentity('tiktok', username);
            if (!identity) {
                logger.warn('[TikTok add-creator] TikTok user not resolvable', { username });
                return res.redirect(`/manage/${guildId}?page=tiktok&error=tiktok_user_not_found`);
            }
            const streamerId = await upsertStreamerByIdentity(pool, 'tiktok', identity, null);

            // Create subscription with video feed enabled, custom message, and the role to ping. The
            // form's "Role to ping" used to be written to live_role_id, so it was handed out as a live
            // role and nobody was pinged; it belongs in ping_role_id (read by jobs/tiktok-video-checker.js).
            await pool.execute(`
                INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, video_announcement_channel_id, tiktok_vod_notifications, delete_on_end, custom_message, ping_role_id)
                VALUES (?, ?, ?, ?, 1, 1, ?, ?)
                ON DUPLICATE KEY UPDATE video_announcement_channel_id = VALUES(video_announcement_channel_id), tiktok_vod_notifications = 1, custom_message = VALUES(custom_message), ping_role_id = VALUES(ping_role_id)
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
            const { subscription_id, delete_on_end, edit_on_end, tiktok_embed_video } = req.body;
            // Ids are kept only when they belong to this server; the message is capped at 2000.
            const ttGuild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId) || client.guilds.cache.get(guildId);
            const ttChan = (v) => (/^\d{17,20}$/.test(String(v || '')) && (!ttGuild || ttGuild.channels.cache.get(String(v))?.isTextBased?.())) ? String(v) : null;
            const ttRole = (v) => (/^\d{17,20}$/.test(String(v || '')) && String(v) !== guildId && (!ttGuild || ttGuild.roles.cache.has(String(v)))) ? String(v) : null;
            const announcement_channel_id = ttChan(req.body.announcement_channel_id);
            const video_announcement_channel_id = ttChan(req.body.video_announcement_channel_id);
            const live_role_id = ttRole(req.body.live_role_id);
            const ping_role_id = req.body.ping_role_id === 'everyone' ? 'everyone' : ttRole(req.body.ping_role_id);
            const custom_message = typeof req.body.custom_message === 'string' && req.body.custom_message.trim() ? req.body.custom_message.trim().slice(0, 2000) : null;
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
    //
    // We sync VIPs and MODERATORS only. Subscriber roles are NOT ours to do: Discord's own Twitch
    // integration already grants them natively (Server Settings → Integrations → Twitch), it is more
    // reliable than anything we could build on top, and it needs no token from us.
    //
    // `sub_role_id` still exists on the table from migration 076, but nothing has ever read it — the
    // scheduler only fetches VIPs and mods, and the broadcaster OAuth flow does not even request
    // channel:read:subscriptions. It was therefore a field that saved happily and silently did
    // nothing. It is no longer accepted here, so nobody can configure a ghost. The column is left in
    // place (0 guilds ever set it) rather than dropped.
    app.post('/manage/:guildId/twitch-role-sync/settings', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const { vip_role_id, mod_role_id, remove_vip_on_leave, enabled } = req.body;
        try {
            await pool.execute(`
                UPDATE twitch_role_sync_config SET
                    vip_role_id = ?, mod_role_id = ?,
                    remove_vip_on_leave = ?, enabled = ?
                WHERE guild_id = ?
            `, [vip_role_id || null, mod_role_id || null, remove_vip_on_leave ? 1 : 0, enabled ? 1 : 0, guildId]);
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
    // Twitch Analytics — set alert channel + enable
    app.post('/manage/:guildId/twitch-analytics/settings', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const { alert_channel_id, enabled } = req.body;
        try {
            const [rows] = await pool.execute('SELECT broadcaster_twitch_id FROM twitch_role_sync_config WHERE guild_id = ?', [guildId]);
            const bid = rows[0]?.broadcaster_twitch_id;
            if (!bid) {
                return res.redirect(`/manage/${guildId}?page=streamers&error=no_broadcaster_bound`);
            }
            await pool.execute(`
                INSERT INTO twitch_analytics_config (broadcaster_id, enabled, alert_discord_guild_id, alert_discord_channel_id)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE enabled = VALUES(enabled),
                                        alert_discord_guild_id = VALUES(alert_discord_guild_id),
                                        alert_discord_channel_id = VALUES(alert_discord_channel_id)
            `, [String(bid), enabled ? 1 : 0, guildId, alert_channel_id || null]);
            logger.info(`[TwitchAnalytics] Updated settings for guild ${guildId} broadcaster ${bid}`);
            res.redirect(`/manage/${guildId}?page=streamers&tab=analytics&success=analytics_saved`);
        } catch (err) {
            logger.error('[TwitchAnalytics] settings save failed', { err: err.message, guildId });
            res.redirect(`/manage/${guildId}?page=streamers&tab=analytics&error=analytics_save_failed`);
        }
    });

    // Twitch Analytics — threshold tuning
    app.post('/manage/:guildId/twitch-analytics/thresholds', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const { viewbot_threshold, viewbot_min_viewers, followbot_threshold, mod_spike_threshold, harassment_threshold } = req.body;
        try {
            const [rows] = await pool.execute('SELECT broadcaster_twitch_id FROM twitch_role_sync_config WHERE guild_id = ?', [guildId]);
            const bid = rows[0]?.broadcaster_twitch_id;
            if (!bid) return res.redirect(`/manage/${guildId}?page=streamers&error=no_broadcaster_bound`);
            await pool.execute(`
                UPDATE twitch_analytics_config
                   SET viewbot_threshold = ?, viewbot_min_viewers = ?,
                       followbot_threshold = ?, mod_spike_threshold = ?, harassment_threshold = ?
                 WHERE broadcaster_id = ?
            `, [
                // The page's minimums (0.001 and 1); an empty or invalid box keeps the default.
                Number(viewbot_threshold) > 0 ? Math.max(0.001, Number(viewbot_threshold)) : 0.020,
                Math.max(1, parseInt(viewbot_min_viewers, 10) || 50),
                Math.max(1, parseInt(followbot_threshold, 10) || 10),
                Math.max(1, parseInt(mod_spike_threshold, 10) || 5),
                Math.max(1, parseInt(harassment_threshold, 10) || 5),
                String(bid)
            ]);
            res.redirect(`/manage/${guildId}?page=streamers&tab=analytics&success=thresholds_saved`);
        } catch (err) {
            logger.error('[TwitchAnalytics] thresholds save failed', { err: err.message, guildId });
            res.redirect(`/manage/${guildId}?page=streamers&tab=analytics&error=thresholds_save_failed`);
        }
    });

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
            const { enabled, suggestion_channel_id, approval_required, staff_review_channel_id, staff_role_id, allow_anonymous } = req.body;

            logger.info(`[Suggestions Config] Received for guild ${guildId}:`, {
                enabled,
                suggestion_channel_id,
                approval_required,
                staff_review_channel_id,
                staff_role_id,
                allow_anonymous
            });

            // Upsert suggestion_config. Every setting on the form is saved, anonymous suggestions
            // included (it had no switch here, so /engage suggest setup was the only way to set it).
            // A page loaded before that switch existed does not send suggestions_form_v2, and then
            // the saved anonymous setting is left as it is.
            const ownsAnonymous = req.body.suggestions_form_v2 === '1' ? 1 : 0;
            await pool.execute(`
                INSERT INTO suggestion_config (guild_id, enabled, suggestions_channel_id, require_approval, staff_review_channel_id, approved_role_id, allow_anonymous)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    enabled = VALUES(enabled),
                    suggestions_channel_id = VALUES(suggestions_channel_id),
                    require_approval = VALUES(require_approval),
                    staff_review_channel_id = VALUES(staff_review_channel_id),
                    approved_role_id = VALUES(approved_role_id),
                    allow_anonymous = IF(?, VALUES(allow_anonymous), allow_anonymous)
            `, [
                guildId,
                enabled === 'on' ? 1 : 0,
                suggestion_channel_id || null,
                approval_required === 'on' ? 1 : 0,
                staff_review_channel_id || null,
                staff_role_id || null,
                allow_anonymous === 'on' ? 1 : 0,
                ownsAnonymous
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

            // Same path as /engage suggest implement: status, the posted message and a DM to the author.
            const { decideFromDashboard } = await import('../core/suggestion-review.js');
            const result = await decideFromDashboard({ guildId, suggestionId: Number(suggestion_id), reviewerId: req.user.id, decision: 'implemented' });
            if (!result.ok) {
                logger.warn('[Suggestions] Dashboard implement failed', { guildId, suggestion_id, error: result.error });
                return res.redirect(`/manage/${guildId}?page=suggestions&error=implement`);
            }
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
                'DELETE FROM suggestions WHERE id = ? AND guild_id = ?',
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
                monthly_reset_enabled, reset_interval_days, reset_exempt_staff
            } = req.body;

            logger.info(`[Leveling Config] Received for guild ${guildId}:`, {
                leveling_enabled,
                leveling_xp_rate,
                leveling_xp_cooldown,
                monthly_reset_enabled,
                reset_interval_days
            });

            // Validation, the DM / off announcement choices and every option on the page:
            // core/leveling-settings.js (shared with nothing else, so the page and the save stay in step).
            const { saveLevelingForm } = await import('../core/leveling-settings.js');
            const { extended } = await saveLevelingForm(guildId, req.body);
            if (!extended && req.body.leveling_form_v2) {
                logger.warn(`[Leveling Config] ${guildId}: the newer options were not saved (migration 418 not run yet)`);
            }

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

            // Update guild_settings (timezone). Only an IANA zone (or a legacy UTC+N value) is stored;
            // anything else falls back to UTC rather than breaking every scheduler that reads it.
            const tzSafe = (() => {
                const t = String(timezone || 'UTC').trim().slice(0, 64);
                try { new Intl.DateTimeFormat('en-US', { timeZone: t }); return t; }
                catch { return /^UTC[+-]\d{1,2}(:\d{2})?$/.test(t) ? t : 'UTC'; }
            })();
            await pool.execute(
                `INSERT INTO guild_settings (guild_id, timezone) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE timezone = VALUES(timezone)`,
                [guildId, tzSafe]
            );

            // Update guilds (live_role_id) only when a form actually sends it. The Core page does not,
            // and writing NULL here on every Core save cleared the server-wide live role.
            if (Object.prototype.hasOwnProperty.call(req.body, 'live_role_id')) {
                const liveRole = /^\d{17,20}$/.test(String(live_role_id || '')) ? String(live_role_id) : null;
                await pool.execute(
                    `INSERT INTO guilds (guild_id, live_role_id) VALUES (?, ?)
                     ON DUPLICATE KEY UPDATE live_role_id = VALUES(live_role_id)`,
                    [guildId, liveRole]
                );
            }

            // Update prefix command config. A prefix is 1 to 5 symbols, the rule the Prefixes and
            // aliases page and its API use (letters or digits would swallow ordinary chat).
            const prefixText = String(prefix || '').trim();
            if (!/^[^\w\s]{1,5}$/.test(prefixText)) {
                return res.redirect(`/manage/${guildId}?page=core&error=prefix_must_be_1_to_5_symbols`);
            }
            const privateCats = Array.isArray(private_categories) ? private_categories : (private_categories ? [private_categories] : []);
            await pool.execute(
                `INSERT INTO prefix_command_config (guild_id, prefix, enabled, delete_trigger, cleanup_delay, private_categories)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE prefix = VALUES(prefix), enabled = VALUES(enabled),
                 delete_trigger = VALUES(delete_trigger), cleanup_delay = VALUES(cleanup_delay),
                 private_categories = VALUES(private_categories)`,
                [
                    guildId,
                    prefixText,
                    prefix_enabled ? 1 : 0,
                    delete_trigger ? 1 : 0,
                    Math.min(300, Math.max(0, parseInt(cleanup_delay, 10) || 0)),
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
            // Only the columns the form sent: the Default panel form posts the panel channel, category,
            // support role and log channel, and writing every column from the body cleared the rest
            // (the log channel /support ticket setup sets, the thread settings) on each save.
            const { ticketConfigChanges } = await import('./services/ticket-config-save.js');
            const { cols, values } = ticketConfigChanges(req.body || {});
            if (cols.length) {
                await pool.execute(
                    `INSERT INTO ticket_config (guild_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
                     ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
                    [guildId, ...values]
                );
            }

            res.redirect(`/manage/${guildId}?page=tickets&success=updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-tickets Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=tickets&error=update`);
        }
    });

    // Anti-Raid Configuration — the Security page's old form. It wrote anti_raid_config, which nothing
    // enforced; the same numbers now drive the raid lockdown auto-trigger (core/raid-lockdown.js), and
    // anti_raid_config is no longer written or read at all (migrations/330_nsfw_cleanup.js). Kept for any
    // page still open with the old form; the page itself now links to Advanced Protection → Raid Lockdown.
    app.post('/manage/:guildId/security/antiraid', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { enabled, threshold, timePeriod, action, alert_channel_id } = req.body;
            const clampInt = (v, min, max, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
            const { saveSettings } = await import('../core/raid-lockdown.js');
            await saveSettings(guildId, {
                auto_lockdown_enabled: enabled ? 1 : 0,
                auto_lockdown_joins: clampInt(threshold, 3, 100, 20),
                auto_lockdown_window_seconds: clampInt(timePeriod, 5, 300, 10),
                auto_lockdown_action: action === 'ban' ? 'ban' : 'kick',
                ...(alert_channel_id ? { alert_channel_id } : {}),
            });
            logger.info(`[Security] anti-raid (auto-lockdown) saved for ${guildId} by ${req.user?.username}`);

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
                // Limits and action from the column defaults (3, 3, 3, kick), as /protection antinuke enable.
                await pool.execute(
                    `INSERT INTO anti_nuke_config (guild_id, enabled, alert_channel_id) VALUES (?, ?, ?)`,
                    [guildId, enabled ? 1 : 0, alertChannel]
                );
            } else {
                await pool.execute(
                    `UPDATE anti_nuke_config SET enabled = ?, alert_channel_id = ? WHERE guild_id = ?`,
                    [enabled ? 1 : 0, alertChannel, guildId]
                );
            }
            // Applies at once instead of after the 30 s config cache (H-803).
            global.botManager?.getClientForGuild?.(guildId)?.antiNukeManager?.invalidateConfigCache?.(guildId);

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

            // The one verification config is verify_config (core/verification.js). This form used to
            // write join_gate_config.is_enabled / verification_role_id, which nothing enforced; the full
            // settings (CAPTCHA, wizard, stats) are on the Verification page.
            const { saveVerifyConfig, getVerifyConfig, VerificationError } = await import('../core/verification.js');
            const role = roleId && /^\d{15,25}$/.test(String(roleId)) ? String(roleId) : null;
            const current = await getVerifyConfig(guildId);
            if (!current && !role) {
                if (!enabled) return res.redirect(`/manage/${guildId}?page=security&success=joingate`);
                return res.redirect(`/manage/${guildId}?page=verification`);
            }
            try {
                await saveVerifyConfig(guildId, { enabled: enabled ? 1 : 0, ...(role ? { verified_role_id: role } : {}) });
            } catch (err) {
                if (err instanceof VerificationError) return res.redirect(`/manage/${guildId}?page=verification`);
                throw err;
            }

            res.redirect(`/manage/${guildId}?page=security&success=joingate`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/security/joingate Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=security&error=joingate`);
        }
    });

    // Account-age gate. Separate from the verification join gate above even though both live in
    // `join_gate_config`: they are two different features sharing one row, and one form saving
    // both would let a change to either silently clear the other.
    app.post('/manage/:guildId/security/agegate', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const b = req.body;
            const num = (v, fallback) => {
                const n = Number.parseInt(v, 10);
                return Number.isFinite(n) ? n : fallback;
            };

            const { setConfig } = await import('../core/join-gate.js');
            await setConfig(guildId, {
                age_gate_enabled: b.ageGateEnabled ? 1 : 0,
                kick_under_hours: Math.min(720, Math.max(1, num(b.kickUnderHours, 24))),
                apply_under_days: Math.min(365, Math.max(0, num(b.applyUnderDays, 7))),
                action: ['kick', 'ban', 'none'].includes(b.ageGateAction) ? b.ageGateAction : 'kick',
                block_default_avatar: b.blockDefaultAvatar ? 1 : 0,
                review_channel_id: b.reviewChannelId || null,
                invite_channel_id: b.inviteChannelId || null,
                log_channel_id: b.logChannelId || null
            });

            res.redirect(`/manage/${guildId}?page=security&success=agegate`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/security/agegate Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=security&error=agegate`);
        }
    });

    // Discord-flagged spammers — the fourth feature on the `join_gate_config` row (core/spammer-guard.js).
    // Its scan and allowlist are JSON calls (dashboard/routes/api/features/spammer-scan.js).
    app.post('/manage/:guildId/security/spammer', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const b = req.body;
            const { setConfig } = await import('../core/join-gate.js');
            await setConfig(guildId, {
                spammer_enabled: b.spammerEnabled ? 1 : 0,
                spammer_action: ['kick', 'ban', 'flag', 'none'].includes(b.spammerAction) ? b.spammerAction : 'kick',
                spammer_role_id: /^\d{15,25}$/.test(b.spammerRoleId || '') ? b.spammerRoleId : null,
                spammer_silent: b.spammerSilent ? 1 : 0,
            });
            res.redirect(`/manage/${guildId}?page=security&success=spammer`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/security/spammer Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=security&error=spammer`);
        }
    });

    // Rejoin limit — the third feature on the `join_gate_config` row, with its own form for the same
    // reason as the two above. The first time it is switched on, past joins are counted in the
    // background (core/join-history.js backfillGuild) by the bot that actually owns the server.
    app.post('/manage/:guildId/security/rejoin', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const b = req.body;
            const num = (v, fallback) => {
                const n = Number.parseInt(v, 10);
                return Number.isFinite(n) ? n : fallback;
            };

            const { setConfig } = await import('../core/join-gate.js');
            const cfg = await setConfig(guildId, {
                rejoin_limit_enabled: b.rejoinEnabled ? 1 : 0,
                rejoin_max_joins: Math.min(100, Math.max(1, num(b.rejoinMaxJoins, 3))),
                rejoin_window_days: Math.min(3650, Math.max(0, num(b.rejoinWindowDays, 0))),
                rejoin_action: ['ban', 'kick', 'apply', 'none'].includes(b.rejoinAction) ? b.rejoinAction : 'ban',
            });

            if (cfg?.rejoin_limit_enabled && !cfg.rejoin_backfilled_at) {
                const guild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
                if (guild) {
                    const { backfillGuild } = await import('../core/join-history.js');
                    backfillGuild(guild).catch(err =>
                        logger.error(`[Dashboard] rejoin backfill failed for ${guildId}: ${err.message}`));
                } else {
                    logger.warn(`[Dashboard] rejoin limit on for ${guildId} but no bot has it cached — past joins not counted yet`);
                }
            }

            res.redirect(`/manage/${guildId}?page=rejoin&success=saved`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/security/rejoin Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=rejoin&error=rejoin`);
        }
    });

    // CertiFried Network Intel — the cross-guild blacklist + lurker check + DM-spam report consent.
    // These are new columns on the same `join_gate_config` row, kept in a separate form for the
    // same reason the other sub-features are: a change to one of them should never silently clear
    // another. See core/network-gate.js and core/dm-spam-reports.js.
    app.post('/manage/:guildId/security/network-intel', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const b = req.body;
            const num = (v, lo, hi, dflt) => {
                const n = Number.parseInt(v, 10);
                if (!Number.isFinite(n)) return dflt;
                return Math.min(hi, Math.max(lo, n));
            };
            const action = (v, dflt) => (['ban','kick','flag','log'].includes(v) ? v : dflt);

            const { setConfig } = await import('../core/join-gate.js');
            await setConfig(guildId, {
                network_intel_enabled: b.networkIntelEnabled ? 1 : 0,
                network_blacklist_action: action(b.networkBlacklistAction, 'ban'),
                network_report_threshold: num(b.networkReportThreshold, 1, 20, 3),
                network_report_window_hours: num(b.networkReportWindowHours, 1, 720, 72),
                network_lurker_enabled: b.networkLurkerEnabled ? 1 : 0,
                network_lurker_min_guilds: num(b.networkLurkerMinGuilds, 2, 50, 5),
                network_lurker_max_active_pct: num(b.networkLurkerMaxActivePct, 0, 100, 10),
                network_lurker_min_account_days: num(b.networkLurkerMinAccountDays, 0, 3650, 30),
                network_lurker_action: action(b.networkLurkerAction, 'flag'),
                dm_report_enabled: b.dmReportEnabled ? 1 : 0,
                dm_report_channel_id: /^\d{15,25}$/.test(b.dmReportChannelId || '') ? b.dmReportChannelId : null,
            });

            res.redirect(`/manage/${guildId}?page=security&success=network`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/security/network-intel Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=security&error=network`);
        }
    });

    // Network Intel review: set a report's verdict from the dashboard. Mirrors the per-guild
    // staff-channel buttons (interactions/handlers via core/dm-spam-reports.js).
    app.post('/manage/:guildId/network-intel/report/:reportId/verdict', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const reportId = Number.parseInt(req.params.reportId, 10);
        const verdict = String(req.body.verdict || '').toLowerCase();
        try {
            if (!Number.isFinite(reportId) || !['confirmed','rejected','duplicate'].includes(verdict)) {
                return res.redirect(`/manage/${guildId}?page=network-intel&error=bad_input`);
            }
            // Confirm the report belongs to this guild — a staff member can't flip another guild's report.
            const [[own]] = await pool.query(
                `SELECT id FROM dm_spam_reports WHERE id = ? AND guild_id = ? LIMIT 1`,
                [reportId, guildId]
            );
            if (!own) return res.redirect(`/manage/${guildId}?page=network-intel&error=not_your_report`);

            const { setVerdict } = await import('../core/dm-spam-reports.js');
            await setVerdict(reportId, verdict, req.user.id);
            res.redirect(`/manage/${guildId}?page=network-intel&success=verdict_${verdict}`);
        } catch (error) {
            logger.error('[POST /network-intel/report/verdict Error]', error);
            res.redirect(`/manage/${guildId}?page=network-intel&error=verdict_failed`);
        }
    });

    // Network Intel: remove a user from the shared blacklist. Any Guild admin on any CertiFried-covered
    // server can do this, which is intentional — the blacklist is network-wide, and if ANY admin says
    // the auto-blacklist got it wrong, that evidence is enough to reverse it. The user is logged.
    app.post('/manage/:guildId/network-intel/blacklist/:entryId/remove', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const entryId = Number.parseInt(req.params.entryId, 10);
        try {
            if (!Number.isFinite(entryId)) {
                return res.redirect(`/manage/${guildId}?page=network-intel&error=bad_input`);
            }
            const [[row]] = await pool.query(
                `SELECT platform_user_id FROM blacklisted_users
                  WHERE id = ? AND scope = 'network' AND platform = 'discord' LIMIT 1`,
                [entryId]
            );
            if (!row) return res.redirect(`/manage/${guildId}?page=network-intel&error=not_found`);

            await pool.query(`DELETE FROM blacklisted_users WHERE id = ?`, [entryId]);
            // Also mark their contributing reports as no longer-blacklisted so they'd need to recross
            // the threshold on new evidence.
            await pool.query(
                `UPDATE dm_spam_reports SET contributed_to_blacklist = 0
                  WHERE reported_user_id = ? AND contributed_to_blacklist = 1`,
                [row.platform_user_id]
            );
            logger.info(`[Dashboard] network blacklist entry ${entryId} (user ${row.platform_user_id}) removed by ${req.user.id} from guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=network-intel&success=blacklist_removed`);
        } catch (error) {
            logger.error('[POST /network-intel/blacklist/remove Error]', error);
            res.redirect(`/manage/${guildId}?page=network-intel&error=remove_failed`);
        }
    });





    // Rejoin limit page actions (dashboard/views/partials/manage/rejoin.ejs). Plain form posts that
    // reload the page, which then shows the notice.
    app.post('/manage/:guildId/rejoin/reset', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const userId = String(req.body.userId || '');
        try {
            if (!/^\d{17,20}$/.test(userId)) return res.redirect(`/manage/${guildId}?page=rejoin&error=invalid_user`);
            const { addReset } = await import('../core/join-history.js');
            await addReset(guildId, userId, 'staff', req.user.id);
            logger.info(`[Dashboard] rejoin count reset for ${userId} in ${guildId} by ${req.user.id}`);
            res.redirect(`/manage/${guildId}?page=rejoin&user=${userId}&notice=reset`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/rejoin/reset Error]', error);
            res.redirect(`/manage/${guildId}?page=rejoin&user=${userId}&error=reset_failed`);
        }
    });

    app.post('/manage/:guildId/rejoin/sync-history', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const guild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
            if (!guild) return res.redirect(`/manage/${guildId}?page=rejoin&error=bot_not_in_server`);
            const { backfillGuild } = await import('../core/join-history.js');
            backfillGuild(guild).catch(err =>
                logger.error(`[Dashboard] rejoin backfill failed for ${guildId}: ${err.message}`));
            res.redirect(`/manage/${guildId}?page=rejoin&notice=counting`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/rejoin/sync-history Error]', error);
            res.redirect(`/manage/${guildId}?page=rejoin&error=counting_failed`);
        }
    });

    // ==========================================
    // Sery Bot Features - Advanced Protection
    // ==========================================

    // Raid Detection Configuration
    app.post('/manage/:guildId/advanced-protection/raid', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            let {
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
            // The page's limits, the same as /protection raid config's (out-of-range numbers are clamped).
            const apInt = (v, lo, hi, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
            join_threshold = apInt(join_threshold, 3, 50, 10);
            join_timeframe_seconds = apInt(join_timeframe_seconds, 10, 300, 30);
            new_account_age_hours = apInt(new_account_age_hours, 1, 720, 24);
            new_account_ratio = apInt(new_account_ratio, 30, 100, 70);
            mute_duration_minutes = apInt(mute_duration_minutes, 1, 10080, 60);
            action = ['mute', 'kick', 'ban', 'alert'].includes(action) ? action : 'alert';

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

            // The bot reads this row through a 60s cache; make the change take effect now.
            configCache.invalidate('raid_detection_config', guildId);
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
            let {
                enabled,
                min_response_time_ms,
                message_burst_threshold,
                message_burst_window_ms,
                pattern_threshold,
                action,
                alert_channel_id,
                exempt_roles
            } = req.body;
            // The page's limits, the same as /protection selfbot config's (out-of-range numbers are clamped).
            const sbInt = (v, lo, hi, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
            min_response_time_ms = sbInt(min_response_time_ms, 10, 500, 50);
            message_burst_threshold = sbInt(message_burst_threshold, 5, 100, 20);
            message_burst_window_ms = sbInt(message_burst_window_ms, 100, 5000, 1000);
            pattern_threshold = sbInt(pattern_threshold, 1, 10, 3);
            action = ['mute', 'kick', 'ban', 'alert'].includes(action) ? action : 'alert';

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
                        // The page has no exempt-role field: keep the roles set with /protection selfbot exempt.
                        exempt_roles === undefined ? (existing[0].exempt_roles ?? '[]') : JSON.stringify(rolesArray),
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
            let {
                enabled,
                cross_channel_threshold,
                cross_channel_timeframe_minutes,
                deviation_multiplier,
                new_account_multiplier_7d,
                new_account_multiplier_24h,
                action,
                alert_channel_id
            } = req.body;
            // The page's limits, the same as /protection spam config's (out-of-range numbers are clamped).
            const asNum = (v, lo, hi, d, int) => { const n = int ? Number.parseInt(v, 10) : Number.parseFloat(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
            cross_channel_threshold = asNum(cross_channel_threshold, 2, 10, 3, true);
            cross_channel_timeframe_minutes = asNum(cross_channel_timeframe_minutes, 1, 30, 5, true);
            deviation_multiplier = asNum(deviation_multiplier, 1.5, 5, 2.0);
            new_account_multiplier_7d = asNum(new_account_multiplier_7d, 1, 3, 1.5);
            new_account_multiplier_24h = asNum(new_account_multiplier_24h, 1, 5, 2.0);
            // 'delete+warn': core/adaptive-spam-manager.js deleteAndWarn (H-716).
            action = ['mute', 'kick', 'ban', 'delete+warn', 'alert'].includes(action) ? action : 'alert';
            // Exempt channels: the page sends exempt_channels_sent with the list (none selected sends no
            // list, which clears it). Without the marker the stored list is kept.
            const exemptSent = req.body.exempt_channels_sent !== undefined;
            const exemptList = [].concat(req.body.exempt_channels || []).map(String).filter(id => /^\d{15,25}$/.test(id));

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
            if (exemptSent) {
                await pool.execute('UPDATE adaptive_spam_config SET exempt_channels = ? WHERE guild_id = ?',
                    [JSON.stringify([...new Set(exemptList)]), guildId]);
            }

            // The bot reads this row through a 60s cache (also for the exempt channels); apply the change now.
            configCache.invalidate('adaptive_spam_config', guildId);
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

            // Read the roles saved at quarantine time BEFORE removing the row (this used to delete
            // first, so nothing could ever be restored).
            const [savedRoles] = await pool.execute(
                'SELECT previous_roles FROM quarantined_users WHERE guild_id = ? AND user_id = ?',
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

                    // Restore previous roles if they were saved (skipping deleted, managed and
                    // roles above the bot, which Discord would refuse).
                    if (savedRoles.length > 0 && savedRoles[0].previous_roles) {
                        let roleIds = [];
                        try { roleIds = JSON.parse(savedRoles[0].previous_roles); } catch { roleIds = []; }
                        const rolesToAdd = (Array.isArray(roleIds) ? roleIds : [])
                            .map(id => guild.roles.cache.get(String(id)))
                            .filter(role => role && role.id !== guild.id && !role.managed && role.editable);

                        if (rolesToAdd.length > 0) {
                            await member.roles.add(rolesToAdd, 'Released from quarantine (dashboard)');
                        }
                    }
                } catch (err) {
                    logger.warn('[Release Quarantine] Could not modify member roles:', err.message);
                }
            }

            // Remove from quarantine table
            const [released] = await pool.execute(
                'DELETE FROM quarantined_users WHERE guild_id = ? AND user_id = ?',
                [guildId, userId]
            );
            if (released.affectedRows && (req.guildObject || guild)) {
                void logFeatureEvent(() => (req.guildObject || guild), 'moderation.release', () => ({
                    title: '🔓 Released From Quarantine',
                    fields: [['Member', userLabel(userId)], ['Moderator', userLabel(req.user)], ['Where', 'Web dashboard']],
                }));
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
            const { bot_nickname, bot_avatar_url, reset_bot_avatar, embed_color, modlog_components_v2 } = req.body;

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

            // modlog_components_v2 arrives as 'on' when checked, undefined when unchecked.
            const modlogV2Flag = modlog_components_v2 ? 1 : 0;

            // H-706: the avatar this save replaces; its uploaded file is deleted after the save.
            const [[prevAppearance]] = await pool.execute('SELECT bot_avatar_url FROM guild_config WHERE guild_id = ?', [guildId]);

            await pool.execute(`
                INSERT INTO guild_config (guild_id, bot_nickname, bot_avatar_url, embed_color, modlog_components_v2)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    bot_nickname = VALUES(bot_nickname),
                    bot_avatar_url = VALUES(bot_avatar_url),
                    embed_color = VALUES(embed_color),
                    modlog_components_v2 = VALUES(modlog_components_v2)
            `, [
                guildId,
                bot_nickname === 'reset' ? null : (bot_nickname || null),
                reset_bot_avatar ? null : finalAvatarUrl,
                embed_color || '#a78bfa',
                modlogV2Flag
            ]);

            // Bust in-process cache so the toggle takes effect immediately.
            try { _invalidateModlogV2Cache?.(guildId); } catch { /* best effort */ }

            if (prevAppearance?.bot_avatar_url) {
                const { discardReplacedUpload } = await import('../core/server-image-uploads.js');
                await discardReplacedUpload(prevAppearance.bot_avatar_url, reset_bot_avatar ? null : finalAvatarUrl);
            }

            // Apply nickname to the bot in this guild (the server's custom bot when it has one)
            try {
                const botClient = global.botManager?.getClientForGuild?.(guildId) || client;
                const guild = botClient.guilds.cache.get(guildId);
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
            const webhookPersona = req.body.use_webhook_persona === '1' ? 1 : 0;
            // Only ids that belong to this server are kept; the message is capped at Discord's 2000.
            const annGuild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId) || client.guilds.cache.get(guildId);
            const annChannelOk = (id) => /^\d{17,20}$/.test(String(id || '')) && (!annGuild || annGuild.channels.cache.get(String(id))?.isTextBased?.());
            const annRoleOk = (id) => /^\d{17,20}$/.test(String(id || '')) && String(id) !== guildId && (!annGuild || annGuild.roles.cache.has(String(id)));
            const announcement_channel_id = annChannelOk(req.body.announcement_channel_id) ? String(req.body.announcement_channel_id) : null;
            const live_role_id = annRoleOk(req.body.live_role_id) ? String(req.body.live_role_id) : null;
            const announcement_message = typeof req.body.announcement_message === 'string'
                ? req.body.announcement_message.trim().slice(0, 2000) : '';
            const ignoredRoleList = [].concat(req.body.stream_ignored_roles || []).map(String).filter(annRoleOk).slice(0, 100);
            const ignoredRolesJson = ignoredRoleList.length ? JSON.stringify(ignoredRoleList) : null;

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

            // Channels must be text channels in this server. When the bot's view of the server is not
            // available (still starting), a well-formed id is kept rather than wiping the setting.
            const vGuild = global.botManager?.getClientForGuild?.(guildId)?.guilds?.cache?.get(guildId) || null;
            const channelOf = (raw) => {
                const id = String(raw || '').trim();
                if (!/^\d{17,20}$/.test(id)) return null;
                if (!vGuild) return id;
                const ch = vGuild.channels.cache.get(id);
                return ch && ch.isTextBased?.() ? id : null;
            };
            // Discord caps a message at 2000 characters; nothing longer could ever be posted.
            const textOf = (raw) => {
                const t = String(raw ?? '').replace(/\r\n/g, '\n');
                return t.trim() ? t.slice(0, 2000) : null;
            };
            const styleOf = (raw) => (String(raw || '').toLowerCase() === 'embed' ? 'embed' : 'text');
            const colourOf = (raw) => {
                const m = String(raw || '').trim().match(/^#?([0-9a-f]{6})$/i);
                return m ? `#${m[1].toLowerCase()}` : null;
            };

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
                dm_welcome_enabled: Boolean(req.body.dm_welcome_enabled),
                ban_enabled: Boolean(req.body.ban_enabled),
                hasUpload: !!uploadedFile
            });

            // Every column this form owns. The newer ones (migration 419) are only written once they
            // exist, so the page keeps saving on a database that has not been migrated yet.
            const fields = [
                ['channel_id', channelOf(channel_id)],
                ['message', textOf(message)],
                ['banner_enabled', banner_enabled ? 1 : 0],
                ['card_title_text', card_title_text ? String(card_title_text).slice(0, 255) : null],
                ['card_subtitle_text', card_subtitle_text ? String(card_subtitle_text).slice(0, 255) : null],
                ['card_background_url', finalBackgroundUrl],
                ['goodbye_enabled', goodbye_enabled ? 1 : 0],
                ['goodbye_channel_id', channelOf(goodbye_channel_id)],
                ['goodbye_message', textOf(goodbye_message)],
                ['dm_welcome_enabled', req.body.dm_welcome_enabled ? 1 : 0],
                ['dm_welcome_message', textOf(req.body.dm_welcome_message)],
                ['message_type', styleOf(req.body.message_type)],
                ['embed_color', colourOf(req.body.embed_color)],
                ['goodbye_message_type', styleOf(req.body.goodbye_message_type)],
                ['ban_enabled', req.body.ban_enabled ? 1 : 0],
                ['ban_channel_id', channelOf(req.body.ban_channel_id)],
                ['ban_message', textOf(req.body.ban_message)],
                ['ban_message_type', styleOf(req.body.ban_message_type)],
            ];
            const [colRows] = await pool.query('SHOW COLUMNS FROM welcome_settings');
            const known = new Set(colRows.map((c) => c.Field));
            const use = fields.filter(([col]) => known.has(col));
            const cols = use.map(([col]) => col);
            // H-706: the banner this save replaces; its uploaded file is deleted after the save.
            const [[prevWelcome]] = await pool.execute('SELECT card_background_url FROM welcome_settings WHERE guild_id = ?', [guildId]);
            await pool.execute(
                `INSERT INTO welcome_settings (guild_id, ${cols.join(', ')})
                 VALUES (?, ${cols.map(() => '?').join(', ')})
                 ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
                [guildId, ...use.map(([, v]) => v)]
            );
            if (prevWelcome?.card_background_url) {
                const { discardReplacedUpload } = await import('../core/server-image-uploads.js');
                await discardReplacedUpload(prevWelcome.card_background_url, finalBackgroundUrl);
            }

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
            const { question, options, channel_id, duration, allow_multiple, anonymous, allow_write_in, hide_results } = req.body;

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
            // Each option becomes a button, and Discord refuses a button label over 80 characters.
            if (optionsArray.some(opt => String(opt).length > 80)) {
                return res.redirect(`/manage/${guildId}?page=polls&error=option_over_80_characters`);
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
                    // Refused rather than ignored: a typo used to start a poll with no time limit.
                    logger.warn('[Create Poll] Invalid duration format:', { duration: trimmedDuration });
                    return res.redirect(`/manage/${guildId}?page=polls&error=duration_must_look_like_30m_2h_or_1d`);
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
                allow_write_in,
                hide_results
            });

            // Create the poll — pad through betting defaults to reach hideResults (14th arg).
            const result = await pollsManager.createPoll(
                guildId,
                channel_id,
                req.user.id,
                question,
                optionsArray,
                durationSeconds,
                Boolean(allow_multiple),
                Boolean(anonymous),
                Boolean(allow_write_in),
                false, // betting
                10,    // minBet
                1000,  // maxBet
                Boolean(hide_results)
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
            const success = await pollsManager.endPoll(parseInt(pollId), 'Ended manually from dashboard', req.user);

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

    // Edit Poll — fix the question/options of a live poll without recreating it (votes kept)
    app.post('/manage/:guildId/edit-poll', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { pollId, question, options } = req.body;
            if (!pollId || !question || !Array.isArray(options)) {
                return res.status(400).json({ success: false, error: 'Missing poll, question or options' });
            }

            const pollsManager = global.botManager ?
                (global.botManager.getClientForGuild(guildId)?.pollsManager || global.pollsManager) :
                global.pollsManager;
            if (!pollsManager) {
                return res.status(503).json({ success: false, error: 'Poll system unavailable' });
            }

            const edits = options.map(o => ({
                orig: o.orig === null || o.orig === undefined || o.orig === '' ? null : Number(o.orig),
                text: o.text
            }));
            // endsAt absent = leave it, null = no time limit, ISO string = new end time
            const endsAt = !('endsAt' in req.body) ? undefined
                : req.body.endsAt === null || req.body.endsAt === '' ? null
                : new Date(req.body.endsAt);
            const result = await pollsManager.editPoll(parseInt(pollId), guildId, question, edits, endsAt, req.user);

            logger.info('[POST /manage/:guildId/edit-poll] Poll edited:', { guildId, pollId, userId: req.user?.id, ...result });
            res.json({ success: true, ...result });
        } catch (error) {
            logger.warn('[POST /manage/:guildId/edit-poll] Edit refused:', { guildId, error: error.message });
            res.status(400).json({ success: false, error: error.message });
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

            // poll_bets cascades on delete, so stakes must be returned first.
            if (poll.betting_enabled) {
                const { default: PollsManager } = await import('../core/polls-manager.js');
                const pm = botClient?.pollsManager || new PollsManager(botClient);
                await pm.refundBets(poll.id, 'Poll deleted from the dashboard');
            }

            // Delete from database
            await pool.execute('DELETE FROM polls WHERE id = ? AND guild_id = ?', [pollId, guildId]);

            logger.info('[POST /manage/:guildId/delete-poll] Poll deleted successfully:', { pollId });
            const pollGuild = req.guildObject || botClient?.guilds?.cache?.get(guildId);
            if (pollGuild) {
                void logFeatureEvent(() => (pollGuild), 'poll.deleted', () => ({
                    title: '🗑️ Poll Deleted',
                    description: poll.question ? `**${poll.question}**` : null,
                    fields: [['Channel', poll.channel_id ? `<#${poll.channel_id}>` : null], ['Status', poll.is_active === 0 ? 'Ended' : 'Active'],
                        ['Bets refunded', poll.betting_enabled ? 'Yes' : null], ['By', userLabel(req.user)], ['Where', 'Web dashboard']],
                }));
            }
            res.redirect(`/manage/${guildId}?page=polls&success=deleted`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/delete-poll Error]', error);
            res.redirect(`/manage/${guildId}?page=polls&error=delete_failed`);
        }
    });

    // Autoroles Config (core/autoroles.js; the Utilities page)
    app.post('/manage/:guildId/update-autoroles', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const back = (params) => res.redirect(`/manage/${guildId}?page=utilities&${params}`);
        try {
            const { is_enabled } = req.body;
            const { MAX_ROLES, clampDelay, invalidateAutoroleConfig, cancelBackfill } = await import('../core/autoroles.js');
            const { cancelDeadlines } = await import('../core/temp-access-manager.js');

            // Role ids must be roles of this server that a member can be given: not @everyone and not an
            // integration's own role. When the bot's view of the server is unavailable, well-formed ids
            // are kept (the bot reports roles it cannot give in the server log).
            const vGuild = global.botManager?.getClientForGuild?.(guildId)?.guilds?.cache?.get(guildId) || null;
            const rolesOf = (raw) => {
                const list = (Array.isArray(raw) ? raw : (raw ? [raw] : [])).map((x) => String(x).trim());
                const ok = list.filter((id) => {
                    if (!/^\d{17,20}$/.test(id) || id === guildId) return false;
                    if (!vGuild) return true;
                    const role = vGuild.roles.cache.get(id);
                    return !!role && !role.managed;
                });
                return [...new Set(ok)].slice(0, MAX_ROLES);
            };
            const roles = rolesOf(req.body.roles_to_assign);
            const botRoles = rolesOf(req.body.bot_roles);
            const requireRoles = rolesOf(req.body.require_roles);
            const ignoreRoles = rolesOf(req.body.ignore_roles);
            const delay = clampDelay(req.body.delay_minutes);
            const enabled = is_enabled ? 1 : 0;

            logger.info('[POST /manage/:guildId/update-autoroles] Updating:', {
                guildId, is_enabled: Boolean(is_enabled), roles, botRoles, requireRoles, ignoreRoles, delay,
            });

            const fields = [
                ['is_enabled', enabled],
                ['roles_to_assign', JSON.stringify(roles)],
                ['bot_roles', JSON.stringify(botRoles)],
                ['require_roles', JSON.stringify(requireRoles)],
                ['ignore_roles', JSON.stringify(ignoreRoles)],
                ['delay_minutes', delay],
            ];
            // bot_roles and the rest arrive with migration 419; until then only the original columns are written.
            const [colRows] = await pool.query('SHOW COLUMNS FROM autoroles_config');
            const known = new Set(colRows.map((c) => c.Field));
            const use = fields.filter(([col]) => known.has(col));
            const cols = use.map(([col]) => col);
            await pool.execute(
                `INSERT INTO autoroles_config (guild_id, ${cols.join(', ')})
                 VALUES (?, ${cols.map(() => '?').join(', ')})
                 ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
                [guildId, ...use.map(([, v]) => v)]
            );
            invalidateAutoroleConfig(guildId);

            // Off means off: nobody still waiting gets the roles later, and a run in progress stops.
            if (!enabled) {
                await cancelDeadlines(guildId, 'autorole', 'autoroles switched off').catch(() => 0);
                await cancelBackfill(guildId).catch(() => false);
            }

            back('success=updated');
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-autoroles Error]', error);
            back('error=update');
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
                work_min_amount,
                work_max_amount,
                max_bank_capacity
            } = req.body;

            logger.info('[POST /manage/:guildId/economy/config] Updating:', {
                guildId,
                enabled: Boolean(enabled)
            });

            // Fields the Economy page posts. Work amounts are read by core/economy-manager.js (work
            // command); max_bank_capacity applies to new accounts (blank = 10x starting balance).
            // weekly_amount isn't on the form, so it keeps its stored value.
            // At most 1,000,000,000, the page's limit (the columns are INT).
            const int = (v, fallback) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? Math.min(n, 1000000000) : fallback; };
            const workMin = int(work_min_amount, 100);
            const workMax = Math.max(workMin, int(work_max_amount, 500));
            const bankCap = String(max_bank_capacity ?? '').trim() === '' ? null : int(max_bank_capacity, null);
            await pool.execute(`
                INSERT INTO economy_config (guild_id, enabled, currency_name, currency_emoji, starting_balance, daily_amount,
                                            work_min_amount, work_max_amount, max_bank_capacity)
                VALUES (?, ?, ?, COALESCE(?, '💰'), ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    enabled = VALUES(enabled),
                    currency_name = VALUES(currency_name),
                    starting_balance = VALUES(starting_balance),
                    daily_amount = VALUES(daily_amount),
                    work_min_amount = VALUES(work_min_amount),
                    work_max_amount = VALUES(work_max_amount),
                    max_bank_capacity = VALUES(max_bank_capacity)
            `, [
                guildId,
                enabled ? 1 : 0,
                String(currency_name || '').trim().slice(0, 50) || 'coins',
                currency_emoji || null,
                int(starting_balance, 1000),
                int(daily_amount, 500),
                workMin,
                workMax,
                bankCap
            ]);

            // Fields the 2026-11-18 Economy page added, all read by core/economy-manager.js getEconomyConfig.
            // The icon is saved whenever it is sent (the upsert above only sets it on a new row); the rest
            // only when the full form posted them (has_full_form), so an older form cannot reset them.
            const eb = req.body || {};
            const extra = {};
            if (eb.currency_emoji !== undefined) extra.currency_emoji = String(eb.currency_emoji).trim().slice(0, 100) || '💰';
            if (eb.has_full_form) {
                const clampInt = (v, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
                const pct = (v) => { const n = Number(v); return v === '' || v === undefined || !Number.isFinite(n) ? null : Math.min(1, Math.max(0, Math.round(n) / 100)); };
                const put = (k, v) => { if (v !== null && v !== undefined) extra[k] = v; };
                const BIG = 1000000000;
                put('weekly_amount', clampInt(eb.weekly_amount, 0, BIG));
                const cd = clampInt(eb.work_cooldown_minutes, 0, 10080);
                if (cd !== null) extra.work_cooldown = cd * 60;
                const cMin = clampInt(eb.crime_min_amount, 0, BIG), cMax = clampInt(eb.crime_max_amount, 0, BIG);
                put('crime_min_amount', cMin);
                if (cMax !== null) extra.crime_max_amount = Math.max(cMax, cMin ?? 0);
                put('crime_success_rate', pct(eb.crime_success_percent));
                const fine = Number(eb.crime_fine_multiplier);
                if (String(eb.crime_fine_multiplier ?? '').trim() !== '' && Number.isFinite(fine)) extra.crime_fine_multiplier = Math.min(9.99, Math.max(0, Math.round(fine * 100) / 100));
                const rMin = clampInt(eb.rob_min_amount, 0, BIG), rMax = clampInt(eb.rob_max_amount, 0, BIG);
                put('rob_min_amount', rMin);
                if (rMax !== null) extra.rob_max_amount = Math.max(rMax, rMin ?? 0);
                put('rob_success_rate', pct(eb.rob_success_percent));
                put('rob_fine_amount', clampInt(eb.rob_fine_amount, 0, BIG));
                extra.allow_gifting = eb.allow_gifting ? 1 : 0;
                extra.allow_trading = eb.allow_trading ? 1 : 0;
            }
            const extraKeys = Object.keys(extra);
            if (extraKeys.length) {
                // Keys come from the fixed names above, never from the request.
                await pool.execute(`UPDATE economy_config SET ${extraKeys.map((k) => `${k} = ?`).join(', ')} WHERE guild_id = ?`,
                    [...extraKeys.map((k) => extra[k]), guildId]);
            }

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
                (typeof message_template === 'string' && message_template.trim()) ? message_template.trim().slice(0, 2000) : null,
                birthday_role_id || null,
                card_channel_id || null,
                cards_enabled ? 1 : 0,
                ['board', 'greeting_card', 'one_person'].includes(default_card_type) ? default_card_type : 'board'
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

            // The mute role is given to members while they are timed out (core/mute-role.js), so it must be
            // a role in this server the bot can hand out. A role already saved may be re-saved unchanged
            // (the page keeps it selected even if it has since moved above the bot).
            if (muted_role_id) {
                if (!/^\d{17,20}$/.test(String(muted_role_id))) return res.redirect(`/manage/${guildId}?page=moderation&error=invalid_mute_role`);
                const modGuild = global.botManager?.getClientForGuild?.(guildId)?.guilds?.cache?.get(guildId);
                if (modGuild) {
                    const role = modGuild.roles.cache.get(String(muted_role_id));
                    if (!role) return res.redirect(`/manage/${guildId}?page=moderation&error=mute_role_not_found_in_this_server`);
                    const [[savedMod]] = await pool.execute('SELECT muted_role_id FROM moderation_config WHERE guild_id = ?', [guildId]);
                    const unchanged = String(savedMod?.muted_role_id || '') === String(muted_role_id);
                    const botTop = modGuild.members.me?.roles?.highest?.position ?? 0;
                    if (!unchanged && (role.managed || role.id === modGuild.id || role.position >= botTop)) {
                        return res.redirect(`/manage/${guildId}?page=moderation&error=the_bot_cannot_give_that_mute_role_(managed_or_above_the_bot)`);
                    }
                }
            }

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
            const { infraction_count, time_period_hours, action, action_duration_minutes } = req.body;

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

            // Timeouts need a length (Discord caps them at 28 days); kicks and bans have none.
            let durationMinutes = null;
            if (normalizedAction === 'mute') {
                durationMinutes = parseInt(action_duration_minutes, 10);
                if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 40320) {
                    return res.redirect(`/manage/${guildId}?page=moderation&error=invalid_duration`);
                }
            }

            // The page's limits: 1-100 infractions within 1-17520 hours (infractions are kept 730 days).
            // NaN or 0 used to be stored as is, giving a rule that fired on every infraction or never.
            const count = Number(infraction_count);
            const hours = Number(time_period_hours);
            if (!Number.isInteger(count) || count < 1 || count > 100 || !Number.isInteger(hours) || hours < 1 || hours > 17520) {
                return res.redirect(`/manage/${guildId}?page=moderation&error=a_rule_needs_1_to_100_infractions_within_1_to_17520_hours`);
            }

            await pool.execute(`
                INSERT INTO escalation_rules (guild_id, infraction_count, time_period_hours, action, action_duration_minutes)
                VALUES (?, ?, ?, ?, ?)
            `, [guildId, count, hours, normalizedAction, durationMinutes]);

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

    // Filtered words (core/word-filter.js). Saves the bot's list and the Discord AutoMod rule together.
    app.post('/manage/:guildId/word-filter', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { parseEntries, MAX_EXCEPTIONS } = await import('../core/word-filter-logic.js');
            const { saveSettings } = await import('../core/word-filter.js');
            const out = await saveSettings(req.guildObject, {
                enabled: req.body.enabled === 'on',
                words: parseEntries(req.body.words),
                exceptions: parseEntries(req.body.exceptions, MAX_EXCEPTIONS),
                flagChannelId: /^\d{15,25}$/.test(req.body.flag_channel_id || '') ? req.body.flag_channel_id : null,
                pingRoleIds: [].concat(req.body.ping_role_ids || []).filter(id => /^\d{15,25}$/.test(id)),
            }, req.user.id);
            // A native failure leaves the bot's list saved, but the owner still has to know the rule did not update.
            if (!out.ok || out.nativeError) return res.redirect(`/manage/${guildId}?page=automod&error=update_rule`);
            res.redirect(`/manage/${guildId}?page=automod&success=rule_updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/word-filter Error]', error);
            res.redirect(`/manage/${guildId}?page=automod&error=update_rule`);
        }
    });

    // Add AutoMod Rule
    // AutoMod rule editor: actions core/automod.js applies (applyRuleAction) and the per-rule ignored roles and
    // channels (multi-selects; automod_rules.ignored_roles / ignored_channels), checked against the server.
    const AUTOMOD_RULE_ACTIONS = ['delete', 'warn', 'mute', 'kick', 'ban'];
    // 'ladder' (time out for longer each time) is a Message spam action only (core/automod.js spamRuleAction, H-659).
    const automodRuleAction = (action, isSpam) => ((AUTOMOD_RULE_ACTIONS.includes(action) || (isSpam && action === 'ladder')) ? action : 'delete');
    function automodRuleIgnores(guildId, body) {
        const guild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
        if (!guild) return null;
        const ids = (v) => [...new Set((Array.isArray(v) ? v : (v ? [v] : [])).map(String).filter(id => /^\d{17,20}$/.test(id)))];
        return {
            roles: ids(body.ignored_roles).filter(id => id !== guildId && guild.roles.cache.has(id)).slice(0, 50),
            channels: ids(body.ignored_channels).filter(id => guild.channels.cache.has(id)).slice(0, 100),
        };
    }
    function automodMuteMinutes(action, value, fallback) {
        if (action !== 'mute') return null;
        const n = parseInt(value, 10);
        return Number.isFinite(n) ? Math.min(Math.max(n, 1), 40320) : fallback;
    }
    async function dropAutomodCache(guildId) {
        try { (await import('../core/automod.js')).invalidateAutomodRules(guildId); } catch (e) { logger.warn(`[AutoMod] Could not drop the rule cache: ${e.message}`); }
    }

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

            if (!['bannedWords', 'massMention', 'allCaps', 'antiSpam'].includes(filter_type)) {
                return res.redirect(`/manage/${guildId}?page=automod&error=add_rule`);
            }
            const ruleAction = automodRuleAction(action, filter_type === 'antiSpam');
            const ignores = automodRuleIgnores(guildId, req.body);
            if (!ignores) return res.redirect(`/manage/${guildId}?page=automod&error=add_rule`);

            await pool.execute(`
                INSERT INTO automod_rules (guild_id, filter_type, config, action, action_duration_minutes, is_enabled, ignored_roles, ignored_channels)
                VALUES (?, ?, ?, ?, ?, TRUE, ?, ?)
            `, [
                guildId,
                dbFilterType,
                JSON.stringify(config),
                ruleAction,
                automodMuteMinutes(ruleAction, action_duration_minutes, 10),
                JSON.stringify(ignores.roles),
                JSON.stringify(ignores.channels)
            ]);
            await dropAutomodCache(guildId);

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
            await dropAutomodCache(guildId);

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
            await dropAutomodCache(guildId);

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

            // The rule as stored: its type decides which settings the dialog edits, and settings the dialog
            // has no field for (rules written by setup scripts, other key spellings) are kept, not wiped.
            const [[existing]] = await pool.execute('SELECT filter_type, config, action_duration_minutes FROM automod_rules WHERE id = ? AND guild_id = ?', [ruleId, guildId]);
            if (!existing) return res.redirect(`/manage/${guildId}?page=automod&error=update_rule`);
            let config = {};
            try { config = JSON.parse(existing.config || '{}') || {}; } catch { config = {}; }
            if (typeof config !== 'object' || Array.isArray(config)) config = {};
            const storedType = String(existing.filter_type || filter_type || '').toLowerCase().replace(/_/g, '');
            if (storedType === 'bannedwords') {
                config.words = config_banned_words ? config_banned_words.split(',').map(w => w.trim()).filter(w => w) : [];
                delete config.banned_words;
            } else if ((storedType === 'massmention' || storedType === 'massmentions') && config_massMention_limit !== undefined) {
                config.limit = parseInt(config_massMention_limit) || 5;
                delete config.max_mentions;
            } else if ((storedType === 'allcaps' || storedType === 'caps') && config_allCaps_limit !== undefined) {
                config.limit = parseInt(config_allCaps_limit) || 70;
                delete config.caps_percentage;
            } else if (storedType === 'antispam' && config_antiSpam_message_limit !== undefined) {
                config.message_limit = parseInt(config_antiSpam_message_limit) || 5;
                config.time_period = parseInt(config_antiSpam_time_period) || 10;
                delete config.duplicate_threshold;
                delete config.time_window_seconds;
            }
            const ruleAction = automodRuleAction(action, storedType === 'antispam' || storedType === 'spam');
            const ignores = automodRuleIgnores(guildId, req.body);
            if (!ignores) return res.redirect(`/manage/${guildId}?page=automod&error=update_rule`);

            await pool.execute(
                'UPDATE automod_rules SET action = ?, action_duration_minutes = ?, config = ?, ignored_roles = ?, ignored_channels = ? WHERE id = ? AND guild_id = ?',
                [
                    ruleAction,
                    automodMuteMinutes(ruleAction, action_duration_minutes, existing.action_duration_minutes || 10),
                    JSON.stringify(config),
                    JSON.stringify(ignores.roles),
                    JSON.stringify(ignores.channels),
                    ruleId,
                    guildId
                ]
            );
            await dropAutomodCache(guildId);

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
            const { platform, username, announcement_channel_id, keep_summary, edit_on_end } = req.body;
            // Ids are kept only when they belong to this server; text is capped at Discord's limits.
            const addGuild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId) || client.guilds.cache.get(guildId);
            const discord_user_id = /^\d{17,20}$/.test(String(req.body.discord_user_id || '').trim()) ? String(req.body.discord_user_id).trim() : null;
            const override_nickname = typeof req.body.override_nickname === 'string' && req.body.override_nickname.trim() ? req.body.override_nickname.trim().slice(0, 80) : null;
            const custom_message = typeof req.body.custom_message === 'string' && req.body.custom_message.trim() ? req.body.custom_message.trim().slice(0, 2000) : null;

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
                    channelId = announcement_channel_id.find(Boolean) || null; // the form sends one; older clients sent several
                } else {
                    channelId = announcement_channel_id;
                }
            }
            if (channelId && (!/^\d{17,20}$/.test(String(channelId)) || (addGuild && !addGuild.channels.cache.get(String(channelId))?.isTextBased?.()))) {
                channelId = null;   // not a text channel of this server: fall back to the server default
            }

            // The add form seeds both switches from the guild default, so whatever
            // arrives here is already the answer — edit wins over delete/keep, matching
            // the precedence in core/stream-manager.js.
            const editOnEnd = edit_on_end ? 1 : 0;
            const deleteOnEnd = editOnEnd ? 1 : (keep_summary ? 0 : 1);

            logger.info('[POST /manage/:guildId/add-streamer] Creating subscription:', {
                guildId,
                streamerId,
                channelId,
                override_nickname,
                custom_message,
                delete_on_end: deleteOnEnd,
                edit_on_end: editOnEnd
            });

            // Create subscription
            const [subResult] = await pool.execute(
                `INSERT INTO subscriptions
                (guild_id, streamer_id, announcement_channel_id, override_nickname, custom_message, delete_on_end, edit_on_end)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [guildId, streamerId, channelId || null, override_nickname || null, custom_message || null, deleteOnEnd, editOnEnd]
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

            // Ids from the form are kept only when they belong to this server; text is capped at
            // Discord's limits (2000 message, 80 webhook name).
            const escGuild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId) || client.guilds.cache.get(guildId);
            const escSnow = (v) => /^\d{17,20}$/.test(String(v || ''));
            const escChannel = (v) => (escSnow(v) && (!escGuild || escGuild.channels.cache.get(String(v))?.isTextBased?.())) ? String(v) : null;
            const escRole = (v) => (escSnow(v) && String(v) !== guildId && (!escGuild || escGuild.roles.cache.has(String(v)))) ? String(v) : null;
            const escText = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
            const escUrl = (v) => { const t = escText(v, 500); return t && /^https?:\/\//i.test(t) ? t : null; };

            // Update Discord user ID link for the streamer (only a streamer this server subscribes to)
            if (consolidated_streamer_id) {
                logger.info('[POST /manage/:guildId/edit-consolidated-streamer] Updating Discord link:', {
                    streamer_id: consolidated_streamer_id,
                    discord_user_id: discord_user_id || 'null'
                });

                const [result] = await pool.execute(
                    `UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ?
                       AND EXISTS (SELECT 1 FROM subscriptions WHERE subscriptions.streamer_id = streamers.streamer_id AND subscriptions.guild_id = ?)`,
                    [escSnow(discord_user_id) ? String(discord_user_id) : null, consolidated_streamer_id, guildId]
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
                            post_as_streamer = ?,
                            custom_message = ?,
                            delete_on_end = ?,
                            notify_videos = ?,
                            video_announcement_channel_id = ?
                        WHERE subscription_id = ? AND guild_id = ?`,
                        [
                            escChannel(channelId),
                            escRole(subData.live_role_id),
                            subData.ping_role_id === 'everyone' ? 'everyone' : escRole(subData.ping_role_id),
                            escText(subData.override_nickname, 80),
                            escUrl(subData.override_avatar_url),
                            subData.post_as_streamer === '1' ? 1 : subData.post_as_streamer === '0' ? 0 : null,
                            escText(subData.custom_message, 2000),
                            subData.keep_summary ? 0 : 1,
                            subData.notify_videos ? 1 : 0,
                            escChannel(videoChannelId),
                            subId,
                            guildId
                        ]
                    );

                    // Go-live filters (core/stream-alert-filters.js), saved only when the dialog sent
                    // them and in their own statement, so the update above never depends on them.
                    if (subData.filter_categories !== undefined || subData.filter_title_keywords !== undefined) {
                        try {
                            const { cleanList } = await import('../core/feed-message.js');
                            await pool.execute(
                                'UPDATE subscriptions SET filter_categories = ?, filter_title_keywords = ? WHERE subscription_id = ? AND guild_id = ?',
                                [cleanList(subData.filter_categories), cleanList(subData.filter_title_keywords), subId, guildId]
                            );
                        } catch (filterErr) {
                            logger.warn(`[POST /manage/:guildId/edit-consolidated-streamer] Could not save go-live filters for subscription ${subId}: ${filterErr.message}`);
                        }
                    }

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
            const { announcementChannelId, liveRoleId, liveBoardChannelId } = req.body;
            // The team's slug from twitch.tv/team/<slug>; a pasted URL is accepted too.
            const teamName = String(req.body.teamName || '').trim().replace(/^.*\/team\//i, '').replace(/[/?#].*$/, '').toLowerCase();
            if (!/^[a-z0-9_]{1,25}$/.test(teamName)) return res.redirect(`/manage/${guildId}?page=teams&error=invalid`);

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
                `INSERT INTO twitch_teams (guild_id, team_name, announcement_channel_id, live_role_id, live_board_channel_id)
                VALUES (?, ?, ?, ?, ?)`,
                [guildId, teamName, announcementChannelId || null, liveRoleId || null, liveBoardChannelId || null]
            );

            // Trigger team sync
            const { syncTwitchTeam } = await import('../core/team-sync.js');
            if (syncTwitchTeam) {
                await syncTwitchTeam(result.insertId, client);
            }
            if (liveBoardChannelId) {
                const { refreshTeamBoard } = await import('../core/team-live-board.js');
                await refreshTeamBoard(result.insertId, { force: true }).catch(e => logger.warn(`[Teams] live board: ${e.message}`));
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
            const { teamId, announcementChannelId, liveRoleId, webhookName, webhookAvatarUrl, liveBoardChannelId } = req.body;
            const [[before]] = await pool.execute('SELECT live_board_channel_id FROM twitch_teams WHERE id = ? AND guild_id = ?', [teamId, guildId]);
            if (!before) return res.redirect(`/manage/${guildId}?page=teams&error=not_found`);
            const boardChannel = liveBoardChannelId || null;
            const boardMoved = (before.live_board_channel_id || null) !== boardChannel;

            await pool.execute(
                `UPDATE twitch_teams
                SET announcement_channel_id = ?, live_role_id = ?, webhook_name = ?, webhook_avatar_url = ?,
                    live_board_channel_id = ?, live_board_message_id = IF(?, NULL, live_board_message_id)
                WHERE id = ? AND guild_id = ?`,
                [
                    announcementChannelId || null,
                    liveRoleId || null,
                    webhookName || null,
                    webhookAvatarUrl || null,
                    boardChannel,
                    boardMoved ? 1 : 0,
                    teamId,
                    guildId
                ]
            );
            if (boardMoved) {
                const { refreshTeamBoard, resetTeamBoard } = await import('../core/team-live-board.js');
                resetTeamBoard(teamId);
                if (boardChannel) await refreshTeamBoard(teamId, { force: true }).catch(e => logger.warn(`[Teams] live board: ${e.message}`));
            }

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

            // The team must belong to this server: the subscriptions below are found by team id, so an
            // unchecked id would remove another server's team members.
            const [[team]] = await pool.execute('SELECT id FROM twitch_teams WHERE id = ? AND guild_id = ?', [teamId, guildId]);
            if (!team) return res.redirect(`/manage/${guildId}?page=teams&error=not_found`);

            // Get all streamer IDs associated with this team before deleting
            const [streamers] = await pool.execute(
                'SELECT streamer_id FROM subscriptions WHERE team_subscription_id = ? AND guild_id = ?',
                [teamId, guildId]
            );

            const streamerIds = streamers.map(s => s.streamer_id);

            // Delete all subscriptions associated with this team
            await pool.execute(
                'DELETE FROM subscriptions WHERE team_subscription_id = ? AND guild_id = ?',
                [teamId, guildId]
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

            if (req.guildObject) {
                const [[streamerRow]] = await pool.execute('SELECT username FROM streamers WHERE streamer_id = ?', [streamerId]);
                void logFeatureEvent(() => (req.guildObject), 'twitch-schedule.added', () => ({
                    title: '➕ Schedule Sync Added',
                    fields: [['Streamer', streamerRow?.username], ['Channel', `<#${channelId}>`], ['Checks every', `${interval} min`],
                        ['Weekly repost', weekly ? 'Yes' : 'No'], ['By', userLabel(req.user)], ['Where', 'Web dashboard']],
                }));
            }

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
            const {
                syncId, syncIntervalMinutes, weeklyRefresh, channelId,
                mentionRoleId, customMessage, isEnabled
            } = req.body;

            if (!syncId) {
                return res.redirect(`/manage/${guildId}?page=twitch-schedules&error=missing_id`);
            }

            const interval = Math.min(10080, Math.max(15, parseInt(syncIntervalMinutes, 10) || 360));
            const weekly = (weeklyRefresh === 'on' || weeklyRefresh === '1' || weeklyRefresh === true) ? 1 : 0;

            // When enabling weekly_refresh, reset last_weekly_refresh so the next sync triggers a fresh post
            const sets = ['sync_interval_minutes = ?', 'weekly_refresh = ?'];
            const params = [interval, weekly];
            if (weekly) sets.push('last_weekly_refresh = NULL');

            /* SELECT *: paused_reason only exists once migration 434 has run. */
            const [[current]] = await pool.execute(
                'SELECT * FROM twitch_schedule_sync_config WHERE id = ? AND guild_id = ?',
                [syncId, guildId]);
            if (!current) {
                return res.redirect(`/manage/${guildId}?page=twitch-schedules&error=missing_id`);
            }
            const newChannel = channelId ? String(channelId) : null;
            const movesChannel = !!newChannel && newChannel !== String(current.discord_channel_id);
            if (movesChannel) {
                /* The channel must be a text channel in this server that the bot can see. */
                const botGuild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
                const target = botGuild?.channels.cache.get(newChannel);
                if (botGuild && (!target || !target.isTextBased?.())) {
                    return res.redirect(`/manage/${guildId}?page=twitch-schedules&error=pick_a_text_channel_in_this_server`);
                }
            }
            /* A sync paused because its channel was deleted (H-312) stays off until it has a new
               channel; switching it on in place would only delete-and-pause it again. */
            const stayPaused = !!current.paused_reason && !movesChannel;

            /* Everything past the interval is optional, because this same route
               serves a small modal and a full editor. A field that was not
               submitted is left as it is — reading a missing checkbox as "off"
               would switch the sync off every time someone changed the interval.
               The modal sends a hidden isEnabled=0 before its checkbox, so a
               ticked box arrives as ['0', 'on'] and the last value wins. */
            const enabledField = Array.isArray(isEnabled) ? isEnabled[isEnabled.length - 1] : isEnabled;
            if (enabledField !== undefined && !stayPaused) {
                sets.push('is_enabled = ?');
                params.push((enabledField === 'on' || enabledField === '1' || enabledField === true) ? 1 : 0);
            }
            if (mentionRoleId !== undefined) { sets.push('mention_role_id = ?'); params.push(mentionRoleId || null); }
            if (customMessage !== undefined) {
                sets.push('custom_message = ?');
                params.push(String(customMessage).trim().slice(0, 200) || null);
            }
            if (newChannel) {
                sets.push('discord_channel_id = ?');
                params.push(newChannel);
                if (movesChannel) {
                    /* Moving the post to another channel invalidates the message we
                       were editing — without clearing it every later sync tries to
                       PATCH a message in a channel it no longer posts to. */
                    sets.push('last_message_id = NULL', 'schedule_hash = NULL');
                    /* A new channel is what a paused sync was waiting for. */
                    if (current.paused_reason) sets.push('paused_reason = NULL', 'paused_at = NULL');
                }
            }
            params.push(syncId, guildId);

            await pool.execute(
                `UPDATE twitch_schedule_sync_config SET ${sets.join(', ')} WHERE id = ? AND guild_id = ?`,
                params
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

    /* ── Schedule card look ─────────────────────────────────────────────────
     *
     * The default calendar grid is one of three looks. This writes the rest:
     * which layout, where the backdrop comes from, and the wording drawn on it.
     *
     * Any change to how the backdrop is SOURCED throws away the cached artwork.
     * Generated art is billed per image and reused between syncs, so the cache
     * is what stops four re-renders a day costing four generations — but keeping
     * it after the owner picks a new theme means the new theme never appears.
     */
    const SCHEDULE_LAYOUTS = ['month', 'overlay', 'rows', 'poster', 'calendar'];
    const SCHEDULE_SOURCES = ['twitch', 'mixed', 'custom'];
    const SCHEDULE_BG_MODES = ['default', 'upload', 'style', 'prompt'];
    const SCHEDULE_ROTATIONS = ['fixed', 'shuffle', 'random'];
    const SCHEDULE_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

    /** Save an uploaded poster to the static directory and return its URL. */
    const saveScheduleUpload = async (file, guildId, index = 0) => {
        const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
        if (!SCHEDULE_IMAGE_EXTS.includes(ext)) {
            throw new Error(`${file.originalname || 'file'} is not a PNG, JPG or WEBP`);
        }
        const filename = `schedule_${guildId}_${Date.now()}_${index}${ext}`;
        const uploadDir = path.join(__dirname, 'public', 'uploads');
        const fs = await import('fs');
        fs.mkdirSync(uploadDir, { recursive: true });
        fs.writeFileSync(path.join(uploadDir, filename), file.buffer);
        const baseUrl = (process.env.DASHBOARD_URL || '').replace(/\/$/, '');
        return `${baseUrl}/uploads/${filename}`;
    };

    /** Re-post a sync's schedule now, without waiting for the poll. */
    const resyncSchedule = async (guildId, syncId) => {
        const [[sync]] = await pool.execute(`
            SELECT tss.*, s.platform_user_id, s.username, s.profile_image_url
            FROM twitch_schedule_sync_config tss
            JOIN streamers s ON tss.streamer_id = s.streamer_id
            WHERE tss.id = ? AND tss.guild_id = ?
        `, [syncId, guildId]);
        if (!sync) return false;
        const { getTwitchScheduleManager } = await import('../jobs/twitch-schedule-scheduler.js');
        const manager = getTwitchScheduleManager(guildId);
        if (!manager) {
            /* No live manager in this process — leave the flag on and let the
               five-minute poll do it rather than silently dropping the request. */
            await pool.execute('UPDATE twitch_schedule_sync_config SET force_refresh = 1 WHERE id = ?', [syncId]);
            return true;
        }
        await pool.execute('UPDATE twitch_schedule_sync_config SET change_detected_at = NULL WHERE id = ?', [syncId]);
        sync.change_detected_at = null;
        manager.syncSchedule(sync, { skipCooldown: true }).catch(err =>
            logger.error('[TwitchSchedules] Re-sync failed:', { error: err.message, syncId }));
        return true;
    };

    app.post('/manage/:guildId/twitch-schedules/style', upload.fields([
        { name: 'background_file', maxCount: 1 }
    ]), handleMulterError, checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const {
                syncId, layout, view_mode, background_mode, background_rotation,
                background_url, background_prompt, accent_color, card_title, card_footer,
                apply_now
            } = req.body;

            if (!syncId) {
                return res.redirect(`/manage/${guildId}?page=twitch-schedules&error=missing_id`);
            }
            const [[existing]] = await pool.execute(
                'SELECT * FROM twitch_schedule_sync_config WHERE id = ? AND guild_id = ?',
                [syncId, guildId]);
            if (!existing) {
                return res.redirect(`/manage/${guildId}?page=twitch-schedules&error=not_found`);
            }

            let bgUrl = (background_url || '').trim() || existing.background_url;
            const uploaded = req.files?.background_file?.[0];
            if (uploaded) {
                try { bgUrl = await saveScheduleUpload(uploaded, guildId); }
                catch (e) {
                    logger.warn(`[TwitchSchedules] style upload rejected: ${e.message}`);
                    return res.redirect(`/manage/${guildId}?page=twitch-schedules&error=bad_image`);
                }
            }

            const next = {
                layout: SCHEDULE_LAYOUTS.includes(layout) ? layout : existing.layout,
                view_mode: view_mode === 'weekly' ? 'weekly' : 'monthly',
                background_mode: SCHEDULE_BG_MODES.includes(background_mode)
                    ? background_mode : existing.background_mode,
                background_rotation: SCHEDULE_ROTATIONS.includes(background_rotation)
                    ? background_rotation : existing.background_rotation,
                background_url: bgUrl || null,
                background_prompt: (background_prompt || '').trim().slice(0, 400) || null,
                accent_color: /^#[0-9a-fA-F]{6}$/.test(accent_color || '') ? accent_color : null,
                card_title: (card_title || '').trim().slice(0, 80) || null,
                card_footer: (card_footer || '').trim().slice(0, 200) || null,
            };

            // Throw the cached artwork away only when what it was made FROM moved.
            const sourceMoved = next.background_mode !== existing.background_mode
                || next.background_url !== (existing.background_url || null)
                || next.background_prompt !== (existing.background_prompt || null)
                || next.layout !== existing.layout;

            await pool.execute(`
                UPDATE twitch_schedule_sync_config SET
                    layout = ?, view_mode = ?, background_mode = ?, background_rotation = ?,
                    background_url = ?, background_prompt = ?, accent_color = ?,
                    card_title = ?, card_footer = ?
                    ${sourceMoved ? ', background_cache_url = NULL' : ''}
                WHERE id = ? AND guild_id = ?`,
                [next.layout, next.view_mode, next.background_mode, next.background_rotation,
                 next.background_url, next.background_prompt, next.accent_color,
                 next.card_title, next.card_footer, syncId, guildId]);

            // H-706: a replaced background upload, and the generated backdrop thrown away above, are deleted.
            {
                const { discardReplacedUpload } = await import('../core/server-image-uploads.js');
                await discardReplacedUpload(existing.background_url, next.background_url);
                if (sourceMoved) await discardReplacedUpload(existing.background_cache_url, null);
            }

            if (apply_now === 'on' || apply_now === '1') await resyncSchedule(guildId, syncId);
            res.redirect(`/manage/${guildId}?page=twitch-schedules&success=style_saved`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/twitch-schedules/style Error]', error);
            res.redirect(`/manage/${guildId}?page=twitch-schedules&error=style`);
        }
    });

    /* ── The calendar an owner fills in ─────────────────────────────────────
     *
     * One row per day. Saving a day doesn't post anything: the owner fills in a month, looks at the
     * preview, then posts it. If they never press post, the next sync finds the change on its own.
     */
    const scheduleSyncFor = async (guildId, syncId) => {
        const [[sync]] = await pool.execute(`
            SELECT tss.*, s.platform_user_id, s.username
            FROM twitch_schedule_sync_config tss
            JOIN streamers s ON tss.streamer_id = s.streamer_id
            WHERE tss.id = ? AND tss.guild_id = ?`, [syncId, guildId]);
        return sync || null;
    };

    const parseScheduleMonth = (value, tz, posterMonth) => {
        const m = String(value || '').match(/^(\d{4})-(\d{2})$/);
        if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { year: Number(m[1]), month: Number(m[2]) - 1 };
        return posterMonth(tz);
    };

    /** A month's days plus the Twitch schedule behind them, shared by the editor and the preview. */
    const scheduleMonthData = async (sync, monthParam) => {
        const calendar = await import('../core/schedule-calendar.js');
        const { getGuildTimezone } = await import('../utils/guild-timezone.js');
        const tz = await getGuildTimezone(sync.guild_id);
        const when = parseScheduleMonth(monthParam, tz, calendar.posterMonth);
        const source = sync.schedule_source || 'twitch';
        const days = await calendar.loadCustomDays(sync.id);
        let twitch = [];
        if (source !== 'custom' && sync.platform_user_id && !String(sync.platform_user_id).startsWith('temp_')) {
            const { getStreamSchedule } = await import('../utils/platforms/twitch-api.js');
            const res = await getStreamSchedule(sync.platform_user_id).catch(() => null);
            twitch = res?.data?.data?.segments || [];
        }
        const segments = calendar.mergeSegments(source, twitch, days, tz);
        return { calendar, tz, when, source, days, segments };
    };

    // The short link to the calendar page.
    app.get('/manage/:guildId/calendar', checkAuth, checkGuildAdmin, (req, res) => {
        res.redirect(`/manage/${req.params.guildId}?page=schedule-calendar`);
    });

    app.post('/manage/:guildId/twitch-schedules/:syncId/calendar-settings', upload.fields([
        { name: 'side_art_file', maxCount: 1 }
    ]), handleMulterError, checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, syncId } = req.params;
            const sync = await scheduleSyncFor(guildId, syncId);
            if (!sync) return res.status(404).json({ error: 'not_found' });
            const { schedule_source, use_poster, card_title, card_disclaimer, remove_side_art } = req.body;

            let sideArtUrl = remove_side_art === 'on' ? null : sync.side_art_url;
            const sideArt = req.files?.side_art_file?.[0];
            if (sideArt) {
                try { sideArtUrl = await saveScheduleUpload(sideArt, guildId, 1); }
                catch (e) {
                    logger.warn(`[TwitchSchedules] side art upload rejected: ${e.message}`);
                    return res.status(400).json({ error: 'bad_image' });
                }
            }
            // Switching the poster off goes back to the default grid; any other layout is left alone.
            const layout = use_poster === 'on' ? 'calendar' : (sync.layout === 'calendar' ? 'month' : sync.layout);
            await pool.execute(`
                UPDATE twitch_schedule_sync_config SET schedule_source = ?, layout = ?, card_title = ?,
                    side_art_url = ?, card_disclaimer = ? WHERE id = ? AND guild_id = ?`,
                [SCHEDULE_SOURCES.includes(schedule_source) ? schedule_source : sync.schedule_source, layout,
                 (card_title || '').trim().slice(0, 80) || null, sideArtUrl || null,
                 (card_disclaimer || '').trim().slice(0, 600) || null, syncId, guildId]);
            // H-706: replaced or removed side art is deleted.
            const { discardReplacedUpload } = await import('../core/server-image-uploads.js');
            await discardReplacedUpload(sync.side_art_url, sideArtUrl);
            res.json({ ok: true });
        } catch (error) {
            logger.error('[POST twitch-schedules calendar-settings Error]', error);
            res.status(500).json({ error: 'failed' });
        }
    });

    app.post('/manage/:guildId/twitch-schedules/:syncId/post', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, syncId } = req.params;
            const done = await resyncSchedule(guildId, syncId);
            res.status(done ? 200 : 404).json({ ok: done });
        } catch (error) {
            logger.error('[POST twitch-schedules post Error]', error);
            res.status(500).json({ error: 'failed' });
        }
    });

    app.get('/manage/:guildId/twitch-schedules/:syncId/calendar', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const sync = await scheduleSyncFor(req.params.guildId, req.params.syncId);
            if (!sync) return res.status(404).json({ error: 'not_found' });
            const { calendar, tz, when, source, days, segments } = await scheduleMonthData(sync, req.query.month);
            const prefix = `${when.year}-${String(when.month + 1).padStart(2, '0')}`;
            res.json({
                year: when.year, month: when.month, tz, source,
                monthName: calendar.monthName(when.year, when.month),
                firstWeekday: calendar.firstWeekday(when.year, when.month),
                days: calendar.buildMonth({ ...when, source, segments, days, tz }),
                saved: [...days.values()].filter((d) => d.day.startsWith(prefix)),
            });
        } catch (error) {
            logger.error('[GET twitch-schedules calendar Error]', error);
            res.status(500).json({ error: 'failed' });
        }
    });

    app.get('/manage/:guildId/twitch-schedules/:syncId/preview.png', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const sync = await scheduleSyncFor(req.params.guildId, req.params.syncId);
            if (!sync) return res.status(404).end();
            const { tz, when, days, segments } = await scheduleMonthData(sync, req.query.month);
            const { default: TwitchScheduleManager } = await import('../core/twitch-schedule-manager.js');
            sync._customDays = days;
            const png = await new TwitchScheduleManager(null).buildCalendarPoster(sync, segments, [], tz, when);
            if (!png) return res.status(500).end();
            res.set('Cache-Control', 'no-store').type('png').send(png);
        } catch (error) {
            logger.error('[GET twitch-schedules preview Error]', error);
            res.status(500).end();
        }
    });

    app.post('/manage/:guildId/twitch-schedules/:syncId/day', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, syncId } = req.params;
            const sync = await scheduleSyncFor(guildId, syncId);
            if (!sync) return res.status(404).json({ error: 'not_found' });
            const { day, kind, title, title_color, title_color2, start_time, end_time, note, note_color } = req.body || {};
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return res.status(400).json({ error: 'bad_day' });
            const colour = (v) => (/^#[0-9a-fA-F]{6}$/.test(v || '') ? v : null);
            const time = (v) => (/^\d{2}:\d{2}$/.test(v || '') ? `${v}:00` : null);
            const text = (v, max) => String(v || '').trim().slice(0, max) || null;
            const off = kind === 'off';
            await pool.execute(`
                INSERT INTO twitch_schedule_custom_days
                    (sync_id, day, kind, title, title_color, title_color2, start_time, end_time, note, note_color, updated_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE kind = VALUES(kind), title = VALUES(title), title_color = VALUES(title_color),
                    title_color2 = VALUES(title_color2), start_time = VALUES(start_time), end_time = VALUES(end_time),
                    note = VALUES(note), note_color = VALUES(note_color), updated_by = VALUES(updated_by)`,
                [syncId, day, off ? 'off' : 'stream', text(title, 120), colour(title_color), colour(title_color2),
                 off ? null : time(start_time), off ? null : time(end_time), text(note, 160), colour(note_color),
                 String(req.user?.id || '') || null]);
            res.json({ ok: true });
        } catch (error) {
            logger.error('[POST twitch-schedules day Error]', error);
            res.status(500).json({ error: 'failed' });
        }
    });

    app.post('/manage/:guildId/twitch-schedules/:syncId/day/clear', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, syncId } = req.params;
            const sync = await scheduleSyncFor(guildId, syncId);
            if (!sync) return res.status(404).json({ error: 'not_found' });
            await pool.execute('DELETE FROM twitch_schedule_custom_days WHERE sync_id = ? AND day = ?',
                [syncId, String(req.body?.day || '').slice(0, 10)]);
            res.json({ ok: true });
        } catch (error) {
            logger.error('[POST twitch-schedules day clear Error]', error);
            res.status(500).json({ error: 'failed' });
        }
    });

    /* ── Example schedules (templates) ──────────────────────────────────────
     *
     * Owners upload FINISHED posters, not blank backgrounds — their own past
     * schedules, with last month's dates still on them. So an upload is a
     * reference for the look, not the backdrop itself: the bot reads its palette
     * and tone and generates a clean version with no lettering in it. Anyone who
     * really does have an empty background can say so per template ("use as-is").
     */
    app.post('/manage/:guildId/twitch-schedules/templates/add', upload.fields([
        { name: 'template_files', maxCount: 10 }
    ]), handleMulterError, checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { label, template_url, mode, prompt } = req.body;
            const useMode = mode === 'upload' ? 'upload' : 'style';
            const files = req.files?.template_files || [];
            const urls = [];

            for (let i = 0; i < files.length; i++) {
                try { urls.push(await saveScheduleUpload(files[i], guildId, i)); }
                catch (e) { logger.warn(`[TwitchSchedules] template upload rejected: ${e.message}`); }
            }
            for (const raw of String(template_url || '').split(/[\s,]+/)) {
                if (/^https?:\/\//i.test(raw)) urls.push(raw.trim());
            }
            if (!urls.length) {
                return res.redirect(`/manage/${guildId}?page=twitch-schedules&error=no_templates`);
            }

            const [[{ next_order: nextOrder }]] = await pool.execute(
                'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM schedule_templates WHERE guild_id = ?',
                [guildId]);

            for (let i = 0; i < urls.length; i++) {
                await pool.execute(`
                    INSERT INTO schedule_templates
                        (guild_id, label, source_url, mode, prompt, sort_order, added_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [guildId,
                     ((label || '').trim() || `Example ${nextOrder + i}`).slice(0, 80),
                     urls[i], useMode, (prompt || '').trim().slice(0, 400) || null,
                     nextOrder + i, req.user?.id || null]);
            }
            logger.info(`[TwitchSchedules] ${urls.length} template(s) added for guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=twitch-schedules&success=templates_added`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/twitch-schedules/templates/add Error]', error);
            res.redirect(`/manage/${guildId}?page=twitch-schedules&error=templates`);
        }
    });

    app.post('/manage/:guildId/twitch-schedules/templates/update', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const { templateId, action, label, prompt, mode } = req.body;
            if (!templateId) {
                return res.redirect(`/manage/${guildId}?page=twitch-schedules&error=missing_id`);
            }
            // H-706: a deleted example's poster and generated backdrop, or a regenerated one's old backdrop, are deleted.
            const [[tplBefore]] = await pool.execute(
                'SELECT source_url, cache_url FROM schedule_templates WHERE id = ? AND guild_id = ?', [templateId, guildId]);
            const { discardReplacedUpload } = await import('../core/server-image-uploads.js');
            if (action === 'delete') {
                await pool.execute('DELETE FROM schedule_templates WHERE id = ? AND guild_id = ?',
                    [templateId, guildId]);
                /* The bag holds ids. Leaving a deleted one in it would deal a
                   template that no longer exists; pickTemplate filters, but
                   clearing is cheaper than trusting it. */
                await pool.execute(
                    'UPDATE twitch_schedule_sync_config SET template_bag = NULL WHERE guild_id = ?',
                    [guildId]);
            } else if (action === 'toggle') {
                await pool.execute(
                    'UPDATE schedule_templates SET enabled = 1 - enabled WHERE id = ? AND guild_id = ?',
                    [templateId, guildId]);
                await pool.execute(
                    'UPDATE twitch_schedule_sync_config SET template_bag = NULL WHERE guild_id = ?',
                    [guildId]);
            } else if (action === 'regenerate') {
                // Drop the generated art so the next sync makes it again.
                await pool.execute('UPDATE schedule_templates SET cache_url = NULL WHERE id = ? AND guild_id = ?',
                    [templateId, guildId]);
            } else {
                await pool.execute(`
                    UPDATE schedule_templates SET label = ?, prompt = ?, mode = ?
                    WHERE id = ? AND guild_id = ?`,
                    [(label || '').trim().slice(0, 80) || null,
                     (prompt || '').trim().slice(0, 400) || null,
                     mode === 'upload' ? 'upload' : 'style',
                     templateId, guildId]);
            }
            if (tplBefore && action === 'delete') {
                await discardReplacedUpload(tplBefore.source_url, null);
                await discardReplacedUpload(tplBefore.cache_url, null);
            } else if (tplBefore && action === 'regenerate') {
                await discardReplacedUpload(tplBefore.cache_url, null);
            }
            res.redirect(`/manage/${guildId}?page=twitch-schedules&success=template_updated`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/twitch-schedules/templates/update Error]', error);
            res.redirect(`/manage/${guildId}?page=twitch-schedules&error=templates`);
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

            const [[syncRow]] = await pool.execute(
                `SELECT tss.discord_channel_id, s.username FROM twitch_schedule_sync_config tss
                 LEFT JOIN streamers s ON s.streamer_id = tss.streamer_id WHERE tss.id = ? AND tss.guild_id = ?`,
                [syncId, guildId]
            );

            // Delete sync
            const [removed] = await pool.execute(
                `DELETE tss, d FROM twitch_schedule_sync_config tss
                 LEFT JOIN twitch_schedule_custom_days d ON d.sync_id = tss.id
                 WHERE tss.id = ? AND tss.guild_id = ?`,
                [syncId, guildId]
            );
            if (removed.affectedRows && req.guildObject) {
                void logFeatureEvent(() => (req.guildObject), 'twitch-schedule.removed', () => ({
                    title: '🗑️ Schedule Sync Removed',
                    fields: [['Streamer', syncRow?.username], ['Channel', syncRow?.discord_channel_id ? `<#${syncRow.discord_channel_id}>` : null],
                        ['By', userLabel(req.user)], ['Where', 'Web dashboard']],
                }));
            }

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

            // The page's on/off switch: off removes every creator channel, as /admin temp-channel disable does (H-681).
            const { wantsTempChannelsOff, disableTempChannels } = await import('../core/temp-channel-config.js');
            if (wantsTempChannelsOff(req.body)) {
                await disableTempChannels(guildId);
                return res.redirect(`/manage/${guildId}?page=utilities&success=true`);
            }

            if (!creator_channel_id || !category_id) {
                return res.redirect(`/manage/${guildId}?page=utilities&error=missing_fields`);
            }
            // The creator must be a voice channel and the category a category of this server (when the
            // bot can see it); the name is one line of at most 100 characters (Discord's channel limit).
            {
                const tGuild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
                if (tGuild) {
                    const creator = tGuild.channels.cache.get(String(creator_channel_id));
                    const category = tGuild.channels.cache.get(String(category_id));
                    if (!creator || creator.type !== 2 || !category || category.type !== 4) {
                        return res.redirect(`/manage/${guildId}?page=utilities&error=invalid_channel`);
                    }
                }
            }
            const cleanTemplate = String(naming_template || '').replace(/\s+/g, ' ').trim().slice(0, 100);

            // One row per creator channel (PK guild_id + creator_channel_id; /admin temp-channel adds more). The page
            // edits the creator it showed (original_creator_channel_id) and nothing else: this used to set EVERY row
            // of the server to the one creator channel (H-810).
            const template = cleanTemplate || "{username}'s Channel";
            const original = String(req.body.original_creator_channel_id || '').trim();
            let moved = false;
            if (/^\d{17,20}$/.test(original) && original !== String(creator_channel_id)) {
                const [[clash]] = await pool.execute(
                    'SELECT 1 AS x FROM temp_channel_config WHERE guild_id = ? AND creator_channel_id = ?', [guildId, creator_channel_id]);
                if (!clash) {
                    const [r] = await pool.execute(
                        `UPDATE temp_channel_config SET creator_channel_id = ?, category_id = ?, naming_template = ?
                         WHERE guild_id = ? AND creator_channel_id = ?`,
                        [creator_channel_id, category_id, template, guildId, original]);
                    moved = r.affectedRows > 0;
                }
            }
            if (!moved) {
                await pool.execute(
                    `INSERT INTO temp_channel_config (guild_id, creator_channel_id, category_id, naming_template)
                     VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE category_id = VALUES(category_id), naming_template = VALUES(naming_template)`,
                    [guildId, creator_channel_id, category_id, template]
                );
            }
            logger.info('[POST /manage/:guildId/update-tempchannels] Saved creator channel', { guildId, creator_channel_id, moved });

            res.redirect(`/manage/${guildId}?page=utilities&success=true`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/update-tempchannels Error]', error);
            res.redirect(`/manage/${req.params.guildId}?page=utilities&error=update`);
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

            // Only this server's own questions (guild_id = this guild); the global bank isn't deletable here.
            await pool.execute('DELETE FROM trivia_questions WHERE id = ? AND guild_id = ?', [question_id, guildId]);

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

            if (!['easy', 'medium', 'hard'].includes(difficulty) || sanitizedWord.length > 50) {
                return res.redirect(`/manage/${guildId}?page=games&error=invalid_word`);
            }

            // Server-specific word in the hangman bank (word_list; guild_id NULL = global word).
            // The hint is the word's definition, which hangman shows.
            await pool.execute(`
                INSERT INTO word_list (guild_id, word, difficulty, category, definition, is_active, added_by)
                VALUES (?, ?, ?, ?, ?, 1, ?)
            `, [
                guildId,
                sanitizedWord,
                difficulty,
                String(category).trim().toLowerCase().slice(0, 100),
                hint || null,
                req.user.id
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

            await pool.execute('DELETE FROM word_list WHERE id = ? AND guild_id = ?', [word_id, guildId]);

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
    //
    // These operate on ticket_forms / ticket_form_questions — the tables the Discord side actually
    // reads. They used to write to a `forms` / `form_questions` pair that nothing else in the
    // codebase queried, so a form built here could never appear on a ticket panel and its question
    // list was permanently empty. Migration 218 dropped that dead pair.
    //
    // Every question-level route joins back to ticket_forms to check guild ownership: question ids
    // are global, so `WHERE question_id = ?` alone would let any server admin edit any other
    // server's questions.

    // The dashboard intercepts POST forms with fetch(), so a bare redirect surfaces to the admin
    // as the raw query key ("form_in_use"). Answer XHR callers with a real sentence and everyone
    // else with the redirect, from one place.
    const FORM_MESSAGES = {
        form_created: 'Form created.',
        form_updated: 'Form updated.',
        form_deleted: 'Form deleted.',
        panel_created: 'Panel posted.',
        missing_name: 'A form needs a name.',
        duplicate_name: 'A form with that name already exists on this server.',
        create_failed: 'Could not create the form.',
        edit_failed: 'Could not save the form.',
        delete_failed: 'Could not delete the form.',
        form_not_found: 'That form no longer exists.',
        form_in_use: 'That form is attached to a ticket panel. Detach it there first, then delete it.',
        no_questions: 'Add at least one question before posting this form as a panel.',
        missing_fields: 'Pick a channel for the panel.',
        bot_not_found: 'No bot is connected to this server right now.',
        channel_not_found: 'That channel could not be found.',
        panel_failed: 'Could not post the panel — check the bot can send messages there.'
    };

    // `key` is either one of the codes above or, for a failure only the call site can describe,
    // the finished sentence itself.
    const formsResult = (req, res, guildId, kind, key) => {
        const message = FORM_MESSAGES[key] || key;
        if (req.xhr || req.get('X-Requested-With') === 'XMLHttpRequest') {
            return kind === 'success'
                ? res.json({ success: true, message })
                : res.status(400).json({ error: message });
        }
        return res.redirect(`/manage/${guildId}?page=forms&${kind}=${encodeURIComponent(key)}`);
    };

    // Read a question payload out of a request body into DB columns, or throw a plain message.
    const parseQuestionInput = (body) => {
        const questionText = String(body.question_text || '').trim();
        if (!questionText) throw new Error('A question needs some text.');
        if (questionText.length > 300) throw new Error('Questions are limited to 300 characters.');

        const questionType = String(body.question_type || 'text');
        if (!isValidFormQuestionType(questionType)) throw new Error('Unknown answer format.');

        const options = serialiseFormOptions(questionType, body.question_options);
        if (FORM_QUESTION_TYPES[questionType].needsOptions && !options) {
            throw new Error(`"${FORM_QUESTION_TYPES[questionType].label}" needs at least one choice.`);
        }

        // The short heading Discord shows above the field. Capped at Discord's 45, and stored as
        // NULL when blank so the builder falls back to trimming the question.
        const fieldLabel = String(body.field_label || '').trim().slice(0, 45) || null;

        const placeholder = String(body.placeholder || '').trim().slice(0, 100) || null;
        // Absent means required — that is how every question behaved before the flag existed, so
        // an old caller that never sends the field keeps its current behaviour.
        const raw = body.is_required;
        const isRequired = (raw === false || raw === 0 || raw === '0' || raw === 'false' || raw === 'off') ? 0 : 1;

        return { questionText, fieldLabel, questionType, options, placeholder, isRequired };
    };

    const botForGuild = (guildId) =>
        global.botManager?.getClientForGuild(guildId)
        || global.botManager?.getDefaultClient()
        || client;

    /**
     * Keep only recipients who are actually in this guild.
     *
     * A form's answers can be personal, and dm_user_ids is just a list of snowflakes in a text
     * column — without this, a typo'd or pasted id would quietly start forwarding a server's
     * submissions to a stranger. Membership is checked when the list is SAVED rather than at send
     * time, so the person configuring it finds out immediately.
     */
    const validateDmRecipients = async (guildId, raw) => {
        const ids = parseDmRecipients(raw);
        if (ids.length === 0) return { ids: [], rejected: [] };

        const guild = botForGuild(guildId)?.guilds?.cache?.get(guildId);
        if (!guild) return { ids, rejected: [] }; // Bot offline: trust the list rather than wipe it.

        const kept = [];
        const rejected = [];
        for (const id of ids) {
            const member = await guild.members.fetch(id).catch(() => null);
            if (member && !member.user.bot) kept.push(id);
            else rejected.push(id);
        }
        return { ids: kept, rejected };
    };

    // Does this form belong to this guild? Returns the row, or null.
    const loadGuildForm = async (guildId, formId) => {
        const [rows] = await pool.execute(
            'SELECT * FROM ticket_forms WHERE form_id = ? AND guild_id = ?', [formId, guildId]);
        return rows[0] || null;
    };

    // Create form. Optionally seeds its questions in one shot from the builder in the modal, so a
    // form can be created complete rather than created empty and then filled in.
    app.post('/manage/:guildId/forms/create', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { form_name, form_description, submit_channel_id } = req.body;

            if (!form_name || !String(form_name).trim()) {
                return formsResult(req, res, guildId, 'error', 'missing_name');
            }

            const { ids: dmIds } = await validateDmRecipients(guildId, req.body.dm_user_ids);

            const [result] = await pool.execute(`
                INSERT INTO ticket_forms (guild_id, form_name, form_description, submit_channel_id, dm_user_ids, show_questions_on_panel)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [guildId, String(form_name).trim().slice(0, 255), form_description || null,
                submit_channel_id || null, serialiseDmRecipients(dmIds),
                req.body.show_questions_on_panel === false ? 0 : 1]);

            // questions_json is produced by the builder in the create modal.
            let seeded = [];
            try {
                seeded = JSON.parse(req.body.questions_json || '[]');
                if (!Array.isArray(seeded)) seeded = [];
            } catch { seeded = []; }

            let order = 0;
            for (const raw of seeded) {
                let q;
                try { q = parseQuestionInput(raw); } catch { continue; } // skip a malformed row, keep the form
                await pool.execute(`
                    INSERT INTO ticket_form_questions
                        (form_id, question_text, field_label, question_type, question_options, is_required, placeholder, question_order)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `, [result.insertId, q.questionText, q.fieldLabel, q.questionType, q.options, q.isRequired, q.placeholder, order++]);
            }

            logger.info(`[Forms] Created form for guild ${guildId}: ${form_name} (${order} question(s))`);
            formsResult(req, res, guildId, 'success', 'form_created');
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                return formsResult(req, res, req.params.guildId, 'error', 'duplicate_name');
            }
            logger.error('[POST /manage/:guildId/forms/create Error]', error);
            formsResult(req, res, req.params.guildId, 'error', 'create_failed');
        }
    });

    // Edit form
    app.post('/manage/:guildId/forms/edit/:formId', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const formId = req.params.formId;
            const { form_name, form_description, submit_channel_id } = req.body;

            if (!form_name || !String(form_name).trim()) {
                return formsResult(req, res, guildId, 'error', 'missing_name');
            }

            const { ids: dmIds, rejected } = await validateDmRecipients(guildId, req.body.dm_user_ids);
            if (rejected.length) {
                logger.warn(`[Forms] Dropped ${rejected.length} DM recipient(s) not in guild ${guildId}`);
            }

            await pool.execute(`
                UPDATE ticket_forms
                SET form_name = ?, form_description = ?, submit_channel_id = ?, dm_user_ids = ?,
                    show_questions_on_panel = ?, auto_reply = ?, dm_on_submit = ?
                WHERE form_id = ? AND guild_id = ?
            `, [String(form_name).trim().slice(0, 255), form_description || null,
                submit_channel_id || null, serialiseDmRecipients(dmIds),
                req.body.show_questions_on_panel === false ? 0 : 1,
                req.body.auto_reply === true ? 1 : 0,
                req.body.dm_on_submit === false ? 0 : 1, formId, guildId]);

            // A posted panel embeds the form's wording and its questions, so any change here
            // makes the live message wrong. Push it immediately rather than leaving a Refresh
            // button somebody has to remember.
            syncPanelsForForm(botForGuild(guildId), guildId, formId).catch(() => {});

            logger.info(`[Forms] Updated form ${formId} for guild ${guildId}`);
            formsResult(req, res, guildId, 'success', 'form_updated');
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/edit/:formId Error]', error);
            formsResult(req, res, req.params.guildId, 'error', 'edit_failed');
        }
    });

    // Delete form. Questions and standalone submissions have no FK cascade, so they are cleared
    // explicitly — otherwise they'd linger and get re-attached to a future form reusing the id.
    app.post('/manage/:guildId/forms/delete/:formId', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const formId = req.params.formId;

            const form = await loadGuildForm(guildId, formId);
            if (!form) return formsResult(req, res, guildId, 'error', 'form_not_found');

            // A form still wired to a ticket panel would leave that panel opening nothing.
            const [panels] = await pool.execute(
                'SELECT panel_id, panel_name FROM ticket_panels WHERE form_id = ? AND guild_id = ?', [formId, guildId]);
            if (panels.length > 0) {
                return formsResult(req, res, guildId, 'error', 'form_in_use');
            }

            // Take the posted panels down FIRST. form_panels cascades with the form row, but the
            // messages in Discord do not — a surviving panel would be a live button opening a form
            // that no longer exists.
            const [posted] = await pool.execute(
                'SELECT * FROM form_panels WHERE guild_id = ? AND form_id = ?', [guildId, formId]);
            for (const panel of posted) {
                if (!panel.message_id) continue;
                const channel = await botForGuild(guildId)?.channels?.fetch(panel.channel_id).catch(() => null);
                const message = channel ? await channel.messages.fetch(panel.message_id).catch(() => null) : null;
                await message?.delete().catch(() => {});
            }

            await pool.execute('DELETE FROM ticket_form_questions WHERE form_id = ?', [formId]);
            await pool.execute('DELETE FROM form_submissions WHERE form_id = ? AND guild_id = ?', [formId, guildId]);
            await pool.execute('DELETE FROM ticket_forms WHERE form_id = ? AND guild_id = ?', [formId, guildId]);

            logger.info(`[Forms] Deleted form ${formId} from guild ${guildId}`);
            formsResult(req, res, guildId, 'success', 'form_deleted');
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/delete/:formId Error]', error);
            formsResult(req, res, req.params.guildId, 'error', 'delete_failed');
        }
    });

    // The answer formats the builder offers. Served rather than templated in so the picker in the
    // "create form" modal — which opens before any form exists to query — reads the same
    // vocabulary as everything else, straight out of core/form-questions.js.

    // ── Holiday countdowns ────────────────────────────────────────────────────
    // POST pin: either create or re-point a live countdown message in a channel.
    app.post('/manage/:guildId/holidays/pin', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const slug = String(req.body?.slug || '').toLowerCase();
        const channelId = String(req.body?.channel_id || '').trim();
        try {
            const { pinCountdownMessage } = await import('../core/holiday-manager.js');
            const guild = req.guildObject;
            const client = guild.client;
            await pinCountdownMessage(client, { guildId, slug, channelId });
            res.redirect(`/manage/${guildId}?page=holidays`);
        } catch (e) {
            logger.warn('[Manage/holidays] pin failed', { guildId, slug, err: e.message });
            res.redirect(`/manage/${guildId}?page=holidays&err=${encodeURIComponent(e.message)}`);
        }
    });

    // POST unpin: delete the pinned message (best effort) and remove the row.
    app.post('/manage/:guildId/holidays/unpin', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const slug = String(req.body?.slug || '').toLowerCase();
        try {
            const { unpinCountdownMessage } = await import('../core/holiday-manager.js');
            const guild = req.guildObject;
            const client = guild.client;
            await unpinCountdownMessage(client, { guildId, slug });
            res.redirect(`/manage/${guildId}?page=holidays`);
        } catch (e) {
            logger.warn('[Manage/holidays] unpin failed', { guildId, slug, err: e.message });
            res.redirect(`/manage/${guildId}?page=holidays&err=${encodeURIComponent(e.message)}`);
        }
    });

    // POST add auto-reply channel: opt a channel in to live replies when a user
    // posts a /countdown/<slug> URL.
    app.post('/manage/:guildId/holidays/auto-channels/add', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const channelId = String(req.body?.channel_id || '').trim();
        if (!/^\d{15,25}$/.test(channelId)) {
            return res.redirect(`/manage/${guildId}?page=holidays&err=${encodeURIComponent('invalid channel id')}`);
        }
        try {
            const { addAutoChannel } = await import('../core/holiday-auto-reply.js');
            await addAutoChannel(guildId, channelId, null);
            res.redirect(`/manage/${guildId}?page=holidays`);
        } catch (e) {
            logger.warn('[Manage/holidays] auto-add failed', { guildId, channelId, err: e.message });
            res.redirect(`/manage/${guildId}?page=holidays&err=${encodeURIComponent(e.message)}`);
        }
    });

    // POST remove auto-reply channel.
    app.post('/manage/:guildId/holidays/auto-channels/remove', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const channelId = String(req.body?.channel_id || '').trim();
        try {
            const { removeAutoChannel } = await import('../core/holiday-auto-reply.js');
            await removeAutoChannel(guildId, channelId);
            res.redirect(`/manage/${guildId}?page=holidays`);
        } catch (e) {
            logger.warn('[Manage/holidays] auto-remove failed', { guildId, channelId, err: e.message });
            res.redirect(`/manage/${guildId}?page=holidays&err=${encodeURIComponent(e.message)}`);
        }
    });

    app.get('/manage/:guildId/forms/question-types', checkAuth, checkGuildAdmin, (req, res) => {
        res.json({
            types: FORM_QUESTION_TYPES,
            fieldLimit: FORM_MODAL_FIELD_LIMIT,
            optionLimit: FORM_SELECT_OPTION_LIMIT
        });
    });

    // List a form's questions, plus the vocabulary the builder renders its type picker from — one
    // request, so the client never hardcodes a type list that can drift from core/form-questions.js.
    app.get('/manage/:guildId/forms/:formId/questions', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, formId } = req.params;
            const form = await loadGuildForm(guildId, formId);
            if (!form) return res.status(404).json({ error: 'Form not found' });

            const [questions] = await pool.execute(
                'SELECT * FROM ticket_form_questions WHERE form_id = ? ORDER BY question_order ASC, question_id ASC',
                [formId]
            );

            res.json({
                form: {
                    form_id: form.form_id,
                    form_name: form.form_name,
                    form_description: form.form_description,
                    submit_channel_id: form.submit_channel_id,
                    dm_user_ids: parseDmRecipients(form.dm_user_ids),
                    show_questions_on_panel: Number(form.show_questions_on_panel ?? 1),
                    auto_reply: Number(form.auto_reply ?? 0),
                    dm_on_submit: Number(form.dm_on_submit ?? 1)
                },
                questions: questions.map(q => ({
                    ...q,
                    question_options: parseFormOptions(q.question_options)
                })),
                types: FORM_QUESTION_TYPES,
                fieldLimit: FORM_MODAL_FIELD_LIMIT,
                optionLimit: FORM_SELECT_OPTION_LIMIT
            });
        } catch (error) {
            logger.error('[GET /manage/:guildId/forms/:formId/questions Error]', error);
            res.status(500).json({ error: 'Failed to fetch questions' });
        }
    });

    // Add a question
    app.post('/manage/:guildId/forms/:formId/questions', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, formId } = req.params;
            const form = await loadGuildForm(guildId, formId);
            if (!form) return res.status(404).json({ error: 'Form not found' });

            let q;
            try { q = parseQuestionInput(req.body); }
            catch (validationError) { return res.status(400).json({ error: validationError.message }); }

            const [[{ nextOrder }]] = await pool.execute(
                'SELECT COALESCE(MAX(question_order), -1) + 1 AS nextOrder FROM ticket_form_questions WHERE form_id = ?',
                [formId]
            );

            await pool.execute(`
                INSERT INTO ticket_form_questions
                    (form_id, question_text, field_label, question_type, question_options, is_required, placeholder, question_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [formId, q.questionText, q.fieldLabel, q.questionType, q.options, q.isRequired, q.placeholder, nextOrder]);

            // A posted panel embeds the form's wording and its questions, so any change here
            // makes the live message wrong. Push it immediately rather than leaving a Refresh
            // button somebody has to remember.
            syncPanelsForForm(botForGuild(guildId), guildId, formId).catch(() => {});

            logger.info(`[Forms] Added question to form ${formId} (guild ${guildId})`);
            res.json({ ok: true });
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/:formId/questions Error]', error);
            res.status(500).json({ error: 'Failed to add the question.' });
        }
    });

    // Edit a question
    app.post('/manage/:guildId/forms/questions/edit/:questionId', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, questionId } = req.params;

            const [owned] = await pool.execute(`
                SELECT q.question_id, q.form_id FROM ticket_form_questions q
                JOIN ticket_forms f ON f.form_id = q.form_id
                WHERE q.question_id = ? AND f.guild_id = ?`, [questionId, guildId]);
            if (owned.length === 0) return res.status(404).json({ error: 'Question not found' });

            let q;
            try { q = parseQuestionInput(req.body); }
            catch (validationError) { return res.status(400).json({ error: validationError.message }); }

            await pool.execute(`
                UPDATE ticket_form_questions
                SET question_text = ?, field_label = ?, question_type = ?, question_options = ?, is_required = ?, placeholder = ?
                WHERE question_id = ?
            `, [q.questionText, q.fieldLabel, q.questionType, q.options, q.isRequired, q.placeholder, questionId]);

            // A posted panel embeds the form's wording and its questions, so any change here
            // makes the live message wrong. Push it immediately rather than leaving a Refresh
            // button somebody has to remember.
            syncPanelsForForm(botForGuild(guildId), guildId, owned[0].form_id).catch(() => {});

            logger.info(`[Forms] Updated question ${questionId} (guild ${guildId})`);
            res.json({ ok: true });
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/questions/edit/:questionId Error]', error);
            res.status(500).json({ error: 'Failed to save the question.' });
        }
    });

    // Delete a question
    app.post('/manage/:guildId/forms/questions/delete/:questionId', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, questionId } = req.params;

            // Read the form id BEFORE the delete — afterwards there is no row to join back to,
            // and the panels that need refreshing are exactly this form's.
            const [owningRows] = await pool.execute(`
                SELECT q.form_id FROM ticket_form_questions q
                JOIN ticket_forms f ON f.form_id = q.form_id
                WHERE q.question_id = ? AND f.guild_id = ?`, [questionId, guildId]);
            const owningFormId = owningRows[0]?.form_id ?? null;

            const [result] = await pool.execute(`
                DELETE q FROM ticket_form_questions q
                JOIN ticket_forms f ON f.form_id = q.form_id
                WHERE q.question_id = ? AND f.guild_id = ?`, [questionId, guildId]);

            if (result.affectedRows === 0) return res.status(404).json({ error: 'Question not found' });

            if (owningFormId) {
                syncPanelsForForm(botForGuild(guildId), guildId, owningFormId).catch(() => {});
            }

            logger.info(`[Forms] Deleted question ${questionId} (guild ${guildId})`);
            res.json({ ok: true });
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/questions/delete/:questionId Error]', error);
            res.status(500).json({ error: 'Failed to delete the question.' });
        }
    });

    // Reorder questions. Order decides which five questions survive the Discord modal cap, so it
    // is a real setting, not cosmetic.
    app.post('/manage/:guildId/forms/:formId/questions/reorder', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, formId } = req.params;
            const form = await loadGuildForm(guildId, formId);
            if (!form) return res.status(404).json({ error: 'Form not found' });

            const order = Array.isArray(req.body.order) ? req.body.order : [];
            if (order.length === 0) return res.status(400).json({ error: 'No order supplied.' });

            let position = 0;
            for (const questionId of order) {
                await pool.execute(
                    'UPDATE ticket_form_questions SET question_order = ? WHERE question_id = ? AND form_id = ?',
                    [position++, questionId, formId]
                );
            }
            // A posted panel embeds the form's wording and its questions, so any change here
            // makes the live message wrong. Push it immediately rather than leaving a Refresh
            // button somebody has to remember.
            syncPanelsForForm(botForGuild(guildId), guildId, formId).catch(() => {});

            res.json({ ok: true });
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/:formId/questions/reorder Error]', error);
            res.status(500).json({ error: 'Failed to reorder the questions.' });
        }
    });

    // Which ticket panels this form is attached to, and which it could be.
    //
    // ticket_panels.form_id is read by interactions/buttons/ticket_create.js to decide whether
    // clicking a ticket button opens a form first — but until now nothing anywhere WROTE it. The
    // three panels network-wide that have a form got it by hand-editing the database, so building
    // a form and attaching it to a ticket panel was not something an admin could actually do.
    app.get('/manage/:guildId/forms/:formId/panels', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, formId } = req.params;
            const form = await loadGuildForm(guildId, formId);
            if (!form) return res.status(404).json({ error: 'Form not found' });

            const [panels] = await pool.execute(`
                SELECT p.panel_id, p.panel_name, p.is_active, p.form_id, f.form_name AS other_form_name
                  FROM ticket_panels p
             LEFT JOIN ticket_forms f ON f.form_id = p.form_id
                 WHERE p.guild_id = ?
              ORDER BY p.panel_name`, [guildId]);

            res.json({
                panels: panels.map(p => ({
                    panel_id: p.panel_id,
                    panel_name: p.panel_name,
                    is_active: Number(p.is_active) ? 1 : 0,
                    attached: String(p.form_id) === String(formId),
                    // Named so the UI can warn that attaching here replaces another form.
                    other_form_name: String(p.form_id) === String(formId) ? null : (p.other_form_name || null)
                }))
            });
        } catch (error) {
            logger.error('[GET /manage/:guildId/forms/:formId/panels Error]', error);
            res.status(500).json({ error: 'Failed to load ticket panels.' });
        }
    });

    // Attach / detach this form on one ticket panel.
    app.post('/manage/:guildId/forms/:formId/panels', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, formId } = req.params;
            const { panel_id, attach } = req.body;

            const form = await loadGuildForm(guildId, formId);
            if (!form) return res.status(404).json({ error: 'Form not found' });
            if (!panel_id) return res.status(400).json({ error: 'No panel supplied.' });

            if (attach) {
                const [[{ questionCount }]] = await pool.execute(
                    'SELECT COUNT(*) AS questionCount FROM ticket_form_questions WHERE form_id = ?', [formId]);
                if (questionCount === 0) {
                    return res.status(400).json({ error: 'Add at least one question before attaching this form to a panel.' });
                }
                const [result] = await pool.execute(
                    'UPDATE ticket_panels SET form_id = ? WHERE panel_id = ? AND guild_id = ?',
                    [formId, panel_id, guildId]);
                if (result.affectedRows === 0) return res.status(404).json({ error: 'Panel not found.' });
            } else {
                // Scoped to THIS form, so a detach can never clear a different form somebody else
                // attached in the meantime.
                await pool.execute(
                    'UPDATE ticket_panels SET form_id = NULL WHERE panel_id = ? AND guild_id = ? AND form_id = ?',
                    [panel_id, guildId, formId]);
            }

            logger.info(`[Forms] ${attach ? 'Attached' : 'Detached'} form ${formId} ${attach ? 'to' : 'from'} panel ${panel_id} (guild ${guildId})`);
            res.json({ ok: true });
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/:formId/panels Error]', error);
            res.status(500).json({ error: 'Failed to update the panel.' });
        }
    });

    // Send a real DM through the real sender, so "will I actually get these?" is answerable
    // BEFORE a member fills the form in. A closed-DM setting is the single most common reason a
    // notification never arrives, only the recipient can change it, and nothing else in the flow
    // would ever surface it — the submission would look completely successful.
    app.post('/manage/:guildId/forms/:formId/test-dm', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, formId } = req.params;
            const form = await loadGuildForm(guildId, formId);
            if (!form) return res.status(404).json({ error: 'Form not found' });

            // Test whatever is on screen if it was sent, otherwise what is saved.
            const requested = req.body.dm_user_ids ?? form.dm_user_ids;
            const { ids: recipients } = await validateDmRecipients(guildId, requested);
            if (recipients.length === 0) {
                return res.status(400).json({ error: 'No one is set to receive DMs for this form yet.' });
            }

            const bot = botForGuild(guildId);
            if (!bot) return res.status(503).json({ error: 'No bot is connected to this server right now.' });
            const guild = bot.guilds?.cache?.get(guildId) || null;

            const [questions] = await pool.execute(
                `SELECT * FROM ticket_form_questions WHERE form_id = ?
                  ORDER BY question_order ASC, question_id ASC`, [formId]);

            // Sample answers drawn from the real questions, so the test shows the actual layout.
            const answers = {};
            for (const q of questions.slice(0, FORM_MODAL_FIELD_LIMIT)) {
                const choices = parseFormOptions(q.question_options);
                answers[q.question_text] = choices[0] || '(example answer)';
            }
            if (Object.keys(answers).length === 0) answers['(no questions yet)'] = '(example answer)';

            const embed = buildFormResponseEmbed({
                guild, guildId,
                formName: `${form.form_name} — TEST`,
                answers,
                submitter: {
                    id: req.user.id,
                    username: req.user.username,
                    displayName: req.user.global_name || req.user.username,
                    avatarUrl: null
                }
            });
            embed.setFooter({ text: 'This is a test — no one has actually submitted this form.' });

            const { sent, failed } = await deliverFormDm(bot, {
                recipients, embed, formId, guildId, submissionId: null
            });

            res.json({
                success: failed.length === 0,
                message: failed.length === 0
                    ? `Test DM sent to ${sent.length} recipient(s). Check your DMs.`
                    : `Sent to ${sent.length}, failed for ${failed.length}: ` +
                      failed.map(f => `<@${f.userId}> — ${f.reason}`).join(' | '),
                sent,
                failed
            });
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/:formId/test-dm Error]', error);
            res.status(500).json({ error: 'Could not send the test DM.' });
        }
    });

    // ── reply templates ──────────────────────────────────────────────────────
    // The canned replies offered on a response notification. Conditional ones name a question and
    // a substring, and are only suggested when that submission's answer contains it.
    app.get('/manage/:guildId/forms/:formId/reply-templates', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, formId } = req.params;
            const form = await loadGuildForm(guildId, formId);
            if (!form) return res.status(404).json({ error: 'Form not found' });
            res.json({ templates: await listReplyTemplates(guildId, formId), bodyLimit: REPLY_BODY_LIMIT });
        } catch (error) {
            logger.error('[GET reply-templates Error]', error);
            res.status(500).json({ error: 'Failed to load reply templates.' });
        }
    });

    const parseTemplateInput = (body) => {
        const name = String(body.name || '').trim().slice(0, 80);
        if (!name) throw new Error('A saved reply needs a name.');
        const text = String(body.body || '').trim();
        if (!text) throw new Error('A saved reply needs some text.');
        if (text.length > REPLY_BODY_LIMIT) throw new Error(`Replies are limited to ${REPLY_BODY_LIMIT} characters.`);

        // Both halves of the rule or neither — a question with no substring matches everything,
        // which would silently mark every template as "suggested".
        const questionId = body.match_question_id ? Number(body.match_question_id) : null;
        const contains = String(body.match_contains || '').trim().slice(0, 255) || null;
        if ((questionId && !contains) || (!questionId && contains)) {
            throw new Error('A rule needs both a question and the text to look for — or leave both blank.');
        }
        return { name, text, questionId, contains };
    };

    app.post('/manage/:guildId/forms/:formId/reply-templates', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, formId } = req.params;
            const form = await loadGuildForm(guildId, formId);
            if (!form) return res.status(404).json({ error: 'Form not found' });

            let t;
            try { t = parseTemplateInput(req.body); }
            catch (validationError) { return res.status(400).json({ error: validationError.message }); }

            const [[{ nextOrder }]] = await pool.execute(
                'SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextOrder FROM form_reply_templates WHERE form_id = ?',
                [formId]);

            await pool.execute(`
                INSERT INTO form_reply_templates
                    (guild_id, form_id, name, body, match_question_id, match_contains, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [guildId, formId, t.name, t.text, t.questionId, t.contains, nextOrder]);

            logger.info(`[Forms] Added reply template to form ${formId} (guild ${guildId})`);
            res.json({ ok: true });
        } catch (error) {
            logger.error('[POST reply-templates Error]', error);
            res.status(500).json({ error: 'Could not save that reply.' });
        }
    });

    app.post('/manage/:guildId/forms/reply-templates/:templateId/edit', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, templateId } = req.params;
            const existing = await getReplyTemplate(templateId, guildId);
            if (!existing) return res.status(404).json({ error: 'Saved reply not found' });

            let t;
            try { t = parseTemplateInput(req.body); }
            catch (validationError) { return res.status(400).json({ error: validationError.message }); }

            await pool.execute(`
                UPDATE form_reply_templates
                SET name = ?, body = ?, match_question_id = ?, match_contains = ?
                WHERE template_id = ? AND guild_id = ?`,
                [t.name, t.text, t.questionId, t.contains, templateId, guildId]);
            res.json({ ok: true });
        } catch (error) {
            logger.error('[POST reply-template edit Error]', error);
            res.status(500).json({ error: 'Could not save that reply.' });
        }
    });

    app.post('/manage/:guildId/forms/reply-templates/:templateId/delete', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, templateId } = req.params;
            const [result] = await pool.execute(
                'DELETE FROM form_reply_templates WHERE template_id = ? AND guild_id = ?', [templateId, guildId]);
            if (result.affectedRows === 0) return res.status(404).json({ error: 'Saved reply not found' });
            res.json({ ok: true });
        } catch (error) {
            logger.error('[POST reply-template delete Error]', error);
            res.status(500).json({ error: 'Could not delete that reply.' });
        }
    });

    // The finished text of a saved reply for one submission, placeholders already substituted.
    // The dashboard shows this and makes the operator press Send, rather than firing on a dropdown
    // change — the same rule the DM buttons follow.
    app.get('/manage/:guildId/forms/submissions/:submissionId/reply-preview', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, submissionId } = req.params;
            const [[submission]] = await pool.execute(
                'SELECT * FROM form_submissions WHERE submission_id = ? AND guild_id = ?',
                [submissionId, guildId]);
            if (!submission) return res.status(404).json({ error: 'Response not found' });

            const form = await loadGuildForm(guildId, submission.form_id);
            if (!form) return res.status(404).json({ error: 'Form not found' });

            const template = await getReplyTemplate(req.query.template_id, guildId);
            if (!template) return res.status(404).json({ error: 'That saved reply has been deleted.' });

            const bot = botForGuild(guildId);
            res.json({
                name: template.name,
                body: renderReplyBody(template.body, {
                    submitter: {
                        id: submission.user_id,
                        username: submission.username,
                        displayName: submission.display_name || submission.username
                    },
                    form,
                    guild: bot?.guilds?.cache?.get(guildId) || null
                })
            });
        } catch (error) {
            logger.error('[GET reply-preview Error]', error);
            res.status(500).json({ error: 'Could not build that preview.' });
        }
    });

    // Send a reply to one submitter from the dashboard — the same sender the DM buttons use, so a
    // reply sent here is logged and rendered identically to one sent from Discord.
    app.post('/manage/:guildId/forms/submissions/:submissionId/reply', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, submissionId } = req.params;
            const [[submission]] = await pool.execute(
                'SELECT * FROM form_submissions WHERE submission_id = ? AND guild_id = ?',
                [submissionId, guildId]);
            if (!submission) return res.status(404).json({ error: 'Response not found' });

            const form = await loadGuildForm(guildId, submission.form_id);
            if (!form) return res.status(404).json({ error: 'Form not found' });

            let body = req.body.body;
            let templateId = null;
            if (req.body.template_id) {
                const template = await getReplyTemplate(req.body.template_id, guildId);
                if (!template) return res.status(404).json({ error: 'That saved reply has been deleted.' });
                body = template.body;
                templateId = template.template_id;
            }
            if (!String(body || '').trim()) return res.status(400).json({ error: 'Nothing to send.' });

            const bot = botForGuild(guildId);
            if (!bot) return res.status(503).json({ error: 'No bot is connected to this server right now.' });
            const guild = bot.guilds?.cache?.get(guildId) || null;

            const result = await sendFormReply(bot, {
                submission, form, guild, body,
                senderId: req.user.id,
                senderTag: req.user.username,
                templateId
            });
            if (!result.ok) return res.status(400).json({ error: `Not delivered — ${result.reason}` });
            res.json({ success: true, message: 'Reply sent.' });
        } catch (error) {
            logger.error('[POST submission reply Error]', error);
            res.status(500).json({ error: 'Could not send that reply.' });
        }
    });

    // Standalone-panel submissions (ticket-attached forms keep their answers on the ticket itself).
    //
    // New submissions store the submitter's name at the moment they sent it (migration 220).
    // Older rows have only a snowflake, so those are resolved once through the bot and WRITTEN
    // BACK — a read path that looked names up every time would hit Discord on every page view and
    // would still show nothing for anyone who has since left the server.
    app.get('/manage/:guildId/forms/:formId/submissions', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, formId } = req.params;
            const form = await loadGuildForm(guildId, formId);
            if (!form) return res.status(404).json({ error: 'Form not found' });

            const [submissions] = await pool.execute(
                'SELECT * FROM form_submissions WHERE form_id = ? AND guild_id = ? ORDER BY submitted_at DESC LIMIT 200',
                [formId, guildId]
            );

            const unnamed = submissions.filter(s => !s.username);
            if (unnamed.length > 0) {
                const bot = global.botManager?.getClientForGuild(guildId)
                    || global.botManager?.getDefaultClient()
                    || client;
                const guild = bot?.guilds?.cache?.get(guildId) || null;

                // One lookup per distinct user, not per row — the same person may have several.
                const resolved = new Map();
                for (const userId of new Set(unnamed.map(s => s.user_id))) {
                    try {
                        const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
                        const user = member?.user || await bot?.users?.fetch(userId).catch(() => null);
                        if (!user) continue;
                        resolved.set(userId, {
                            username: String(user.username || '').slice(0, 64) || null,
                            display_name: String(member?.nickname || user.globalName || user.displayName || user.username || '').slice(0, 64) || null,
                            avatar_url: String((member?.displayAvatarURL?.({ size: 128 })) || user.displayAvatarURL({ size: 128 }) || '').slice(0, 255) || null
                        });
                    } catch { /* left the server, or Discord is unreachable — leave it unnamed */ }
                }

                for (const row of unnamed) {
                    const found = resolved.get(row.user_id);
                    if (!found) continue;
                    Object.assign(row, found);
                    await pool.execute(
                        'UPDATE form_submissions SET username = ?, display_name = ?, avatar_url = ? WHERE submission_id = ?',
                        [found.username, found.display_name, found.avatar_url, row.submission_id]
                    ).catch(() => {});
                }
                if (resolved.size > 0) {
                    logger.info(`[Forms] Backfilled ${resolved.size} submitter identit(ies) for form ${formId}`);
                }
            }

            // Recent DM outcomes, so a silent delivery failure is visible next to the responses
            // it was supposed to announce.
            const [deliveries] = await pool.execute(
                `SELECT user_id, status, error, attempted_at FROM form_dm_deliveries
                  WHERE form_id = ? AND guild_id = ? ORDER BY attempted_at DESC LIMIT 20`,
                [formId, guildId]
            ).catch(() => [[]]);

            // What has already been said to each applicant, so nobody gets the same instructions
            // twice — and so a failed reply is visible next to the response it belongs to.
            // Oldest first: this is a transcript now that applicants' replies are forwarded in
            // too, and a conversation read newest-first is not a conversation.
            const [replies] = await pool.execute(
                `SELECT reply_id, submission_id, sender_id, direction, body, status, error, sent_at
                   FROM form_replies WHERE form_id = ? AND guild_id = ?
                  ORDER BY sent_at ASC LIMIT 200`,
                [formId, guildId]
            ).catch(() => [[]]);

            const [questions] = await pool.execute(
                `SELECT * FROM ticket_form_questions WHERE form_id = ?
                  ORDER BY question_order ASC, question_id ASC`, [formId]);
            const templates = await listReplyTemplates(guildId, formId).catch(() => []);

            // Rank per submission: which saved reply this person's own answers point at.
            const ranked = {};
            for (const sub of submissions) {
                let answers = {};
                try { answers = JSON.parse(sub.submission_data || '{}'); } catch { answers = {}; }
                ranked[sub.submission_id] = rankReplyTemplates(templates, answers, questions)
                    .map(t => ({ template_id: t.template_id, name: t.name, matched: t.matched }));
            }

            res.json({ submissions, deliveries, replies, templates, ranked });
        } catch (error) {
            logger.error('[GET /manage/:guildId/forms/:formId/submissions Error]', error);
            res.status(500).json({ error: 'Failed to fetch submissions' });
        }
    });

    // Export streamer subscriptions as CSV
    app.get('/manage/:guildId/export', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;

            // The guild's stream subscriptions (subscriptions + streamers; stream_notifications never existed)
            const [subscriptions] = await pool.execute(
                `SELECT st.username AS streamer_name, st.platform, sub.announcement_channel_id AS channel_id,
                        sub.live_role_id AS role_id, sub.custom_message AS message, st.discord_user_id
                 FROM subscriptions sub
                 JOIN streamers st ON st.streamer_id = sub.streamer_id
                 WHERE sub.guild_id = ? AND sub.departed_at IS NULL
                 ORDER BY st.platform, st.username`,
                [guildId]
            );

            // Quote every cell, double embedded quotes, and neutralise leading = + - @ so a
            // spreadsheet can't treat a streamer name or message as a formula.
            const csvCell = (value) => {
                let text = String(value ?? '');
                if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
                return `"${text.replace(/"/g, '""')}"`;
            };
            const csvHeaders = ['Streamer Name', 'Platform', 'Channel ID', 'Role ID', 'Message', 'Discord User ID'];
            const csvRows = subscriptions.map(sub => [
                sub.streamer_name, sub.platform, sub.channel_id, sub.role_id, sub.message, sub.discord_user_id
            ]);

            // Build CSV string
            const csvContent = [
                csvHeaders.map(csvCell).join(','),
                ...csvRows.map(row => row.map(csvCell).join(','))
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

    // Post (or re-post) a form panel.
    //
    // UPSERT, not insert. UNIQUE (guild_id, form_id, channel_id) means posting the same form to a
    // channel that already has it updates the existing message rather than leaving two live
    // panels behind — which is the mess that made "edit the posted form" impossible before.
    app.post('/manage/:guildId/forms/create-panel', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const guildId = req.params.guildId;
            const { form_id, channel_id, panel_title, panel_description, button_text } = req.body;

            if (!form_id || !channel_id) {
                return formsResult(req, res, guildId, 'error', 'missing_fields');
            }

            const bot = botForGuild(guildId);
            if (!bot) return formsResult(req, res, guildId, 'error', 'bot_not_found');

            const loaded = await loadFormWithQuestions(guildId, form_id);
            if (!loaded) return formsResult(req, res, guildId, 'error', 'form_not_found');
            if (loaded.questions.length === 0) {
                return formsResult(req, res, guildId, 'error', 'no_questions');
            }

            const channel = await bot.channels.fetch(channel_id).catch(() => null);
            if (!channel) return formsResult(req, res, guildId, 'error', 'channel_not_found');

            const { PermissionsBitField } = await import('discord.js');
            const me = channel.guild?.members?.me;
            if (me && channel.permissionsFor) {
                const perms = channel.permissionsFor(me);
                const missing = [];
                if (!perms?.has(PermissionsBitField.Flags.ViewChannel)) missing.push('View Channel');
                if (!perms?.has(PermissionsBitField.Flags.SendMessages)) missing.push('Send Messages');
                if (!perms?.has(PermissionsBitField.Flags.EmbedLinks)) missing.push('Embed Links');
                if (missing.length) {
                    return formsResult(req, res, guildId, 'error',
                        `${bot.user?.username || 'The bot'} is missing ${missing.join(' + ')} in #${channel.name}.`);
                }
            }

            const settings = {
                panel_title: panel_title ? String(panel_title).slice(0, 256) : null,
                panel_description: panel_description ? String(panel_description).slice(0, 4000) : null,
                button_text: button_text ? String(button_text).slice(0, 80) : null,
            };

            await pool.execute(`
                INSERT INTO form_panels (guild_id, form_id, channel_id, panel_title, panel_description, button_text)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    panel_title = VALUES(panel_title),
                    panel_description = VALUES(panel_description),
                    button_text = VALUES(button_text)`,
                [guildId, form_id, channel_id, settings.panel_title, settings.panel_description, settings.button_text]);

            // Re-read rather than trusting insertId: on the duplicate-key path insertId is not the
            // existing row, and MariaDB's affectedRows cannot tell insert from update either.
            const [[panel]] = await pool.execute(
                'SELECT * FROM form_panels WHERE guild_id = ? AND form_id = ? AND channel_id = ?',
                [guildId, form_id, channel_id]);

            const result = await pushFormPanel(bot, panel, loaded);
            if (result.error) return formsResult(req, res, guildId, 'error', 'channel_not_found');
            await pool.execute('UPDATE form_panels SET message_id = ? WHERE panel_id = ?',
                [result.messageId, panel.panel_id]);

            logger.info(`[Forms] Panel ${panel.panel_id} for form ${form_id} posted in ${channel_id}`);
            formsResult(req, res, guildId, 'success', 'panel_created');
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/create-panel Error]', error);
            const REASONS = {
                50013: 'the bot is missing permission to post in that channel',
                50001: 'the bot cannot see that channel',
                10003: 'that channel no longer exists',
                50035: 'Discord rejected the panel content — check the title, description and button text lengths',
            };
            const reason = REASONS[error?.code] || error?.message || 'unknown error';
            formsResult(req, res, req.params.guildId, 'error', `Could not post the panel: ${reason}.`);
        }
    });

    // The panels a form has posted, with whether each message is still live.
    app.get('/manage/:guildId/forms/:formId/posted-panels', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, formId } = req.params;
            const form = await loadGuildForm(guildId, formId);
            if (!form) return res.status(404).json({ error: 'Form not found' });

            const [panels] = await pool.execute(
                'SELECT * FROM form_panels WHERE guild_id = ? AND form_id = ? ORDER BY panel_id',
                [guildId, formId]);

            const bot = botForGuild(guildId);
            const enriched = [];
            for (const panel of panels) {
                const channel = await bot?.channels?.fetch(panel.channel_id).catch(() => null);
                // "Is the message still there?" is the question that decides whether the UI offers
                // Update or Re-post, so it is answered live rather than assumed from message_id.
                let live = false;
                if (channel && panel.message_id) {
                    live = Boolean(await channel.messages.fetch(panel.message_id).catch(() => null));
                }
                enriched.push({
                    ...panel,
                    channel_name: channel?.name || null,
                    message_url: panel.message_id
                        ? `https://discord.com/channels/${guildId}/${panel.channel_id}/${panel.message_id}`
                        : null,
                    live
                });
            }
            res.json({ panels: enriched });
        } catch (error) {
            logger.error('[GET /manage/:guildId/forms/:formId/posted-panels Error]', error);
            res.status(500).json({ error: 'Failed to load posted panels.' });
        }
    });

    // Edit a posted panel's wording, then push it. One button, no re-posting.
    app.post('/manage/:guildId/forms/panels/:panelId/edit', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, panelId } = req.params;
            const [[panel]] = await pool.execute(
                'SELECT * FROM form_panels WHERE panel_id = ? AND guild_id = ?', [panelId, guildId]);
            if (!panel) return res.status(404).json({ error: 'Panel not found' });

            // Absent means "leave it alone", not "clear it". A bare {} body is how Re-post asks
            // for a push without touching the wording; treating that as a clear would silently
            // wipe a customised panel every time somebody re-posted it.
            const keep = (incoming, current, cap) =>
                incoming === undefined ? current : (incoming ? String(incoming).slice(0, cap) : null);
            const updates = {
                panel_title: keep(req.body.panel_title, panel.panel_title, 256),
                panel_description: keep(req.body.panel_description, panel.panel_description, 4000),
                button_text: keep(req.body.button_text, panel.button_text, 80),
            };
            await pool.execute(
                'UPDATE form_panels SET panel_title = ?, panel_description = ?, button_text = ? WHERE panel_id = ?',
                [updates.panel_title, updates.panel_description, updates.button_text, panelId]);

            const loaded = await loadFormWithQuestions(guildId, panel.form_id);
            const result = await pushFormPanel(botForGuild(guildId), { ...panel, ...updates }, loaded);
            if (result.error) return res.status(400).json({ error: `Saved, but could not update the message: ${result.error}.` });
            await pool.execute('UPDATE form_panels SET message_id = ? WHERE panel_id = ?', [result.messageId, panelId]);

            res.json({ ok: true, reposted: result.reposted });
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/panels/:panelId/edit Error]', error);
            res.status(500).json({ error: error?.code === 50013
                ? 'The bot is missing permission to post in that channel.'
                : 'Could not update the panel.' });
        }
    });

    // Delete the panel message and stop tracking it.
    app.post('/manage/:guildId/forms/panels/:panelId/delete', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, panelId } = req.params;
            const [[panel]] = await pool.execute(
                'SELECT * FROM form_panels WHERE panel_id = ? AND guild_id = ?', [panelId, guildId]);
            if (!panel) return res.status(404).json({ error: 'Panel not found' });

            if (panel.message_id) {
                const channel = await botForGuild(guildId)?.channels?.fetch(panel.channel_id).catch(() => null);
                const message = channel ? await channel.messages.fetch(panel.message_id).catch(() => null) : null;
                // Already gone in Discord is a success, not an error — the goal is that it is gone.
                await message?.delete().catch(() => {});
            }
            await pool.execute('DELETE FROM form_panels WHERE panel_id = ?', [panelId]);

            logger.info(`[Forms] Panel ${panelId} removed from guild ${guildId}`);
            res.json({ ok: true });
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/panels/:panelId/delete Error]', error);
            res.status(500).json({ error: 'Could not remove the panel.' });
        }
    });

    // Adopt a panel this bot posted before panels were tracked, so it can be managed rather than
    // abandoned next to its replacement.
    app.post('/manage/:guildId/forms/:formId/adopt-panel', checkAuth, checkGuildAdmin, async (req, res) => {
        try {
            const { guildId, formId } = req.params;
            const form = await loadGuildForm(guildId, formId);
            if (!form) return res.status(404).json({ error: 'Form not found' });

            // Accept a full message link or a bare id — a link is what Discord's Copy Message Link
            // actually puts on the clipboard.
            const raw = String(req.body.message || '').trim();
            const link = raw.match(/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})/);
            const channelId = link ? link[2] : String(req.body.channel_id || '').trim();
            const messageId = link ? link[3] : raw;
            if (!/^\d{17,20}$/.test(channelId) || !/^\d{17,20}$/.test(messageId)) {
                return res.status(400).json({ error: 'Paste the message link (right-click the panel → Copy Message Link).' });
            }

            const bot = botForGuild(guildId);
            const channel = await bot?.channels?.fetch(channelId).catch(() => null);
            const message = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;
            if (!message) return res.status(404).json({ error: 'That message could not be found.' });

            // NOT `message.editable`. That getter also requires channel.viewable to be resolvable
            // on the fetched channel, so it returns false for messages this bot posted and can
            // perfectly well edit — which is how a panel YYZ Studio had just posted was rejected
            // as "not posted by this bot". Ownership is the real question, so ask it directly.
            //
            // Any of our clients that authored it will do: a guild can have several of our bots,
            // and getClientForGuild returns one of them, not necessarily the author.
            const authorId = message.author?.id;
            const owningClient = [...(global.botManager?.clients?.values?.() ?? [bot])]
                .find(candidate => candidate?.user?.id === authorId
                    && candidate.guilds?.cache?.has(guildId));
            if (!owningClient) {
                return res.status(400).json({
                    error: `That message was posted by ${message.author?.username || 'someone else'}, `
                        + 'not by a bot this dashboard controls, so it cannot be edited.'
                });
            }

            await pool.execute(`
                INSERT INTO form_panels (guild_id, form_id, channel_id, message_id)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE message_id = VALUES(message_id)`,
                [guildId, formId, channelId, messageId]);

            // Sync through the client that actually owns the message, not whichever one happened
            // to be resolved for the guild.
            await syncPanelsForForm(owningClient, guildId, formId);
            logger.info(`[Forms] Adopted existing panel message ${messageId} for form ${formId}`);
            res.json({ ok: true });
        } catch (error) {
            logger.error('[POST /manage/:guildId/forms/:formId/adopt-panel Error]', error);
            res.status(500).json({ error: 'Could not adopt that message.' });
        }
    });

    // ===== STARBOARD CONFIGURATION ROUTES =====

    // Save one starboard (board_id empty = a new board). The page script sends it with
    // X-Requested-With and gets JSON back; a plain form post is redirected to the board.
    // Validation and storage: core/starboard-manager.js (shared with /api/guilds/:guildId/starboard).
    app.post('/manage/:guildId/starboard/config', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        const wantsJson = req.xhr || /json/.test(String(req.get('accept') || ''));
        const fail = (status, error) => wantsJson
            ? res.status(status).json({ success: false, error })
            : res.redirect(`/manage/${guildId}?page=starboard&error=${encodeURIComponent(error)}`);
        try {
            const { validateBoardInput, saveBoard } = await import('../core/starboard-manager.js');
            const body = req.body || {};
            const boardId = /^\d{1,10}$/.test(String(body.board_id || '')) ? Number(body.board_id) : null;
            const guild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId) || req.guildObject || null;
            const result = validateBoardInput({
                ...body,
                channel_id: body.channelId ?? body.channel_id,
                star_threshold: body.threshold ?? body.star_threshold,
            }, guild);
            if (!result.ok) return fail(400, result.error);
            const saved = await saveBoard(guildId, boardId, result.board);
            if (!saved.ok) return fail(400, saved.error);

            logger.info(`[Starboard] Board ${saved.id} ${boardId ? 'updated' : 'created'} for guild ${guildId}`, { threshold: result.board.star_threshold });
            if (wantsJson) return res.json({ success: true, message: boardId ? 'Starboard saved' : 'Starboard created', boardId: saved.id });
            res.redirect(`/manage/${guildId}?page=starboard&board=${saved.id}&success=config_saved`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/starboard/config Error]', error);
            fail(500, 'Could not save the starboard.');
        }
    });

    // Delete one starboard (its posts already in Discord stay).
    app.post('/manage/:guildId/starboard/delete', checkAuth, checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        try {
            const boardId = Number.parseInt(req.body?.board_id, 10);
            if (!Number.isInteger(boardId) || boardId < 1) return res.redirect(`/manage/${guildId}?page=starboard&error=missing_fields`);
            const { deleteBoard } = await import('../core/starboard-manager.js');
            await deleteBoard(guildId, boardId);
            logger.info(`[Starboard] Board ${boardId} deleted for guild ${guildId}`);
            res.redirect(`/manage/${guildId}?page=starboard&success=deleted`);
        } catch (error) {
            logger.error('[POST /manage/:guildId/starboard/delete Error]', error);
            res.redirect(`/manage/${guildId}?page=starboard&error=failed`);
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
                ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`, /* NULL = not posted yet: message_id is UNIQUE, so a 'PENDING' sentinel let only one unposted panel exist across every server */
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

            const [mappings] = await pool.execute(
                'SELECT * FROM reaction_role_mappings WHERE panel_id = ? ORDER BY id ASC', [panelId]);
            if (mappings.length === 0) {
                return res.redirect(`/manage/${guildId}?page=reaction-roles&error=no_mappings`);
            }

            // Post the replacement BEFORE removing the old one. The reverse order used to
            // delete the live panel and then fail on the DB write, leaving the channel with
            // no panel and the row pointing at a message that no longer existed.
            const { postPanelMessage } = await import('../core/reaction-role-manager.js');
            const posted = await postPanelMessage({ panel, mappings, botClient });
            if (!posted.ok) {
                logger.warn(`[Reaction Roles] Repost of panel ${panelId} did not post: ${posted.error}`);
                return res.redirect(`/manage/${guildId}?page=reaction-roles&error=repost_failed`);
            }

            const oldMessageId = panel.message_id;
            if (oldMessageId && oldMessageId !== 'PENDING' && oldMessageId !== posted.message.id) {
                try {
                    const oldChannel = await botClient.channels.fetch(panel.channel_id).catch(() => null);
                    const oldMsg = oldChannel ? await oldChannel.messages.fetch(oldMessageId).catch(() => null) : null;
                    if (oldMsg) await oldMsg.delete().catch(() => {});
                } catch { /* old message may already be gone */ }
            }

            logger.info(`[Reaction Roles] Panel ${panelId} reposted in guild ${guildId} as message ${posted.message.id}`);
            res.redirect(`/manage/${guildId}?page=reaction-roles&success=panel_reposted`);
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

            // One renderer for every path that touches a panel's message. This used to be a
            // third inline copy of the component builder — it edited `components` without
            // `embeds`, so the embed's role list went stale, and it ignored the panel's own
            // select placeholder and max_selections.
            const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient() || client;
            const { refreshPanelMessage } = await import('../core/reaction-role-manager.js');
            await refreshPanelMessage({ guildId, panelId, botClient });

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

            // Get the correct bot client for this guild
            const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient() || client;

            // Same helper the Repost button uses — building and recording the message in one
            // place is what keeps a reposted panel identical to a freshly posted one.
            const { postPanelMessage } = await import('../core/reaction-role-manager.js');
            const posted = await postPanelMessage({ panel, mappings, botClient });
            if (!posted.ok) return res.json({ success: false, error: posted.error });

            res.json({
                success: true,
                message_id: posted.message.id,
                channel_id: posted.message.channelId
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

    // Commands page. Every field is derived from the live command collection by
    // `core/command-catalog.js`, so the page cannot drift from what the bot actually does.
    app.get('/commands', (req, res) => {
        const catalog = getCatalog(client);
        const categories = [...new Set(catalog.commands.map(c => c.category))].sort();
        res.render('commands-catalog', {
            user: req.user,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID,
            catalog,
            categories
        });
    });

    // Same data as JSON, for anyone who would rather grep it than scroll it.
    app.get('/api/commands', (req, res) => {
        res.set('Cache-Control', 'public, max-age=300').json(getCatalog(client));
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

            // The page shows each streamer's platform picture; it never used Discord avatars, so
            // they are no longer fetched (one Discord API call per live streamer, in series).
            const liveStreamers = Array.from(streamerMap.values());

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
            tiktok: `https://tiktok.com/@${username}`,
            facebook: `https://facebook.com/${username}`,
            rumble: `https://rumble.com/user/${username}`
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

    // Settings page.
    // THEMES/DENSITIES come from core/user-preferences.js so the picker is built
    // from the same list the validator accepts — adding a theme is one entry in
    // one file, and the UI can never offer something the API would reject.
    app.get('/settings', checkAuth, (req, res) => {
        res.render('settings-tailwind', {
            user: req.user,
            themes: THEMES,
            densities: DENSITIES,
            layouts: LAYOUTS,
            styles: STYLES,
            sections: SECTIONS,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID
        });
    });

    // Per-USER Buy Me a Coffee link page (login-only; user-scoped, NOT guild-admin)
    app.get('/buymeacoffee', checkAuth, (req, res) => {
        res.render('buymeacoffee-tailwind', {
            user: req.user,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID
        });
    });

    // Stream Team Signup page (PUBLIC — anyone with a Twitch can apply; logged-in
    // users get a richer, linked ticket they can chat in). No checkAuth.
    app.get('/stream-team', (req, res) => {
        res.render('stream-team-tailwind', {
            user: req.user || null,
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

    // How-to guides (dashboard/content/guides/*.js): the index and one page per guide, both from
    // views/docs-guides.ejs. The slug is only ever a key into the guide list, never a file path; an
    // unknown slug falls through to the 404. app.locals.siteGuides lets /docs and the home page link
    // the guides and show their screenshots (public/img/guides/manifest.json, scripts/site-shots).
    app.locals.siteGuides = Object.freeze({ GUIDES, AREAS, getGuide, guideImage, inline: guideInline });
    // Short guide links (/guides, /guides/<slug>) go to the real pages under /docs/guides. CertiFried Studio 0.2.1 links here.
    app.get(['/guides', '/guides/:slug'], (req, res) => {
        const slug = req.params.slug && /^[a-z0-9-]{1,64}$/.test(req.params.slug) ? `/${req.params.slug}` : '';
        res.redirect(301, `/docs/guides${slug}`);
    });
    app.get(['/docs/guides', '/docs/guides/:slug'], (req, res, next) => {
        const guide = req.params.slug === undefined ? null : getGuide(req.params.slug);
        if (req.params.slug !== undefined && !guide) return next();
        res.render('docs-guides', {
            user: req.user,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID,
            guide, guides: GUIDES, areas: AREAS, guideImage, inline: guideInline,
        });
    });

    // Docs search (dashboard/services/docs-search.js): the guides, the /docs and /docs/rpg sections and the
    // command list in one index, built in this process from those sources (no outside search service).
    // /docs/search.json is what the search box on /docs and /docs/guides loads and searches in the browser;
    // /docs/search?q= runs the same search here, for readers without JavaScript.
    const renderDocsView = (view) => new Promise((resolve, reject) => app.render(view, {
        user: null, clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID,
    }, (err, html) => (err ? reject(err) : resolve(html))));
    const docsSearch = createDocsSearch({
        getGuides: () => ({ GUIDES, AREAS }),
        getCatalog: () => getCatalog(client),
        renderPages: async () => [
            { url: '/docs', page: 'Documentation', html: await renderDocsView('docs-tailwind'), skip: ['guides', 'features'] },
            { url: '/docs/rpg', page: 'RPG guide', html: await renderDocsView('docs-rpg') },
        ],
    });
    app.get('/docs/search.json', async (req, res) => {
        try {
            const { body, etag } = await docsSearch.get();
            res.set('Cache-Control', 'public, max-age=300').set('ETag', etag).type('application/json').send(body);
        } catch (error) {
            logger.error('[Docs search] could not build the index', { error: error.message });
            res.status(503).json({ error: 'Search is not available right now.' });
        }
    });
    app.get('/docs/search', async (req, res) => {
        const q = typeof req.query.q === 'string' ? req.query.q.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
        let results = null;
        let unavailable = false;
        if (q) {
            try { results = await docsSearch.search(q); } catch (error) {
                unavailable = true;
                logger.error('[Docs search] search failed', { error: error.message });
            }
        }
        res.render('docs-search', {
            user: req.user, clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID,
            q, results, unavailable,
        });
    });

    // JWT Tools page
    app.get('/tools/jwt', (req, res) => {
        res.render('tools-jwt', {
            user: req.user,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID
        });
    });

    // Public threat-intel feed (P3.3) — developer wedge.
    const threatCache = { stats: null, statsAt: 0 };
    app.get('/api/public/threats/stats', async (req, res) => {
        try {
            const now = Date.now();
            if (!threatCache.stats || now - threatCache.statsAt > 5 * 60_000) {
                const [[d]] = await pool.execute('SELECT COUNT(*) AS n, MAX(last_seen_at) AS newest FROM phishing_domains');
                const [[b]] = await pool.execute('SELECT COUNT(*) AS n, MAX(created_at) AS newest FROM global_ban_entries');
                const [[s]] = await pool.execute('SELECT COUNT(*) AS n FROM blocked_images');
                threatCache.stats = {
                    phishing_domains:  { count: Number(d.n), newest: d.newest },
                    global_bans:       { count: Number(b.n), newest: b.newest },
                    blocked_images:    { count: Number(s.n) },
                    generated_at:      new Date().toISOString(),
                };
                threatCache.statsAt = now;
            }
            res.set('Access-Control-Allow-Origin', '*');
            res.set('Cache-Control', 'public, max-age=300');
            res.json(threatCache.stats);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/public/threats/domains', async (req, res) => {
        try {
            const sinceRaw = String(req.query.since || '').slice(0, 40);
            const since = sinceRaw ? new Date(sinceRaw) : new Date(Date.now() - 24 * 60 * 60 * 1000);
            if (isNaN(since.getTime())) return res.status(400).json({ error: 'bad since' });
            const [rows] = await pool.execute(
                `SELECT domain, source, added_at, last_seen_at FROM phishing_domains
                  WHERE last_seen_at >= ? ORDER BY last_seen_at DESC LIMIT 10000`,
                [since]);
            res.set('Access-Control-Allow-Origin', '*');
            res.set('Cache-Control', 'public, max-age=300');
            res.json({ since: since.toISOString(), count: rows.length, items: rows });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/public/threats/global-bans', async (req, res) => {
        try {
            const crypto = await import('node:crypto');
            const salt = process.env.THREAT_INTEL_SALT || 'cf-threat-intel';
            const [rows] = await pool.execute(
                `SELECT user_id, severity, category, source, created_at FROM global_ban_entries
                  ORDER BY created_at DESC LIMIT 1000`);
            const items = rows.map(r => ({
                user_hash: crypto.default.createHash('sha256').update(salt + ':' + r.user_id).digest('hex').slice(0, 20),
                severity: r.severity, category: r.category, source: r.source, at: r.created_at,
            }));
            res.set('Access-Control-Allow-Origin', '*');
            res.set('Cache-Control', 'public, max-age=300');
            res.json({ count: items.length, items });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Public feature-matrix page — CertiFried vs the field.
    app.get('/compare', (req, res) => {
        res.render('feature-matrix-tailwind', { user: req.user, clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID });
    });

    // Public Fortnite sprite catalog — data/pak-scan.json served with CORS +
    // short in-memory cache. See /sprites/info for human-readable catalog audit.
    const spriteCache = { at: 0, bytes: null, mtime: 0 };
    app.get('/api/public/sprites/catalog', async (req, res) => {
        try {
            const fs = await import('node:fs/promises');
            const path = await import('node:path');
            const file = path.default.join(process.cwd(), 'data', 'pak-scan.json');
            const st = await fs.default.stat(file);
            const now = Date.now();
            if (!spriteCache.bytes || st.mtimeMs !== spriteCache.mtime || now - spriteCache.at > 5 * 60_000) {
                spriteCache.bytes = await fs.default.readFile(file);
                spriteCache.mtime = st.mtimeMs;
                spriteCache.at = now;
            }
            res.set('Content-Type', 'application/json; charset=utf-8');
            res.set('Access-Control-Allow-Origin', '*');
            res.set('Cache-Control', 'public, max-age=300');
            res.set('X-Catalog-Updated', new Date(st.mtime).toISOString());
            res.send(spriteCache.bytes);
        } catch (err) {
            res.status(500).json({ ok: false, error: 'sprite catalog unavailable: ' + err.message });
        }
    });

    // Public changelog — derived from migrations/*.js header comments.
    const changelogCache = { at: 0, entries: [] };
    app.get('/changelog', async (req, res) => {
        try {
            const now = Date.now();
            if (now - changelogCache.at < 60_000 && changelogCache.entries.length) {
                return res.render('changelog-tailwind', { user: req.user, clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID, entries: changelogCache.entries });
            }
            // dashboard/services/changelog.js: migration headers, with user-written notes for recent
            // migrations, team-only references taken out, and unrun migrations left off.
            const { buildChangelog } = await import('./services/changelog.js');
            let recorded = null;
            try { const [rows] = await pool.query('SELECT name FROM migrations'); recorded = new Set(rows.map(r => r.name)); } catch { /* show every file */ }
            const entries = await buildChangelog(path.join(process.cwd(), 'migrations'), { recorded });
            changelogCache.at = now;
            changelogCache.entries = entries;
            res.render('changelog-tailwind', { user: req.user, clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID, entries });
        } catch (err) {
            res.status(500).send('Changelog temporarily unavailable: ' + err.message);
        }
    });

    // Terms of Service page
    app.get('/terms', (req, res) => {
        res.render('terms-tailwind', {
            user: req.user,
            clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID
        });
    });

    // Add-the-bot link used by the site header, footer and docs. The default asks for the
    // permissions the current features use; ?admin=1 asks for Administrator instead.
    // ?account=1 adds CertiFried to the member's own Discord account (User Install), which is how members of a
    // server run by a custom-branded bot open Watch Together and Greenhouse (docs/activities.md).
    app.get('/invite', (req, res) => {
        const id = process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID;
        if (!id) return res.redirect('/docs#getting-started');
        if (req.query.account === '1') return res.redirect(`https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(id)}&integration_type=1&scope=applications.commands`);
        const perms = req.query.admin === '1' ? '8' : '1643797540086';
        res.redirect(`https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(id)}&permissions=${perms}&scope=bot+applications.commands`);
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

    // End User License Agreement page
    app.get('/eula', (req, res) => {
        res.render('eula-tailwind', {
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

    // Public event-schedule API (H-647): the live panel and "Download as JSON" on /schedule/<event> are public, but
    // the /api routers below require a login. Hand exactly these two endpoints to routes/public-schedule.js first.
    app.get(['/api/schedule/:eventSlug/ticker', '/api/schedule/:eventSlug/export'], async (req, res, next) => {
        try {
            if (!app._publicScheduleRouter) app._publicScheduleRouter = (await import('./routes/public-schedule.js')).default;
            app._publicScheduleRouter(req, res, next);
        } catch (err) {
            logger.warn(`[public-schedule api] ${err.message}`);
            next();
        }
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

    import('./routes/features/suggestion-tags.js').then(({ default: suggestionTagsRouter }) => {
        app.use('/manage/:guildId', checkAuth, checkGuildAdmin, suggestionTagsRouter);
    }).catch(err => {
        logger.error('Failed to load suggestion-tags routes:', err);
    });

    import('./routes/features/statistics.js').then(({ default: statisticsRouter }) => {
        app.use('/', statisticsRouter);
    }).catch(err => {
        logger.error('Failed to load statistics routes:', err);
    });

    // Deliberately UNAUTHENTICATED — the server owner it is for has no dashboard account. Access is
    // the capability URL itself (/owner/<43-char token>); an unknown token is a flat 404. See the
    // header of routes/kabster.js before touching this.
    //
    // Mounted twice, on purpose. `/owner` is the path we mint and the one anybody new is sent; the
    // original `/kabster` stays alive because links already in somebody's DMs must keep working, and
    // silently 404ing a capability URL is indistinguishable from revoking it.
    import('./routes/kabster.js').then(({ default: ownerRouter }) => {
        app.use('/owner', ownerRouter);
        app.use('/kabster', ownerRouter);
    }).catch(err => {
        logger.error('Failed to load owner questionnaire routes:', err);
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

    import('./routes/auth-twitch-write.js').then(({ default: authTwitchWriteRouter }) => {
        app.use('/', authTwitchWriteRouter);
        logger.info('[Dashboard] Twitch write-scope OAuth routes loaded');
    }).catch(err => {
        logger.error('Failed to load Twitch write-scope auth routes:', err);
    });

    import('./routes/twitch-roles-manage.js').then(({ default: twitchRolesManageRouter }) => {
        app.use('/', twitchRolesManageRouter);
        logger.info('[Dashboard] Twitch roles manager routes loaded');
    }).catch(err => {
        logger.error('Failed to load Twitch roles manager routes:', err);
    });

    import('./routes/auth-discord-linked-role.js').then(({ default: router }) => {
        app.use('/', router);
        logger.info('[Dashboard] Discord Linked Role OAuth broker loaded');
    }).catch(err => {
        logger.error('Failed to load Discord Linked Role broker:', err);
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

    // ── Retired legacy "Tokes Bot" web panel ─────────────────────────────────
    // The /tokes-bot pages and their JSON APIs were retired. Only the Kick/Twitch
    // OAuth flow under /tokes-bot/auth/** is still live (/kick logs in through it).
    // Old API calls get a JSON 410; every other /tokes-bot URL goes to '/'.
    app.use('/tokes-bot', (req, res, next) => {
        // req.path here is relative to the '/tokes-bot' mount point.
        if (req.path.startsWith('/auth/')) return next();
        if (req.path.startsWith('/api/')) return res.status(410).json({ error: 'This API has been retired' });
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

    // Kick Defender dashboard (/kick) — reuses the Kick login (tokesUser).
    import('./routes/kick-defender.js').then(({ default: kickDefenderRouter }) => {
        app.use('/', kickDefenderRouter);
    }).catch(err => {
        logger.error('Failed to load Kick Defender routes:', err);
    });

    import('./routes/kick-channel.js').then(({ default: kickChannelRouter }) => {
        app.use('/', kickChannelRouter);
    }).catch(err => {
        logger.error('Failed to load Kick channel routes:', err);
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
    app.use('/', twitchAnalyticsPageRouter);
    app.use('/', discordNativePageRouter);
    app.use('/', apiOverviewPageRouter);

    // Multicast streaming UI + API
    app.use('/', streamRouter);

    // Stream bot (core/stream-bot, docs/superpowers/specs/2026-11-19-stream-bot-design.md): the Stream bot
    // Twitch grant, and the /stream/bot pages and API. Separate imports so one failing cannot take the other down.
    import('./routes/auth-twitch-streambot.js').then(({ default: streamBotGrantRouter }) => {
        app.use('/', streamBotGrantRouter);
    }).catch(err => {
        logger.error('Failed to load stream bot grant routes:', err);
    });
    import('./routes/stream-bot.js').then(({ default: streamBotRouter }) => {
        app.use('/', streamBotRouter);
    }).catch(err => {
        logger.error('Failed to load stream bot routes:', err);
    });
    // Stream bot timers (/stream/bot/timers): the existing timer table and job, for Twitch and Kick (core/stream-bot/timers.js).
    import('./routes/stream-bot-timers.js').then(({ default: streamBotTimersRouter }) => {
        app.use('/', streamBotTimersRouter);
    }).catch(err => {
        logger.error('Failed to load stream bot timer routes:', err);
    });
    // Stream bot Viewers (/stream/bot/viewers): viewer records, loyalty points and ranks (core/stream-bot/viewers, H-747).
    import('./routes/stream-bot-viewers.js').then(({ default: streamBotViewersRouter }) => {
        app.use('/', streamBotViewersRouter);
    }).catch(err => {
        logger.error('Failed to load stream bot viewer routes:', err);
    });
    // Stream bot import from Firebot and Streamer.bot (/stream/bot/import; core/stream-bot/import, design doc section 6).
    import('./routes/stream-bot-import.js').then(({ default: streamBotImportRouter }) => {
        app.use('/', streamBotImportRouter);
    }).catch(err => {
        logger.error('Failed to load stream bot import routes:', err);
    });
    // One-click switchover from Firebot / Streamer.bot (/stream/bot/import/switchover; core/stream-bot/switchover.js, design doc section 12).
    import('./routes/stream-bot-switchover.js').then(({ default: streamBotSwitchoverRouter }) => {
        app.use('/', streamBotSwitchoverRouter);
    }).catch(err => {
        logger.error('Failed to load stream bot switchover routes:', err);
    });
    // Birthday card GIF/sticker search through the server, so the GIPHY key is never sent to browsers (routes/card-giphy.js).
    import('./routes/card-giphy.js').then(({ default: cardGiphyRouter }) => {
        app.use('/', cardGiphyRouter);
    }).catch(err => {
        logger.error('Failed to load card GIPHY routes:', err);
    });
    // Twitch channel commands for CertiFried's chat bot (/stream/bot/commands; shares its code with /kick/channel/:id/commands).
    import('./routes/stream-bot-channel.js').then(({ default: streamBotChannelRouter }) => {
        app.use('/', streamBotChannelRouter);
    }).catch(err => {
        logger.error('Failed to load stream bot channel command routes:', err);
    });
    // Stream bot song requests: the Music page and API, and the OBS browser-source player (/stream/bot/overlay/music/<key>).
    import('./routes/stream-bot-music.js').then(({ default: streamBotMusicRouter }) => {
        app.use('/', streamBotMusicRouter);
    }).catch(err => {
        logger.error('Failed to load stream bot music routes:', err);
    });
    // CertiFried Studio "Sign in with CertiFried" (browser approval instead of a pairing code).
    import('./routes/stream-bot-link.js').then(({ default: streamBotLinkRouter }) => {
        app.use('/', streamBotLinkRouter);
    }).catch(err => {
        logger.error('Failed to load stream bot sign-in routes:', err);
    });
    // Stream bot overlays and alerts (/stream/bot/overlays, and the OBS pages /stream/bot/overlay/<type>/<key>; core/stream-bot/overlays).
    import('./routes/stream-bot-overlays.js').then(({ default: streamBotOverlaysRouter }) => {
        app.use('/', streamBotOverlaysRouter);
    }).catch(err => {
        logger.error('Failed to load stream bot overlay routes:', err);
    });
    // Stream bot lights, Voicemeeter and Stream Deck API (/stream/bot/api/devices/*, /stream/bot/api/lights/*; core/stream-bot/devices).
    import('./routes/stream-bot-devices.js').then(({ default: streamBotDevicesRouter }) => {
        app.use('/', streamBotDevicesRouter);
    }).catch(err => {
        logger.error('Failed to load stream bot device routes:', err);
    });
    // OBS docks (/stream/bot/dock/*): opened with a dock key that CertiFried Studio puts into OBS.
    import('./routes/stream-bot-dock.js').then(({ default: streamBotDockRouter }) => {
        app.use('/', streamBotDockRouter);
    }).catch(err => {
        logger.error('Failed to load stream bot dock routes:', err);
    });
    // CertiFried Studio downloads and its auto-update feed (/downloads/studio, files outside git in STUDIO_DOWNLOADS_DIR).
    import('./routes/downloads.js').then(({ default: downloadsRouter }) => {
        app.use('/', downloadsRouter);
    }).catch(err => {
        logger.error('Failed to load download routes:', err);
    });
    // Public CertiFried Studio pages (/studio, /studio/how-it-works, /studio/privacy, /studio/faq) and the legal hub
    // (/legal, /legal/data "Data we collect", which reads data_retention_policy).
    import('./routes/legal-pages.js').then(({ default: legalPagesRouter }) => {
        app.use('/', legalPagesRouter);
    }).catch(err => {
        logger.error('Failed to load legal and Studio pages:', err);
    });
    // Viewer data without a CertiFried account (/privacy/viewer, H-772): Twitch or Kick identity-only sign-in, then
    // export or delete the stream bot data keyed to that account (dashboard/routes/privacy-viewer.js).
    import('./routes/privacy-viewer.js').then(({ default: privacyViewerRouter }) => {
        app.use('/', privacyViewerRouter);
    }).catch(err => {
        logger.error('Failed to load the viewer privacy routes:', err);
    });

    // Windrose game server panel (/windrose). Talks to windrose-agent on
    // 127.0.0.1:4091 — this process never touches the Docker socket itself.
    // Lazy-imported like the other late route groups so a failure here cannot
    // stop the dashboard from booting.
    import('./routes/windrose.js').then(({ default: windroseRouter }) => {
        app.use('/', windroseRouter);
    }).catch(err => {
        logger.error('Failed to load Windrose routes:', err);
    });

    // Vault (/vault) — private large-file transfer for the vault_members allowlist.
    // Deliberately NOT under /api: the global apiLimiter is 60 req/min and a chunked
    // multi-gigabyte upload is hundreds of requests. The router brings its own limiters.
    import('./routes/vault.js').then(({ default: vaultRouter }) => {
        app.use('/', vaultRouter);
    }).catch(err => {
        logger.error('Failed to load Vault routes:', err);
    });

    // Windrose owner console (/wrmanager). Mounted separately from /windrose so
    // the two gate independently — viewer+ there, owner-only here.
    import('./routes/wrmanager.js').then(({ default: wrmanagerRouter }) => {
        app.use('/', wrmanagerRouter);
    }).catch(err => {
        logger.error('Failed to load Windrose Manager routes:', err);
    });

    // E-Book reader route
    app.get('/E-Book1', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'ebook', 'index.html'));
    });

    // Error handling
    app.use((err, req, res, next) => {
        logger.error('Express error:', err);
        // A response that already started cannot become an error page; let Express close it.
        if (res.headersSent) return next(err);
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

    // CertiFried Tycoon live updates: WebSocket upgrades on /cfx/ws go to the game server (others untouched)
    attachCfxUpgrade(server);

    // Stream bot realtime channel: WebSocket upgrades on /stream/bot/ws only (CertiFried Studio and overlays),
    // plus the StreamElements / Streamlabs tip sockets. LiteSpeed needs `websocket /stream/bot/ws` to 127.0.0.1:3001.
    import('../core/stream-bot/index.js')
        .then(({ startStreamBot }) => startStreamBot(server))
        .catch(err => logger.error(`[Dashboard] Stream bot did not start: ${err.message}`));

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
