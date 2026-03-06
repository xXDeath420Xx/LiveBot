import logger from './logger.js';
import pool from './db.js';
import { isSuperAdmin } from './constants.js';

/**
 * Middleware to check if user is a super admin
 * Super admins have access to all system controls
 */
export function requireSuperAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized - Please log in' });
    }

    if (!isSuperAdmin(req.user.id)) {
        logger.warn(`[Auth] Unauthorized super admin attempt by ${req.user.id} (${req.user.username})`);
        return res.status(403).json({ error: 'Super admin access required' });
    }

    next();
}

/**
 * Middleware to check if user is the bot owner (alias for requireSuperAdmin)
 * Only the bot owner can manage custom bots
 */
export function requireBotOwner(req, res, next) {
    return requireSuperAdmin(req, res, next);
}

/**
 * Middleware to check if user has permission to create custom bots
 * Checks the bot_creator_permissions table
 */
export async function requireBotCreator(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized - Please log in' });
    }

    try {
        // Check if user has bot creator permissions
        const [rows] = await pool.execute(
            'SELECT can_create_bots, max_bots FROM bot_creator_permissions WHERE user_id = ?',
            [req.user.id]
        );

        if (rows.length === 0 || !rows[0].can_create_bots) {
            logger.warn(`[Auth] User ${req.user.id} (${req.user.username}) attempted to create bot without permission`);
            return res.status(403).json({
                error: 'You do not have permission to create custom bots',
                message: 'Contact the bot owner to request custom bot creator permissions'
            });
        }

        // Attach permission info to request for later use
        req.botCreatorPermissions = rows[0];
        next();
    } catch (error) {
        logger.error('[Auth] Error checking bot creator permissions:', error);
        return res.status(500).json({ error: 'Failed to verify permissions' });
    }
}

/**
 * Middleware to check if user has admin permissions in a guild
 */
export async function requireGuildAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized - Please log in' });
    }

    const guildId = req.params.guildId || req.body.guildId;
    if (!guildId) {
        return res.status(400).json({ error: 'Guild ID required' });
    }

    // Check if user has admin permissions in the guild
    const guild = req.user.guilds?.find(g => g.id === guildId);
    if (!guild) {
        return res.status(403).json({ error: 'Guild not found or you are not a member' });
    }

    // Check for Administrator permission (0x8)
    const hasAdmin = (BigInt(guild.permissions) & BigInt(0x8)) === BigInt(0x8);
    if (!hasAdmin) {
        logger.warn(`[Auth] Non-admin user ${req.user.id} attempted to access guild ${guildId}`);
        return res.status(403).json({ error: 'Administrator permission required in this guild' });
    }

    next();
}

/**
 * Middleware to check if user is either bot owner or guild admin
 */
export async function requireBotOwnerOrGuildAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized - Please log in' });
    }

    const guildId = req.params.guildId || req.body.guildId;

    // Super admin has full access
    if (isSuperAdmin(req.user.id)) {
        return next();
    }

    // Check guild admin permissions
    if (!guildId) {
        return res.status(400).json({ error: 'Guild ID required' });
    }

    const guild = req.user.guilds?.find(g => g.id === guildId);
    if (!guild) {
        return res.status(403).json({ error: 'Guild not found or you are not a member' });
    }

    const hasAdmin = (BigInt(guild.permissions) & BigInt(0x8)) === BigInt(0x8);
    if (!hasAdmin) {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
}

export default {
    requireSuperAdmin,
    requireBotOwner,
    requireBotCreator,
    requireGuildAdmin,
    requireBotOwnerOrGuildAdmin
};
