import { getIO, emitToGuild, emitToUser } from '../config/socket.js';
import logger from '../../utils/logger.js';

/**
 * SocketService - Handles broadcasting events to connected dashboard clients
 */
class SocketService {
    constructor() {
        this.eventQueue = [];
        this.isReady = false;
    }

    /**
     * Initialize the service
     */
    init() {
        this.isReady = true;
        // Process any queued events
        while (this.eventQueue.length > 0) {
            const { method, args } = this.eventQueue.shift();
            this[method](...args);
        }
        logger.info('[SocketService] Initialized');
    }

    /**
     * Queue event if not ready, otherwise execute
     */
    _queueOrExecute(method, args) {
        if (!this.isReady) {
            this.eventQueue.push({ method, args });
            return;
        }
    }

    // ==================== Config Events ====================

    /**
     * Notify clients that a config was saved
     * @param {string} guildId - Guild ID
     * @param {string} feature - Feature name (e.g., 'moderation', 'leveling')
     * @param {Object} config - Updated config data
     */
    configSaved(guildId, feature, config) {
        emitToGuild(guildId, 'config:saved', { feature, config, timestamp: Date.now() });
        logger.debug(`[SocketService] Config saved: ${feature} for guild ${guildId}`);
    }

    /**
     * Notify clients of a config error
     * @param {string} guildId - Guild ID
     * @param {string} feature - Feature name
     * @param {string} error - Error message
     */
    configError(guildId, feature, error) {
        emitToGuild(guildId, 'config:error', { feature, error, timestamp: Date.now() });
    }

    // ==================== Stats Events ====================

    /**
     * Send real-time stats update
     * @param {string} guildId - Guild ID
     * @param {Object} stats - Stats data
     */
    statsUpdate(guildId, stats) {
        emitToGuild(guildId, 'stats:update', { ...stats, timestamp: Date.now() });
    }

    /**
     * Send member count update
     * @param {string} guildId - Guild ID
     * @param {number} totalMembers - Total member count
     * @param {number} onlineMembers - Online member count
     */
    memberCountUpdate(guildId, totalMembers, onlineMembers) {
        emitToGuild(guildId, 'stats:members', {
            totalMembers,
            onlineMembers,
            timestamp: Date.now()
        });
    }

    // ==================== Moderation Events ====================

    /**
     * Notify of a new moderation action
     * @param {string} guildId - Guild ID
     * @param {Object} action - Moderation action details
     */
    moderationAction(guildId, action) {
        emitToGuild(guildId, 'moderation:action', {
            ...action,
            timestamp: Date.now()
        });
    }

    /**
     * Notify of automod trigger
     * @param {string} guildId - Guild ID
     * @param {Object} details - Automod trigger details
     */
    automodTrigger(guildId, details) {
        emitToGuild(guildId, 'moderation:automod', {
            ...details,
            timestamp: Date.now()
        });
    }

    // ==================== Security Events ====================

    /**
     * Notify of raid detection
     * @param {string} guildId - Guild ID
     * @param {Object} incident - Raid incident details
     */
    raidDetected(guildId, incident) {
        emitToGuild(guildId, 'security:raid-detected', {
            ...incident,
            timestamp: Date.now()
        });
    }

    /**
     * Notify of security alert
     * @param {string} guildId - Guild ID
     * @param {string} type - Alert type
     * @param {Object} details - Alert details
     */
    securityAlert(guildId, type, details) {
        emitToGuild(guildId, 'security:alert', {
            type,
            ...details,
            timestamp: Date.now()
        });
    }

    // ==================== Stream Events ====================

    /**
     * Notify when a streamer goes live
     * @param {string} guildId - Guild ID
     * @param {Object} streamer - Streamer details
     */
    streamerLive(guildId, streamer) {
        emitToGuild(guildId, 'stream:live', {
            ...streamer,
            timestamp: Date.now()
        });
    }

    /**
     * Notify when a streamer goes offline
     * @param {string} guildId - Guild ID
     * @param {Object} streamer - Streamer details
     */
    streamerOffline(guildId, streamer) {
        emitToGuild(guildId, 'stream:offline', {
            ...streamer,
            timestamp: Date.now()
        });
    }

    // ==================== Bot Status Events ====================

    /**
     * Notify of bot status change
     * @param {string} status - Bot status ('online', 'offline', 'reconnecting')
     * @param {string} botId - Bot ID (for custom bots)
     */
    botStatus(status, botId = 'default') {
        const io = getIO();
        if (io) {
            io.emit('bot:status', { botId, status, timestamp: Date.now() });
        }
    }

    // ==================== User Events ====================

    /**
     * Send notification to specific user
     * @param {string} userId - User ID
     * @param {string} type - Notification type
     * @param {string} message - Notification message
     */
    notifyUser(userId, type, message) {
        emitToUser(userId, 'notification', {
            type,
            message,
            timestamp: Date.now()
        });
    }

    // ==================== Ticket Events ====================

    /**
     * Notify of new ticket
     * @param {string} guildId - Guild ID
     * @param {Object} ticket - Ticket details
     */
    ticketCreated(guildId, ticket) {
        emitToGuild(guildId, 'ticket:created', {
            ...ticket,
            timestamp: Date.now()
        });
    }

    /**
     * Notify of ticket update
     * @param {string} guildId - Guild ID
     * @param {Object} ticket - Ticket details
     */
    ticketUpdated(guildId, ticket) {
        emitToGuild(guildId, 'ticket:updated', {
            ...ticket,
            timestamp: Date.now()
        });
    }

    // ==================== Giveaway Events ====================

    /**
     * Notify of giveaway end
     * @param {string} guildId - Guild ID
     * @param {Object} giveaway - Giveaway details with winners
     */
    giveawayEnded(guildId, giveaway) {
        emitToGuild(guildId, 'giveaway:ended', {
            ...giveaway,
            timestamp: Date.now()
        });
    }
}

// Singleton instance
const socketService = new SocketService();
export default socketService;
