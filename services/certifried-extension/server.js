/**
 * Express + WebSocket Server
 * Runs on port 4020 (configurable via CFX_PORT)
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import logger from '../../utils/logger.js';
import { requestLoggerMiddleware } from '../../utils/logger.js';

// Middleware
import { unifiedAuth } from './middleware/unified-auth.js';
import { rateLimiter } from './middleware/rate-limit.js';
import { isFrozen, freezeMiddleware, statusHandler } from './freeze.js';
import { isGreenhouseLive, oldGameRoutes, refuseOldGameUpgrade } from '../cfx/integrations/cutover.js';

// Routes
import authRoutes from './routes/auth.js';
import gameStateRoutes from './routes/game-state.js';
import growRoutes from './routes/grow.js';
import inventoryRoutes from './routes/inventory.js';
import marketRoutes from './routes/market.js';
import breedingRoutes from './routes/breeding.js';
import tradingRoutes from './routes/trading.js';
import skillsRoutes from './routes/skills.js';
import questsRoutes from './routes/quests.js';
import facilityRoutes from './routes/facility.js';
import socialRoutes from './routes/social.js';
import bitsRoutes from './routes/bits.js';
import prestigeRoutes from './routes/prestige.js';
import adminRoutes from './routes/admin.js';
import shopRoutes from './routes/shop.js';
import achievementsRoutes from './routes/achievements.js';
import notificationsRoutes from './routes/notifications.js';
import workersRoutes from './routes/workers.js';
import settingsRoutes from './routes/settings.js';
import giftsRoutes from './routes/gifts.js';
import strainsRoutes from './routes/strains.js';
import dailyRewardsRoutes from './routes/daily-rewards.js';
import statsRoutes from './routes/stats.js';
import offlineProgressRoutes from './routes/offline-progress.js';
import eventsRoutes from './routes/events.js';
import raidRoutes from './routes/raid.js';
import vaultRoutes from './routes/vault.js';
import favoritesRoutes from './routes/favorites.js';
import marketAlertsRoutes from './routes/market-alerts.js';
import contractsRoutes from './routes/contracts.js';
import extractionRoutes from './routes/extraction.js';
import blackMarketRoutes from './routes/black-market.js';
import mutationsRoutes from './routes/mutations.js';
import researchRoutes from './routes/research.js';
import equipmentRoutes from './routes/equipment.js';
import locationsRoutes from './routes/locations.js';
import cartelsRoutes from './routes/cartels.js';
import tournamentsRoutes from './routes/tournaments.js';
import reputationRoutes from './routes/reputation.js';
import dispensaryRoutes from './routes/dispensary.js';
import minigamesRoutes from './routes/minigames.js';
import bossesRoutes from './routes/bosses.js';
import randomEventsRoutes from './routes/random-events.js';
import workersEnhancedRoutes from './routes/workers-enhanced.js';
import automationRoutes from './routes/automation.js';
import territoriesRoutes from './routes/territories.js';
import seasonsRoutes from './routes/seasons.js';

// WebSocket
import { setupWebSocket } from './ws/handler.js';

// Database setup - inline initialization
import pool from '../../utils/db.js';
import fs from 'fs';

let server = null;
let wss = null;

/**
 * Run SQL migration file
 */
async function runMigrationFile(filename) {
    const filePath = path.join(__dirname, 'database/migrations', filename);
    if (!fs.existsSync(filePath)) return;

    const sql = fs.readFileSync(filePath, 'utf8');
    const statements = sql
        .replace(/--.*$/gm, '')
        .split(/;\s*$/m)
        .map(s => s.trim())
        .filter(s => s.length > 0);

    for (const statement of statements) {
        if (statement.length > 0) {
            try {
                await pool.execute(statement);
            } catch (e) {
                // Ignore duplicate column/key errors
                if (!e.code?.includes('ER_DUP') && !e.message?.includes('Duplicate')) {
                    logger.warn(`[CFX Migration] Statement failed: ${e.message}`);
                }
            }
        }
    }
}

/**
 * The /api/v1 router. Exported so a test can mount the real router on a throwaway app.
 */
