/**
 * Socket.io Server Setup
 * Main entry point for WebSocket functionality
 */

import { Server } from 'socket.io';
import logger from '../../utils/logger.js';

// Import handlers
import { configHandler } from './handlers/config.js';
import { statsHandler } from './handlers/stats.js';
import { moderationHandler } from './handlers/moderation.js';
import { streamHandler } from './handlers/stream.js';

let io = null;

/**
 * Initialize Socket.io server
 * @param {Object} httpServer - HTTP server instance
 * @param {Object} sessionMiddleware - Express session middleware
 * @returns {Server} Socket.io server instance
 */
export function initializeSocket(httpServer, sessionMiddleware) {
    io = new Server(httpServer, {
        cors: {
            origin: process.env.DASHBOARD_URL || 'http://localhost:3001',
            methods: ['GET', 'POST'],
            credentials: true
        },
        pingTimeout: 60000,
        pingInterval: 25000,
        transports: ['websocket', 'polling']
    });

    // Share session with Socket.io
    io.use((socket, next) => {
        sessionMiddleware(socket.request, {}, next);
    });

    // Authentication middleware
    io.use((socket, next) => {
        const session = socket.request.session;
        if (session && session.passport && session.passport.user) {
            socket.user = session.passport.user;
            next();
        } else {
            next(new Error('Authentication required'));
        }
    });

    // Connection handler
    io.on('connection', (socket) => {
        const user = socket.user;
        logger.info(`[Socket.io] User ${user?.username || 'Unknown'} connected (${socket.id})`);

        // Join user's personal room
        if (user?.id) {
            socket.join(`user:${user.id}`);
        }

        // Room management
        socket.on('join:guild', (guildId) => {
            if (!guildId || !/^\d{17,19}$/.test(guildId)) return;
            socket.join(`guild:${guildId}`);
            socket.currentGuildId = guildId;
            logger.debug(`[Socket.io] ${user?.username} joined guild:${guildId}`);
        });

        socket.on('leave:guild', (guildId) => {
            if (!guildId) return;
            socket.leave(`guild:${guildId}`);
            if (socket.currentGuildId === guildId) {
                socket.currentGuildId = null;
            }
            logger.debug(`[Socket.io] ${user?.username} left guild:${guildId}`);
        });

        // Register handlers
        configHandler(io, socket);
        statsHandler(io, socket);
        moderationHandler(io, socket);
        streamHandler(io, socket);

        // Disconnection
        socket.on('disconnect', (reason) => {
            logger.debug(`[Socket.io] ${user?.username || 'Unknown'} disconnected: ${reason}`);
        });

        // Error handling
        socket.on('error', (error) => {
            logger.error(`[Socket.io] Error for ${user?.username}:`, error);
        });
    });

    logger.info('[Socket.io] Server initialized');
    return io;
}

/**
 * Get Socket.io instance
 */
export function getIO() {
    return io;
}

/**
 * Emit to guild room
 */
export function emitToGuild(guildId, event, data) {
    if (io) {
        io.to(`guild:${guildId}`).emit(event, data);
    }
}

/**
 * Emit to user room
 */
export function emitToUser(userId, event, data) {
    if (io) {
        io.to(`user:${userId}`).emit(event, data);
    }
}

/**
 * Broadcast to all
 */
export function broadcast(event, data) {
    if (io) {
        io.emit(event, data);
    }
}

export default {
    initializeSocket,
    getIO,
    emitToGuild,
    emitToUser,
    broadcast
};
