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
 * Start the Express + WebSocket server
 */
export async function startServer() {
    // Run critical migrations
    try {
        await runMigrationFile('fix_missing_game_data.sql');
        logger.info('[CFX Server] Migrations completed');
    } catch (dbError) {
        logger.error('[CFX Server] Migration failed', { error: dbError.message });
    }

    const app = express();
    const PORT = parseInt(process.env.CFX_PORT || '4020', 10);

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

    // CORS for Twitch extension + standalone
    app.use(cors({
        origin: (origin, callback) => {
            // Allow requests with no origin (mobile apps, curl, etc.)
            if (!origin) return callback(null, true);

            // Allow any Twitch extension origin
            if (origin.includes('twitch.tv') || origin.includes('twitch.com')) {
                return callback(null, true);
            }

            // Check allowed origins
            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }

            // Allow localhost in development
            if (process.env.NODE_ENV !== 'production' && origin.includes('localhost')) {
                return callback(null, true);
            }

            callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Extension-JWT']
    }));

    // Body parsing
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true, limit: '1mb' }));

    // Request logging - always enabled for debugging
    app.use((req, res, next) => {
        logger.info(`[CFX-Request] ${req.method} ${req.path}`, {
            category: 'cfx-http',
            headers: {
                'sec-fetch-dest': req.headers['sec-fetch-dest'],
                'sec-fetch-mode': req.headers['sec-fetch-mode'],
                'sec-fetch-site': req.headers['sec-fetch-site'],
                'origin': req.headers['origin'],
                'referer': req.headers['referer']
            }
        });
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
    const api = express.Router();

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

    // Mount API - support both direct and proxied paths
    app.use('/api/v1', api);
    app.use('/cfx-api/api/v1', api);

    // Error handler
    app.use((err, req, res, next) => {
        logger.error('[CertiFriedExtension] Express error', {
            error: err.message,
            stack: err.stack,
            path: req.path,
            method: req.method
        });

        // Don't leak error details in production
        const message = process.env.NODE_ENV === 'production'
            ? 'Internal server error'
            : err.message;

        res.status(err.status || 500).json({
            error: message,
            code: err.code || 'INTERNAL_ERROR'
        });
    });

    // Create HTTP server
    server = createServer(app);

    // Create WebSocket server
    wss = new WebSocketServer({
        server,
        path: '/ws'
    });

    // Setup WebSocket handlers
    setupWebSocket(wss);

    // Start listening
    return new Promise((resolve, reject) => {
        server.listen(PORT, () => {
            logger.info(`[CertiFriedExtension] Server listening on port ${PORT}`);
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
