import { Server } from 'socket.io';
import logger from '../../utils/logger.js';

let io = null;

/**
 * Initialize Socket.io server
 * @param {Object} httpServer - HTTP server instance
 * @param {Object} sessionMiddleware - Express session middleware
 * @returns {Server} Socket.io server instance
 */
export function initializeSocketIO(httpServer, sessionMiddleware) {
    io = new Server(httpServer, {
        cors: {
            origin: process.env.DASHBOARD_URL || 'http://localhost:3001',
            methods: ['GET', 'POST'],
            credentials: true
        },
        pingTimeout: 60000,
        pingInterval: 25000
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

        // Handle guild room joining
        socket.on('join:guild', (guildId) => {
            if (!guildId) return;
            socket.join(`guild:${guildId}`);
            logger.debug(`[Socket.io] User ${user?.username} joined guild room: ${guildId}`);
        });

        // Handle guild room leaving
        socket.on('leave:guild', (guildId) => {
            if (!guildId) return;
            socket.leave(`guild:${guildId}`);
            logger.debug(`[Socket.io] User ${user?.username} left guild room: ${guildId}`);
        });

        // Handle disconnection
        socket.on('disconnect', (reason) => {
            logger.debug(`[Socket.io] User ${user?.username || 'Unknown'} disconnected: ${reason}`);
        });

        // Error handling
        socket.on('error', (error) => {
            logger.error(`[Socket.io] Socket error for ${user?.username}:`, error);
        });
    });

    logger.info('[Socket.io] Server initialized');
    return io;
}

/**
 * Get the Socket.io server instance
 * @returns {Server|null} Socket.io server instance
 */
export function getIO() {
    return io;
}

/**
 * Emit event to a specific guild room
 * @param {string} guildId - Guild ID
 * @param {string} event - Event name
 * @param {any} data - Event data
 */
export function emitToGuild(guildId, event, data) {
    if (io) {
        io.to(`guild:${guildId}`).emit(event, data);
    }
}

/**
 * Emit event to a specific user
 * @param {string} userId - User ID
 * @param {string} event - Event name
 * @param {any} data - Event data
 */
export function emitToUser(userId, event, data) {
    if (io) {
        io.to(`user:${userId}`).emit(event, data);
    }
}

/**
 * Broadcast event to all connected clients
 * @param {string} event - Event name
 * @param {any} data - Event data
 */
export function broadcast(event, data) {
    if (io) {
        io.emit(event, data);
    }
}

export default {
    initializeSocketIO,
    getIO,
    emitToGuild,
    emitToUser,
    broadcast
};
