import { PermissionsBitField } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { isSuperAdmin } from '../../utils/constants.js';

/**
 * Check if user is authenticated
 * Redirects to Discord OAuth if not
 */
export async function checkAuth(req, res, next) {
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
}

/**
 * Soft authentication — sets req.user if logged in, but lets unauth'd users
 * through. Use for routes that have a logged-in experience AND a public
 * (read-only / browse) experience. Views should defensively handle `user`
 * being undefined.
 */
export function optionalAuth(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) {
        req.user.isSuperAdmin = isSuperAdmin(req.user.id);
    }
    return next();
}

/**
 * Authenticated OR guest identity. For CAH public play — accepts a Discord
 * user OR a session-stored guest identity (set via POST /cah/guest/identity).
 * Sets req.identity = { id, displayName, kind: 'discord' | 'guest' }.
 * Use on routes that need *some* identity but don't care which.
 */
export function authOrGuest(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) {
        req.identity = { id: req.user.id, displayName: req.user.username || req.user.global_name || 'Player', kind: 'discord' };
        return next();
    }
    const guest = req.session?.cahGuest;
    if (guest?.id && guest.displayName) {
        req.identity = { id: guest.id, displayName: guest.displayName, kind: 'guest' };
        return next();
    }
    return res.status(401).json({ ok: false, reason: 'identity_required', message: 'Pick a username first (POST /cah/guest/identity).' });
}

/**
 * Check if user has admin permissions for the guild
 * Also sets req.guildObject with the Discord.js guild object
 */
export function checkGuildAdmin(req, res, next) {
    try {
        const client = req.app.locals.client;

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
                const botClientId = process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID;
                return res.redirect(`https://discord.com/oauth2/authorize?client_id=${botClientId}&permissions=8&scope=bot+applications.commands&guild_id=${req.params.guildId}&disable_guild_select=true`);
            }

            req.guildObject = guildObject;
            req.isSuperAdmin = true;
            logger.info(`[Dashboard] Super-admin ${req.user.username} accessing guild ${guildObject.name} (${req.params.guildId})`);
            return next();
        }

        // Regular user permission check
        const guild = req.user.guilds.find(g => g.id === req.params.guildId);
        if (!guild || !new PermissionsBitField(BigInt(guild.permissions)).has(PermissionsBitField.Flags.ManageGuild)) {
            return res.status(403).render('error', {
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
            const botClientId = process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID;
            return res.redirect(`https://discord.com/oauth2/authorize?client_id=${botClientId}&permissions=8&scope=bot+applications.commands&guild_id=${req.params.guildId}&disable_guild_select=true`);
        }

        req.guildObject = guildObject;
        return next();
    } catch (e) {
        logger.error('[checkGuildAdmin Error]', e);
        res.status(500).render('error', {
            user: req.user,
            error: 'An unexpected error occurred while checking permissions.'
        });
    }
}

/**
 * Check if user is super admin (bot owner)
 */
export function checkSuperAdmin(req, res, next) {
    if (req.user && isSuperAdmin(req.user.id)) {
        req.isSuperAdmin = true;
        return next();
    }
    res.status(403).render('error', {
        user: req.user,
        error: 'Super Admin access required.'
    });
}

/**
 * Check if user can manage custom bots
 */
export async function checkBotCreator(req, res, next) {
    try {
        const [permissions] = await pool.execute(
            'SELECT can_create_bots FROM bot_creator_permissions WHERE user_id = ?',
            [req.user.id]
        );

        if (permissions.length === 0 || !permissions[0].can_create_bots) {
            return res.status(403).send('You do not have permission to manage custom bots.');
        }

        next();
    } catch (error) {
        logger.error('[checkBotCreator] Error:', error);
        res.status(500).send('Error checking permissions.');
    }
}

/**
 * API version of checkAuth - returns JSON instead of redirect
 */
export function apiCheckAuth(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.status(401).json({ error: 'Authentication required' });
}

/**
 * API version of checkSuperAdmin - returns JSON instead of render
 * Used for sensitive system endpoints (server stats, logs, etc.)
 */
export function apiCheckSuperAdmin(req, res, next) {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    if (!isSuperAdmin(req.user.id)) {
        return res.status(403).json({ error: 'Super admin access required' });
    }
    return next();
}

/**
 * API version of checkGuildAdmin - returns JSON instead of render
 */
export function apiCheckGuildAdmin(req, res, next) {
    try {
        const client = req.app.locals.client;

        // Super-admin bypass
        if (isSuperAdmin(req.user.id)) {
            let guildObject = null;
            if (global.botManager) {
                const botClient = global.botManager.getClientForGuild(req.params.guildId);
                guildObject = botClient?.guilds.cache.get(req.params.guildId);
            } else {
                guildObject = client.guilds.cache.get(req.params.guildId);
            }

            if (!guildObject) {
                return res.status(403).json({ error: 'Bot is not in this server' });
            }

            req.guildObject = guildObject;
            req.isSuperAdmin = true;
            return next();
        }

        // Regular user check
        const guild = req.user.guilds.find(g => g.id === req.params.guildId);
        if (!guild || !new PermissionsBitField(BigInt(guild.permissions)).has(PermissionsBitField.Flags.ManageGuild)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        let guildObject = null;
        if (global.botManager) {
            const botClient = global.botManager.getClientForGuild(req.params.guildId);
            guildObject = botClient?.guilds.cache.get(req.params.guildId);
        } else {
            guildObject = client.guilds.cache.get(req.params.guildId);
        }

        if (!guildObject) {
            return res.status(403).json({ error: 'Bot is not in this server' });
        }

        req.guildObject = guildObject;
        next();
    } catch (e) {
        logger.error('[apiCheckGuildAdmin Error]', e);
        res.status(500).json({ error: 'Permission check failed' });
    }
}

export default {
    checkAuth,
    checkGuildAdmin,
    checkSuperAdmin,
    checkBotCreator,
    apiCheckAuth,
    apiCheckSuperAdmin,
    apiCheckGuildAdmin
};
