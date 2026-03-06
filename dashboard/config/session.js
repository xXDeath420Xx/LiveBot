import session from 'express-session';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import crypto from 'crypto';

/**
 * MySQL Session Store for express-session
 * Stores sessions in database for persistence and management
 */
class MySQLSessionStore extends session.Store {
    constructor(options = {}) {
        super();
        this.tableName = options.tableName || 'tokes_web_sessions';
        this.cleanupInterval = options.cleanupInterval || 15 * 60 * 1000; // 15 minutes
        this.startCleanup();
    }

    /**
     * Start periodic cleanup of expired sessions
     */
    startCleanup() {
        setInterval(() => {
            this.cleanup().catch(err => {
                logger.error('[SessionStore] Cleanup error', { error: err.message });
            });
        }, this.cleanupInterval);
    }

    /**
     * Remove expired sessions
     */
    async cleanup() {
        try {
            const [result] = await pool.execute(
                `DELETE FROM ${this.tableName} WHERE expires_at < NOW()`
            );
            if (result.affectedRows > 0) {
                logger.debug('[SessionStore] Cleaned up expired sessions', { count: result.affectedRows });
            }
        } catch (error) {
            logger.error('[SessionStore] Cleanup failed', { error: error.message });
        }
    }

    /**
     * Get session by ID
     */
    async get(sessionId, callback) {
        try {
            const [[row]] = await pool.execute(
                `SELECT data FROM ${this.tableName} WHERE session_id = ? AND expires_at > NOW()`,
                [sessionId]
            );

            if (!row) {
                return callback(null, null);
            }

            const session = JSON.parse(row.data);
            callback(null, session);
        } catch (error) {
            logger.error('[SessionStore] Get session error', { error: error.message });
            callback(error);
        }
    }

    /**
     * Save/update session
     */
    async set(sessionId, sessionData, callback) {
        try {
            const data = JSON.stringify(sessionData);
            const maxAge = sessionData.cookie?.maxAge || 7 * 24 * 60 * 60 * 1000;
            const expiresAt = new Date(Date.now() + maxAge);

            // Extract user info for logging/management
            // For Discord OAuth: passport.user is the full profile, extract .id
            // For Tokes OAuth: tokesUser.id is already the ID
            const userId = sessionData.tokesUser?.id || sessionData.passport?.user?.id || null;
            const userAgent = sessionData.userAgent || null;
            const ipAddress = sessionData.ipAddress || null;

            await pool.execute(
                `INSERT INTO ${this.tableName}
                 (session_id, user_id, data, user_agent, ip_address, expires_at, last_activity)
                 VALUES (?, ?, ?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE
                    data = VALUES(data),
                    user_id = VALUES(user_id),
                    last_activity = NOW(),
                    expires_at = VALUES(expires_at)`,
                [sessionId, userId, data, userAgent, ipAddress, expiresAt]
            );

            callback(null);
        } catch (error) {
            logger.error('[SessionStore] Set session error', { error: error.message });
            callback(error);
        }
    }

    /**
     * Destroy session
     */
    async destroy(sessionId, callback) {
        try {
            // Log the session destruction
            const [[session]] = await pool.execute(
                `SELECT user_id, ip_address FROM ${this.tableName} WHERE session_id = ?`,
                [sessionId]
            );

            if (session) {
                await pool.execute(
                    `INSERT INTO tokes_session_logs
                     (user_id, session_id, event_type, ip_address, details)
                     VALUES (?, ?, 'logout', ?, 'Session destroyed')`,
                    [session.user_id, sessionId, session.ip_address]
                );
            }

            await pool.execute(
                `DELETE FROM ${this.tableName} WHERE session_id = ?`,
                [sessionId]
            );

            callback(null);
        } catch (error) {
            logger.error('[SessionStore] Destroy session error', { error: error.message });
            callback(error);
        }
    }

    /**
     * Touch session (update expiry without changing data)
     */
    async touch(sessionId, sessionData, callback) {
        try {
            const maxAge = sessionData.cookie?.maxAge || 7 * 24 * 60 * 60 * 1000;
            const expiresAt = new Date(Date.now() + maxAge);

            await pool.execute(
                `UPDATE ${this.tableName}
                 SET expires_at = ?, last_activity = NOW()
                 WHERE session_id = ?`,
                [expiresAt, sessionId]
            );

            callback(null);
        } catch (error) {
            logger.error('[SessionStore] Touch session error', { error: error.message });
            callback(error);
        }
    }

    /**
     * Get all sessions (for admin management)
     */
    async all(callback) {
        try {
            const [rows] = await pool.execute(
                `SELECT session_id, user_id, user_agent, ip_address, created_at, last_activity, expires_at
                 FROM ${this.tableName}
                 WHERE expires_at > NOW()
                 ORDER BY last_activity DESC`
            );
            callback(null, rows);
        } catch (error) {
            callback(error);
        }
    }

