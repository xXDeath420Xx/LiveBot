/**
 * WebSocket Broadcaster
 * Pub/sub system for broadcasting events to channels
 */

import logger from '../../../utils/logger.js';
import { sendToPlayer } from './handler.js';

// Channel subscriptions: channelName -> Set<playerId>
const channels = new Map();

// Player subscriptions: playerId -> Set<channelName>
const playerChannels = new Map();

/**
 * Subscribe a player to a channel
 * @param {number} playerId - Player ID
 * @param {string} channel - Channel name
 */
export function subscribe(playerId, channel) {
    // Add to channel
    if (!channels.has(channel)) {
        channels.set(channel, new Set());
    }
    channels.get(channel).add(playerId);

    // Track player's channels
    if (!playerChannels.has(playerId)) {
        playerChannels.set(playerId, new Set());
    }
    playerChannels.get(playerId).add(channel);

    logger.debug('[Broadcaster] Subscribed', { playerId, channel });
}

/**
 * Unsubscribe a player from a channel (or all channels if no channel specified)
 * @param {number} playerId - Player ID
 * @param {string} channel - Channel name (optional)
 */
export function unsubscribe(playerId, channel = null) {
    if (channel) {
        // Unsubscribe from specific channel
        const channelSubs = channels.get(channel);
        if (channelSubs) {
            channelSubs.delete(playerId);
            if (channelSubs.size === 0) {
                channels.delete(channel);
            }
        }

        const playerSubs = playerChannels.get(playerId);
        if (playerSubs) {
            playerSubs.delete(channel);
        }
    } else {
        // Unsubscribe from all channels
        const playerSubs = playerChannels.get(playerId);
        if (playerSubs) {
            for (const ch of playerSubs) {
                const channelSubs = channels.get(ch);
                if (channelSubs) {
                    channelSubs.delete(playerId);
                    if (channelSubs.size === 0) {
                        channels.delete(ch);
                    }
                }
            }
            playerChannels.delete(playerId);
        }
    }

    logger.debug('[Broadcaster] Unsubscribed', { playerId, channel });
}

/**
 * Broadcast a message to a channel
 * @param {string} channel - Channel name
 * @param {object} message - Message to broadcast
 * @param {number} excludePlayerId - Player ID to exclude (optional)
 */
export function broadcast(channel, message, excludePlayerId = null) {
    const subscribers = channels.get(channel);
    if (!subscribers || subscribers.size === 0) return;

    const envelope = {
        channel,
        time: Date.now(),
        ...message
    };

    let sent = 0;
    for (const playerId of subscribers) {
        if (playerId === excludePlayerId) continue;
        if (sendToPlayer(playerId, envelope)) {
            sent++;
        }
    }

    logger.debug('[Broadcaster] Broadcast', { channel, sent, total: subscribers.size });
}

/**
 * Broadcast to all connected players
 * @param {object} message - Message to broadcast
 */
export function broadcastAll(message) {
    const envelope = {
        channel: 'global',
        time: Date.now(),
        ...message
    };

    let sent = 0;
    for (const playerId of playerChannels.keys()) {
        if (sendToPlayer(playerId, envelope)) {
            sent++;
        }
    }

    logger.debug('[Broadcaster] Broadcast all', { sent });
}

// Pre-defined channel event helpers

/**
 * Notify player of a personal event
 */
export function notifyPlayer(playerId, eventType, data) {
    sendToPlayer(playerId, {
        type: 'event',
        event: eventType,
        data,
        time: Date.now()
    });
}

/**
 * Broadcast market update
 */
export function broadcastMarketUpdate(data) {
    broadcast('market', {
        type: 'market_update',
        data
    });
}

/**
 * Broadcast leaderboard update
 */
export function broadcastLeaderboardUpdate(type, data) {
    broadcast('leaderboard', {
        type: 'leaderboard_update',
        leaderboardType: type,
        data
    });
}

/**
 * Notify trade participants
 */
export function notifyTradeUpdate(trade, eventType) {
    const data = {
        type: 'trade_update',
        event: eventType,
        tradeId: trade.id
    };

    notifyPlayer(trade.offerer_id, eventType, data);
    if (trade.receiver_id) {
        notifyPlayer(trade.receiver_id, eventType, data);
    }
}

/**
 * Get channel subscriber count
 */
export function getChannelCount(channel) {
    return channels.get(channel)?.size || 0;
}

/**
 * Get all channels a player is subscribed to
 */
export function getPlayerChannels(playerId) {
    return Array.from(playerChannels.get(playerId) || []);
}

export default {
    subscribe,
    unsubscribe,
    broadcast,
    broadcastAll,
    notifyPlayer,
    broadcastMarketUpdate,
    broadcastLeaderboardUpdate,
    notifyTradeUpdate,
    getChannelCount,
    getPlayerChannels
};
