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
                return res.status(403).render('error', {
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
            return res.status(403).render('error', {
                user: req.user,
                error: 'The bot is not in this server.'
            });
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
