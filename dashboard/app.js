import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as ejs from 'ejs';
import fs from 'fs';
import multer from 'multer';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import { configurePassport } from './config/passport.js';
import { createSessionMiddleware, sessionActivityMiddleware } from './config/session.js';
import { botContext } from './middleware/botContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Create and configure Express application
 * @param {Object} options - Configuration options
 * @returns {Object} { app, sessionMiddleware }
 */
export function createApp(options = {}) {
    const app = express();

    // Configure multer for file uploads
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
    });
    app.locals.upload = upload;

    // Security middleware
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
                scriptSrcAttr: ["'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "fonts.googleapis.com", "cdnjs.cloudflare.com"],
                fontSrc: ["'self'", "fonts.gstatic.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
                imgSrc: ["'self'", "data:", "https:", "cdn.discordapp.com", "i.imgur.com"],
                connectSrc: ["'self'", "wss:", "ws:"],
                frameSrc: ["'none'"],
                objectSrc: ["'none'"]
            }
        },
        crossOriginEmbedderPolicy: false
    }));

    // Compression
    app.use(compression());

    // CORS
    app.use(cors({
        origin: process.env.DASHBOARD_URL || 'http://localhost:3001',
        credentials: true
    }));

    // Rate limiting
    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 500, // Limit each IP to 500 requests per windowMs
        message: 'Too many requests from this IP, please try again later.',
        standardHeaders: true,
        legacyHeaders: false
    });
    app.use('/api/', limiter);

    // Session middleware
    const sessionMiddleware = createSessionMiddleware();
    app.use(sessionMiddleware);

    // Session activity tracking and timeout enforcement
    app.use(sessionActivityMiddleware);

    // Passport authentication
    const passport = configurePassport();
    app.use(passport.initialize());
    app.use(passport.session());

    // Body parsing (skip for multipart)
    app.use((req, res, next) => {
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return next();
        }
        express.json({ limit: '10mb' })(req, res, () => {
            express.urlencoded({ extended: true, limit: '10mb' })(req, res, next);
        });
    });

    // Serve static files
    app.use(express.static(path.join(__dirname, 'public'), {
        maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0
    }));

    // View engine configuration
    const viewsDir = path.join(__dirname, 'views');
    app.engine('ejs', async (filePath, options, callback) => {
        try {
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
    app.set('views', viewsDir);

    // Make common variables available to all templates
    app.use((req, res, next) => {
        res.locals.user = req.user || null;
        res.locals.path = req.path;
        res.locals.clientId = process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID;
        next();
    });

    // Debug logging for POST requests (development only)
    if (process.env.NODE_ENV !== 'production') {
        app.use((req, res, next) => {
            if (req.method === 'POST') {
                logger.debug(`[POST] ${req.path}`, { bodyKeys: Object.keys(req.body || {}) });
            }
            next();
        });
    }

    return { app, sessionMiddleware, passport };
}

/**
 * Apply error handlers (should be called after all routes are registered)
 * @param {Object} app - Express application
 */
export function applyErrorHandlers(app) {
    app.use(notFoundHandler);
    app.use(errorHandler);
}

/**
 * Multer error handler middleware
 */
export function handleMulterError(err, req, res, next) {
    if (err instanceof multer.MulterError) {
        logger.error('[Multer Error]', { error: err.message });
        return res.status(400).json({ error: `Upload Error: ${err.message}` });
    } else if (err) {
        logger.error('[Upload Error]', { error: err.message });
        return res.status(500).json({ error: `Upload Error: ${err.message}` });
    }
    next();
}

export default { createApp, applyErrorHandlers, handleMulterError };
