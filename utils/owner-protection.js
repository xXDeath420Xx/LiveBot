import { SUPER_ADMIN_ID, isSuperAdmin } from './constants.js';
import logger from './logger.js';

export function getProtectedOwnerId() {
    return SUPER_ADMIN_ID;
}

export function isProtectedOwner(userId) {
    if (!userId) return false;
    return String(userId) === String(SUPER_ADMIN_ID);
}

export function isProtectedFromBanCommands(userId) {
    if (!userId) return false;
    return isSuperAdmin(userId);
}

export async function leaveGuildOnAllBots(guildId, reason) {
    if (!guildId) return { attempted: 0, left: 0 };

    let botManager;
    try {
        ({ default: botManager } = await import('../core/bot-manager.js'));
    } catch (error) {
        logger.error('[OwnerProtection] Failed to import bot-manager', { error: error.message });
        return { attempted: 0, left: 0 };
    }

    let attempted = 0;
    let left = 0;

    for (const [botId, client] of botManager.clients.entries()) {
        if (!client?.isReady?.()) continue;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;

        attempted++;
        try {
            logger.warn('[OwnerProtection] Owner was banned — leaving guild', {
                botId,
                guildId,
                guildName: guild.name,
                reason
            });
            await guild.leave();
            left++;
        } catch (error) {
            logger.error('[OwnerProtection] Failed to leave guild', {
                botId,
                guildId,
                error: error.message
            });
        }
    }

    return { attempted, left };
}

export default {
    getProtectedOwnerId,
    isProtectedOwner,
    isProtectedFromBanCommands,
    leaveGuildOnAllBots
};