    /**
     * Get session count
     */
    async length(callback) {
        try {
            const [[{ count }]] = await pool.execute(
                `SELECT COUNT(*) as count FROM ${this.tableName} WHERE expires_at > NOW()`
            );
            callback(null, count);
        } catch (error) {
            callback(error);
        }
    }

    /**
     * Clear all sessions
     */
    async clear(callback) {
        try {
            await pool.execute(`DELETE FROM ${this.tableName}`);
            callback(null);
        } catch (error) {
            callback(error);
        }
    }

    /**
     * Destroy all sessions for a specific user
     */
    async destroyUserSessions(userId, reason = 'Admin action') {
        try {
            // Get all sessions for user
            const [sessions] = await pool.execute(
                `SELECT session_id, ip_address FROM ${this.tableName} WHERE user_id = ?`,
                [userId]
            );

            // Log each session destruction
            for (const sess of sessions) {
                await pool.execute(
                    `INSERT INTO tokes_session_logs
                     (user_id, session_id, event_type, ip_address, details)
                     VALUES (?, ?, 'force_logout', ?, ?)`,
                    [userId, sess.session_id, sess.ip_address, reason]
                );
            }

            // Delete all user sessions
            const [result] = await pool.execute(
                `DELETE FROM ${this.tableName} WHERE user_id = ?`,
                [userId]
            );

            return result.affectedRows;
        } catch (error) {
            logger.error('[SessionStore] Destroy user sessions error', { error: error.message, userId });
            throw error;
        }
    }

    /**
     * Get user's active sessions
     */
    async getUserSessions(userId) {
        try {
            const [rows] = await pool.execute(
                `SELECT session_id, user_agent, ip_address, created_at, last_activity, expires_at
                 FROM ${this.tableName}
                 WHERE user_id = ? AND expires_at > NOW()
                 ORDER BY last_activity DESC`,
                [userId]
            );
            return rows;
        } catch (error) {
            logger.error('[SessionStore] Get user sessions error', { error: error.message, userId });
            throw error;
        }
    }
}

// Create singleton store instance
let sessionStore = null;

/**
 * Get or create session store instance
 */
export function getSessionStore() {
    if (!sessionStore) {
        sessionStore = new MySQLSessionStore();
    }
    return sessionStore;
}

/**
 * Session configuration options
 */
export const sessionConfig = {
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    store: getSessionStore(),
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days for regular users
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax'
    },
    name: 'certifried.sid',
    rolling: true // Reset cookie expiry on each request
};

/**
 * Admin session timeout (30 minutes of inactivity)
 */
export const ADMIN_INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes

/**
 * Regular user inactivity timeout (24 hours)
 */
export const USER_INACTIVITY_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Create session middleware
 */
export function createSessionMiddleware() {
    return session(sessionConfig);
}

/**
 * Session activity tracking middleware
 * Stores IP and user agent, checks for inactivity timeouts
 */
export function sessionActivityMiddleware(req, res, next) {
    if (!req.session) {
        return next();
    }

    // Store request metadata in session
    req.session.ipAddress = req.ip || req.connection?.remoteAddress;
    req.session.userAgent = req.headers['user-agent'];

    const now = Date.now();
    const lastActivity = req.session.lastActivity || now;

    // Check for admin inactivity timeout
    if (req.session.tokesUser) {
        const isAdmin = req.session.tokesUser.role === 'admin' || req.session.tokesUser.role === 'owner';
        const timeout = isAdmin ? ADMIN_INACTIVITY_TIMEOUT : USER_INACTIVITY_TIMEOUT;

        if (now - lastActivity > timeout) {
            // Session has been inactive too long
            const userId = req.session.tokesUser.id;
            const reason = isAdmin ? 'Admin inactivity timeout (30 min)' : 'User inactivity timeout (24h)';

            // Log the timeout
            pool.execute(
                `INSERT INTO tokes_session_logs
                 (user_id, session_id, event_type, ip_address, details)
                 VALUES (?, ?, 'timeout', ?, ?)`,
                [userId, req.sessionID, req.session.ipAddress, reason]
            ).catch(err => logger.error('[Session] Failed to log timeout', { error: err.message }));

            // Destroy the session
            return req.session.destroy((err) => {
                if (err) {
                    logger.error('[Session] Failed to destroy timed-out session', { error: err.message });
                }
                // Redirect to login with message
                const returnTo = encodeURIComponent(req.originalUrl);
                return res.redirect(`/tokes-bot?error=session_timeout&returnTo=${returnTo}`);
            });
        }
    }

    // Update last activity
    req.session.lastActivity = now;

    next();
}

/**
 * Log session creation/login
 */
export async function logSessionEvent(userId, sessionId, eventType, ipAddress, userAgent, details = null) {
    try {
        await pool.execute(
            `INSERT INTO tokes_session_logs
             (user_id, session_id, event_type, ip_address, user_agent, details)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, sessionId, eventType, ipAddress, userAgent, details]
        );
    } catch (error) {
        logger.error('[Session] Failed to log session event', { error: error.message, eventType });
    }
}

export default session;