export function buildApiRouter() {
    const api = express.Router();

    // Public status (no auth). The website and the panel ask this first and show the frozen screen.
    api.get('/status', statusHandler);
    // Frozen (CFX_FROZEN, H-636): writes answer 503 FROZEN except sign-in/session; GETs that tick the game too.
    api.use(freezeMiddleware);

    // Auth routes (some don't require auth)
    api.use('/auth', authRoutes);

    // Protected routes (require authentication)
    api.use('/game', unifiedAuth, rateLimiter, gameStateRoutes);
    api.use('/grow', unifiedAuth, rateLimiter, growRoutes);
    api.use('/inventory', unifiedAuth, rateLimiter, inventoryRoutes);
    api.use('/market', unifiedAuth, rateLimiter, marketRoutes);
    api.use('/breed', unifiedAuth, rateLimiter, breedingRoutes);
    api.use('/trade', unifiedAuth, rateLimiter, tradingRoutes);
    api.use('/skills', unifiedAuth, rateLimiter, skillsRoutes);
    api.use('/quests', unifiedAuth, rateLimiter, questsRoutes);
    api.use('/facility', unifiedAuth, rateLimiter, facilityRoutes);
    api.use('/social', unifiedAuth, rateLimiter, socialRoutes);
    api.use('/bits', unifiedAuth, rateLimiter, bitsRoutes);
    api.use('/prestige', unifiedAuth, rateLimiter, prestigeRoutes);
    api.use('/admin', unifiedAuth, rateLimiter, adminRoutes);
    api.use('/shop', unifiedAuth, rateLimiter, shopRoutes);
    api.use('/achievements', unifiedAuth, rateLimiter, achievementsRoutes);
    api.use('/notifications', unifiedAuth, rateLimiter, notificationsRoutes);
    api.use('/workers', unifiedAuth, rateLimiter, workersRoutes);
    api.use('/settings', unifiedAuth, rateLimiter, settingsRoutes);
    api.use('/gifts', unifiedAuth, rateLimiter, giftsRoutes);
    api.use('/strains', unifiedAuth, rateLimiter, strainsRoutes);
    api.use('/daily-rewards', unifiedAuth, rateLimiter, dailyRewardsRoutes);
    api.use('/stats', unifiedAuth, rateLimiter, statsRoutes);
    api.use('/offline-progress', unifiedAuth, rateLimiter, offlineProgressRoutes);
    api.use('/events', unifiedAuth, rateLimiter, eventsRoutes);
    api.use('/raid', unifiedAuth, rateLimiter, raidRoutes);
    api.use('/vault', unifiedAuth, rateLimiter, vaultRoutes);
    api.use('/favorites', unifiedAuth, rateLimiter, favoritesRoutes);
    api.use('/market/alerts', unifiedAuth, rateLimiter, marketAlertsRoutes);
    api.use('/contracts', unifiedAuth, rateLimiter, contractsRoutes);
    api.use('/extraction', unifiedAuth, rateLimiter, extractionRoutes);
    api.use('/black-market', unifiedAuth, rateLimiter, blackMarketRoutes);
    api.use('/mutations', unifiedAuth, rateLimiter, mutationsRoutes);
    api.use('/research', unifiedAuth, rateLimiter, researchRoutes);
    api.use('/equipment', unifiedAuth, rateLimiter, equipmentRoutes);
    api.use('/locations', unifiedAuth, rateLimiter, locationsRoutes);
    api.use('/cartels', unifiedAuth, rateLimiter, cartelsRoutes);
    api.use('/tournaments', unifiedAuth, rateLimiter, tournamentsRoutes);
    api.use('/reputation', unifiedAuth, rateLimiter, reputationRoutes);
    api.use('/dispensary', unifiedAuth, rateLimiter, dispensaryRoutes);
    api.use('/minigames', unifiedAuth, rateLimiter, minigamesRoutes);
    api.use('/bosses', unifiedAuth, rateLimiter, bossesRoutes);
    api.use('/random-events', unifiedAuth, rateLimiter, randomEventsRoutes);
    api.use('/workers-enhanced', unifiedAuth, rateLimiter, workersEnhancedRoutes);
    api.use('/automation', unifiedAuth, rateLimiter, automationRoutes);
    api.use('/territories', unifiedAuth, rateLimiter, territoriesRoutes);
    api.use('/seasons', unifiedAuth, rateLimiter, seasonsRoutes);

    return api;
}

/**
 * Start the Express + WebSocket server
 */
