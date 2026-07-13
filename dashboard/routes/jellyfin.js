import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { checkAuth } from '../middleware/auth.js';

const router = express.Router();

const JELLYFIN_URL = process.env.JELLYFIN_URL || 'https://jellyfin.certifriedmultitool.net';
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY;

// Helper: call Jellyfin API
async function jellyfinApi(method, path, body = null) {
    const res = await fetch(`${JELLYFIN_URL}${path}`, {
        method,
        headers: {
            'X-Emby-Token': JELLYFIN_API_KEY,
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : null
    });
    if (!res.ok && res.status !== 404) {
        const text = await res.text();
        throw new Error(`Jellyfin API ${res.status}: ${text}`);
    }
    if (res.status === 204 || res.headers.get('content-length') === '0') return null;
    return res.json().catch(() => null);
}

// Helper: check if user shares a guild with any CertiFried bot
function userSharesGuildWithBot(userGuilds) {
    const botGuildIds = new Set();

    const mainClient = global.client || global.mainClient;
    if (mainClient?.guilds?.cache) {
        mainClient.guilds.cache.forEach(g => botGuildIds.add(g.id));
    }

    if (global.botManager?.clients) {
        for (const [, botClient] of global.botManager.clients.entries()) {
            if (botClient?.guilds?.cache) {
                botClient.guilds.cache.forEach(g => botGuildIds.add(g.id));
            }
        }
    }

    if (!userGuilds?.length || botGuildIds.size === 0) return { eligible: false, sharedGuilds: [] };

    const shared = userGuilds.filter(g => botGuildIds.has(g.id));
    return { eligible: shared.length > 0, sharedGuilds: shared };
}

// Ensure DB table exists
async function ensureTable() {
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS jellyfin_accounts (
            discord_id VARCHAR(32) PRIMARY KEY,
            discord_username VARCHAR(128) NOT NULL,
            jellyfin_user_id VARCHAR(64) NOT NULL,
            jellyfin_username VARCHAR(128) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

// GET /jellyfin — show connection page
router.get('/', checkAuth, async (req, res) => {
    try {
        await ensureTable();

        const [rows] = await pool.execute(
            'SELECT * FROM jellyfin_accounts WHERE discord_id = ?',
            [req.user.id]
        );
        const linked = rows.length > 0 ? rows[0] : null;

        const { eligible, sharedGuilds } = userSharesGuildWithBot(req.user.guilds);

        // Check if Jellyfin is reachable
        let jellyfinOnline = false;
        try {
            const info = await jellyfinApi('GET', '/System/Info/Public');
            jellyfinOnline = !!info;
        } catch { /* offline */ }

        res.render('jellyfin-tailwind', {
            user: req.user,
            linked,
            eligible,
            sharedGuilds,
            jellyfinOnline,
            jellyfinUrl: JELLYFIN_URL
        });
    } catch (err) {
        logger.error('[Jellyfin] Page error:', err);
        res.status(500).render('error-tailwind', {
            user: req.user,
            error: 'Failed to load Jellyfin page.'
        });
    }
});

// POST /jellyfin/connect — create Jellyfin account
router.post('/connect', checkAuth, async (req, res) => {
    try {
        if (!JELLYFIN_API_KEY) {
            return res.status(500).json({ error: 'Jellyfin integration not configured' });
        }

        await ensureTable();

        // Already linked?
        const [existing] = await pool.execute(
            'SELECT * FROM jellyfin_accounts WHERE discord_id = ?',
            [req.user.id]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Account already linked' });
        }

        // Check guild eligibility
        const { eligible } = userSharesGuildWithBot(req.user.guilds);
        if (!eligible) {
            return res.status(403).json({ error: 'You must share a Discord server with a CertiFried bot' });
        }

        // Create Jellyfin username from Discord username (sanitize)
        const jfUsername = req.user.username.replace(/[^a-zA-Z0-9_.-]/g, '_').substring(0, 40);

        // Check if username already taken in Jellyfin
        const users = await jellyfinApi('GET', '/Users');
        if (users?.some(u => u.Name.toLowerCase() === jfUsername.toLowerCase())) {
            return res.status(409).json({ error: `Username "${jfUsername}" is already taken on Jellyfin` });
        }

        // Create the Jellyfin user
        const newUser = await jellyfinApi('POST', '/Users/New', {
            Name: jfUsername
        });

        if (!newUser?.Id) {
            return res.status(500).json({ error: 'Failed to create Jellyfin account' });
        }

        // Set a random password
        const tempPassword = Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(b => b.toString(36).padStart(2, '0')).join('').substring(0, 20);

        await jellyfinApi('POST', `/Users/${newUser.Id}/Password`, {
            CurrentPw: '',
            NewPw: tempPassword
        });

        // Save to DB
        await pool.execute(
            'INSERT INTO jellyfin_accounts (discord_id, discord_username, jellyfin_user_id, jellyfin_username) VALUES (?, ?, ?, ?)',
            [req.user.id, req.user.username, newUser.Id, jfUsername]
        );

        logger.info(`[Jellyfin] Created account "${jfUsername}" for Discord user ${req.user.username} (${req.user.id})`);

        res.json({
            success: true,
            username: jfUsername,
            password: tempPassword,
            url: JELLYFIN_URL
        });
    } catch (err) {
        logger.error('[Jellyfin] Connect error:', err);
        res.status(500).json({ error: 'Failed to create Jellyfin account' });
    }
});

// POST /jellyfin/reset-password — generate new password
router.post('/reset-password', checkAuth, async (req, res) => {
    try {
        await ensureTable();

        const [rows] = await pool.execute(
            'SELECT * FROM jellyfin_accounts WHERE discord_id = ?',
            [req.user.id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'No linked account found' });
        }

        const tempPassword = Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(b => b.toString(36).padStart(2, '0')).join('').substring(0, 20);

        await jellyfinApi('POST', `/Users/${rows[0].jellyfin_user_id}/Password`, {
            ResetPassword: true
        });
        await jellyfinApi('POST', `/Users/${rows[0].jellyfin_user_id}/Password`, {
            CurrentPw: '',
            NewPw: tempPassword
        });

        logger.info(`[Jellyfin] Password reset for ${req.user.username}`);
        res.json({ success: true, password: tempPassword });
    } catch (err) {
        logger.error('[Jellyfin] Reset password error:', err);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// POST /jellyfin/disconnect — unlink account
router.post('/disconnect', checkAuth, async (req, res) => {
    try {
        await ensureTable();

        const [rows] = await pool.execute(
            'SELECT * FROM jellyfin_accounts WHERE discord_id = ?',
            [req.user.id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'No linked account found' });
        }

        // Delete from Jellyfin
        try {
            await jellyfinApi('DELETE', `/Users/${rows[0].jellyfin_user_id}`);
        } catch (err) {
            logger.warn(`[Jellyfin] Could not delete Jellyfin user ${rows[0].jellyfin_user_id}:`, err.message);
        }

        // Remove from DB
        await pool.execute('DELETE FROM jellyfin_accounts WHERE discord_id = ?', [req.user.id]);

        logger.info(`[Jellyfin] Disconnected ${req.user.username} (${req.user.id})`);
        res.json({ success: true });
    } catch (err) {
        logger.error('[Jellyfin] Disconnect error:', err);
        res.status(500).json({ error: 'Failed to disconnect account' });
    }
});

export default router;
