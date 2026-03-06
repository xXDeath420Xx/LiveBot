/**
 * Moderation Socket Handler
 * Handles real-time moderation events
 */

import logger from '../../../utils/logger.js';

export function moderationHandler(io, socket) {
    /**
     * Subscribe to moderation events for a guild
     */
    socket.on('moderation:subscribe', (guildId) => {
        if (!guildId) return;
        socket.moderationSubscription = guildId;
        socket.emit('moderation:subscribed', { guildId });
    });

    /**
     * Unsubscribe from moderation events
     */
    socket.on('moderation:unsubscribe', () => {
        socket.moderationSubscription = null;
    });
}

/**
 * Broadcast new infraction to dashboard
 * Called from bot when moderation action occurs
 */
export function broadcastInfraction(io, guildId, infraction) {
    io.to(`guild:${guildId}`).emit('moderation:infraction', {
        ...infraction,
        timestamp: Date.now()
    });
}

/**
 * Broadcast automod action to dashboard
 */
export function broadcastAutomodAction(io, guildId, action) {
    io.to(`guild:${guildId}`).emit('moderation:automod', {
        type: action.type,
        userId: action.userId,
        username: action.username,
        reason: action.reason,
        action: action.action,
        timestamp: Date.now()
    });
}

/**
 * Broadcast raid detection alert
 */
export function broadcastRaidAlert(io, guildId, incident) {
    io.to(`guild:${guildId}`).emit('security:raid', {
        ...incident,
        timestamp: Date.now()
    });

    // Also notify to user rooms for admins
    logger.warn(`[Socket] Raid detected in guild ${guildId}`);
}

/**
 * Broadcast ban/kick event
 */
export function broadcastBanKick(io, guildId, event) {
    io.to(`guild:${guildId}`).emit('moderation:action', {
        type: event.type, // 'ban' or 'kick'
        userId: event.userId,
        username: event.username,
        moderatorId: event.moderatorId,
        moderatorName: event.moderatorName,
        reason: event.reason,
        timestamp: Date.now()
    });
}

export default moderationHandler;