export async function startServer() {
    // Run critical migrations. Not while frozen (H-636): the file re-applies data UPDATEs on every start.
    if (isFrozen() || isGreenhouseLive()) {
        logger.info('[CFX Server] CertiFried Tycoon is frozen or replaced (CFX_FROZEN / GREENHOUSE_LIVE): boot-time game data fixes skipped');
    } else {
        try {
            await runMigrationFile('fix_missing_game_data.sql');
            logger.info('[CFX Server] Migrations completed');
        } catch (dbError) {
            logger.error('[CFX Server] Migration failed', { error: dbError.message });
        }
    }

    const app = express();
    const PORT = parseInt(process.env.CFX_PORT || '4020', 10);

    // Greenhouse Tycoon is live (GREENHOUSE_LIVE=1, phase 5): the bot no longer starts this server. If it is
    // started anyway, every page answers 301 /greenhouse and everything else 410, so nothing old can be served
    // from behind the front server. Without the flag this only calls next().
    app.use(oldGameRoutes({ scope: 'all' }));

    // The site's front server sends /cfx/* here directly, not through the dashboard proxy (H-628).
    // Map it the way the proxy does: /cfx and /cfx/ open the website at /game, /cfx/api/* and /cfx/health
    // reach the API. /cfx/dist/* stays the static bundle (below) and /cfx/ws is accepted by the upgrade handler.
    app.use((req, res, next) => {
        const q = req.url.indexOf('?');
        const p = q === -1 ? req.url : req.url.slice(0, q);
        if ((p === '/cfx' || p === '/cfx/') && (req.method === 'GET' || req.method === 'HEAD')) return res.redirect(302, '/game');
        if (p.startsWith('/cfx/api/') || p === '/cfx/health') req.url = req.url.slice(4);
        next();
    });

    // Parse allowed origins from env
    const allowedOrigins = (process.env.CFX_CORS_ORIGINS || '')
        .split(',')
        .map(o => o.trim())
        .filter(Boolean);

    // Add default origins
    allowedOrigins.push(
        'https://localhost:4020',
        'https://extension-files.twitch.tv',
        'https://supervisor.ext-twitch.tv',
        'https://certifriedmultitool.com',
        'https://www.certifriedmultitool.com'
    );

    // Security middleware
    app.use(helmet({
        contentSecurityPolicy: false, // Twitch extensions have their own CSP
        crossOriginResourcePolicy: { policy: 'cross-origin' }
    }));

    // CORS for Twitch extension + standalone. Hosts are matched exactly (H-402): a hosted
    // extension runs on https://<client-id>.ext-twitch.tv; the Twitch site and supervisor frames
    // are listed; an origin that merely contains "twitch.tv" is refused.
    const isAllowedOrigin = (origin) => {
        if (allowedOrigins.includes(origin)) return true;
        let u;
        try { u = new URL(origin); } catch { return false; }
        if (u.protocol !== 'https:') return u.hostname === '127.0.0.1' && process.env.CFX_ALLOW_LOCAL_ORIGIN === '1';
        return /^[a-z0-9]+\.ext-twitch\.tv$/.test(u.hostname)
            || ['www.twitch.tv', 'dashboard.twitch.tv', 'supervisor.ext-twitch.tv', 'extension-files.twitch.tv'].includes(u.hostname);
    };
    app.use(cors({
        origin: (origin, callback) => {
            // No Origin header: same-origin page loads, server-to-server, curl
            if (!origin) return callback(null, true);

            if (isAllowedOrigin(origin)) {
                return callback(null, true);
            }

            // A rejected origin is a client problem, not a server error: the error handler below
            // logs it as one WARN line (no stack) and answers 403.
            const err = new Error('Not allowed by CORS');
            err.status = 403;
            err.corsRejected = origin;
            callback(err);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Extension-JWT']
    }));

    // Body parsing
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true, limit: '1mb' }));

    // Request logging (debug only; every API call used to be logged at INFO, H-412)
    app.use((req, res, next) => {
        logger.debug(`[CFX-Request] ${req.method} ${req.path}`, { category: 'cfx-http' });
        next();
    });

    // Health check (no auth) - support both direct and proxied paths
    app.get('/health', (req, res) => {
        res.json({ status: 'ok', service: 'certifried-extension', timestamp: Date.now() });
    });
    app.get('/cfx-api/health', (req, res) => {
        res.json({ status: 'ok', service: 'certifried-extension', timestamp: Date.now() });
    });

    // Serve static frontend files for standalone mode
    const frontendPath = path.join(__dirname, '../../frontend/certifried-extension/dist');

    // Static files - disable caching completely during development
    const staticOptions = {
        maxAge: 0,
        etag: false,
        lastModified: false,
        setHeaders: (res, filePath) => {
            // Prevent ALL caching during development
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Surrogate-Control', 'no-store');
        }
    };

    // Serve static assets - handle BOTH prefixed and stripped paths
    // The proxy strips /cfx-api, so /cfx-api/dist/app.js arrives as /dist/app.js
    app.use('/dist', express.static(frontendPath, staticOptions));  // Proxy-stripped path
    app.use('/cfx-api/dist', express.static(frontendPath, staticOptions));  // Direct access
    app.use('/cfx/dist', express.static(frontendPath, staticOptions));  // Legacy path
    app.use('/cfx', express.static(frontendPath, staticOptions));  // Legacy path

    // Serve standalone.html - the main game page
    const serveApp = (req, res) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(path.join(frontendPath, 'standalone.html'));
    };
    // Handle all entry points - proxy strips /cfx-api so /cfx-api/game arrives as /game
    app.get('/game', serveApp);   // Proxy-stripped path
    app.get('/game/', serveApp);  // Proxy-stripped path
    app.get('/cfx', serveApp);
    app.get('/cfx/', serveApp);
    app.get('/cfx-api/game', serveApp);  // Direct access
    app.get('/cfx-api/game/', serveApp); // Direct access

    // API routes
    const api = buildApiRouter();

    // Mount API - support both direct and proxied paths
    app.use('/api/v1', api);
    app.use('/cfx-api/api/v1', api);

    // Error handler
    const corsWarned = new Map(); // origin -> last warned (one line per origin per minute)
    app.use((err, req, res, next) => {
        if (err.corsRejected) {
            const origin = String(err.corsRejected).slice(0, 200);
            const now = Date.now();
            if (now - (corsWarned.get(origin) || 0) >= 60_000) {
                if (corsWarned.size > 500) corsWarned.clear();
                corsWarned.set(origin, now);
                logger.warn(`[CertiFriedExtension] CORS rejected origin ${origin} for ${req.method} ${req.path}`);
            }
            return res.status(403).json({ error: 'Origin not allowed' });
        }
        logger.error('[CertiFriedExtension] Express error', {
            error: err.message,
            stack: err.stack,
            path: req.path,
            method: req.method
        });

        // Never send internal error text to the internet unless explicitly debugging (H-402)
        const message = process.env.CFX_DEBUG_ERRORS === '1'
            ? err.message
            : 'Internal server error';

        res.status(err.status || 500).json({
            error: message,
            code: err.code || 'INTERNAL_ERROR'
        });
    });

    // Create HTTP server
    server = createServer(app);

    // Create WebSocket server. The site forwards /cfx-api/ws (edge) and the dashboard proxy
    // forwards /cfx/ws as /ws; all three paths are accepted (H-403).
    wss = new WebSocketServer({ noServer: true });
    const WS_PATHS = new Set(['/ws', '/cfx-api/ws', '/cfx/ws']);
    const CRLF = String.fromCharCode(13, 10);
    server.on('upgrade', (req, socket, head) => {
        if (refuseOldGameUpgrade(req, socket, { scope: 'all' })) return;
        let pathname = '';
        try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* bad url */ }
        if (!WS_PATHS.has(pathname)) {
            socket.write('HTTP/1.1 404 Not Found' + CRLF + 'Connection: close' + CRLF + CRLF);
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    // Setup WebSocket handlers
    setupWebSocket(wss);

    // Start listening
    return new Promise((resolve, reject) => {
        // CFX_HOST=127.0.0.1 keeps the port off the internet once nothing reaches it over the
        // public IP any more (docs/cfx-twitch-extension-setup.md); default stays all interfaces.
        const HOST = process.env.CFX_HOST || '0.0.0.0';
        server.listen(PORT, HOST, () => {
            logger.info(`[CertiFriedExtension] Server listening on ${HOST}:${PORT}`);
            resolve(server);
        });

        server.on('error', (error) => {
            logger.error('[CertiFriedExtension] Server error', { error: error.message });
            reject(error);
        });
    });
}

/**
 * Stop the server
 */
export async function stopServer() {
    return new Promise((resolve) => {
        if (wss) {
            wss.clients.forEach(client => {
                client.close(1001, 'Server shutting down');
            });
            wss.close();
            wss = null;
        }

        if (server) {
            server.close(() => {
                server = null;
                resolve();
            });
        } else {
            resolve();
        }
    });
}

/**
 * Get WebSocket server instance
 */
export function getWSS() {
    return wss;
}
