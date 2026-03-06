/**
 * Stream Socket Handler
 * Handles real-time streaming notifications
 */

import logger from '../../../utils/logger.js';

export function streamHandler(io, socket) {
    /**
     * Subscribe to stream events for a guild
     */
    socket.on('stream:subscribe', (guildId) => {
        if (!guildId) return;
        socket.streamSubscription = guildId;
        socket.emit('stream:subscribed', { guildId });
    });

    /**
     * Unsubscribe from stream events
     */
    socket.on('stream:unsubscribe', () => {
        socket.streamSubscription = null;
    });
}

/**
 * Broadcast streamer went live
 * Called from stream manager when a streamer goes live
 */
export function broadcastLive(io, guildId, streamer) {
    io.to(`guild:${guildId}`).emit('stream:live', {
        platform: streamer.platform,
        username: streamer.username,
        title: streamer.title,
        game: streamer.game,
        viewers: streamer.viewers,
        thumbnailUrl: streamer.thumbnailUrl,
        url: streamer.url,
        timestamp: Date.now()
    });
}

/**
 * Broadcast streamer went offline
 */
export function broadcastOffline(io, guildId, streamer) {
    io.to(`guild:${guildId}`).emit('stream:offline', {
        platform: streamer.platform,
        username: streamer.username,
        duration: streamer.duration,
        peakViewers: streamer.peakViewers,
        timestamp: Date.now()
    });
}

/**
 * Broadcast stream update (viewer count, title change, etc.)
 */
export function broadcastStreamUpdate(io, guildId, streamer) {
    io.to(`guild:${guildId}`).emit('stream:update', {
        platform: streamer.platform,
        username: streamer.username,
        title: streamer.title,
        game: streamer.game,
        viewers: streamer.viewers,
        timestamp: Date.now()
    });
}

/**
 * Get current live streamers count for a guild
 */
export function getLiveCount(io, guildId) {
    // This would typically query the database or cache
    // For now, just return the event
    io.to(`guild:${guildId}`).emit('stream:count-request');
}

export default streamHandler;
