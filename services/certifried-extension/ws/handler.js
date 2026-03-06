/**
 * WebSocket Handler
 * Manages WebSocket connections and authentication
 */

import logger from '../../../utils/logger.js';
import { verifyGameJWT } from '../middleware/oauth-auth.js';
import { verifyTwitchJWT } from '../middleware/twitch-jwt.js';
import { WEBSOCKET } from '../config/game-constants.js';
import { subscribe, unsubscribe, broadcast } from './broadcaster.js';

// Connected clients map: playerId -> WebSocket
const clients = new Map();

// Heartbeat tracking
const heartbeats = new Map();

// Event batching configuration
const BATCH_INTERVAL = 100; // Flush batched events every 100ms
const MAX_BATCH_SIZE = 50;  // Force flush if batch reaches this size

// Event batches per player: playerId -> { events: [], timer: null }
const eventBatches = new Map();

/**
 * Setup WebSocket server handlers
 * @param {WebSocketServer} wss - WebSocket server instance
 */
export function setupWebSocket(wss) {
    wss.on('connection', async (ws, req) => {
        let playerId = null;
        let authMode = null;

        // Parse query params for initial auth
        const url = new URL(req.url, 'wss://localhost');
        const token = url.searchParams.get('token');
        const extToken = url.searchParams.get('ext_token');

        try {
            // Authenticate
            if (extToken) {
                const twitchData = verifyTwitchJWT(extToken);
                if (!twitchData || twitchData.isUnlinked) {
                    ws.close(4001, 'Invalid Twitch token');
                    return;
                }
                // Look up player by Twitch ID
                const pool = (await import('../../../utils/db.js')).default;
                const [[player]] = await pool.execute(
                    'SELECT id FROM cfx_players WHERE platform = ? AND platform_user_id = ?',
                    ['twitch', twitchData.userId]
                );
                if (!player) {
                    ws.close(4002, 'Player not found');
                    return;
                }
                playerId = player.id;
                authMode = 'twitch';
            } else if (token) {
                const gameData = verifyGameJWT(token);
                if (!gameData) {
                    ws.close(4001, 'Invalid token');
                    return;
                }
                playerId = gameData.playerId;
                authMode = 'oauth';
            } else {
                ws.close(4000, 'Authentication required');
                return;
            }

            // Check for existing connection
            const existing = clients.get(playerId);
            if (existing) {
                existing.close(4003, 'Connection replaced');
            }

            // Store connection
            clients.set(playerId, ws);
            ws.playerId = playerId;
            ws.authMode = authMode;
            ws.isAlive = true;

            logger.debug('[WS] Client connected', { playerId, authMode });

            // Subscribe to default channels
            subscribe(playerId, 'market');
            subscribe(playerId, `player:${playerId}`);

            // Send welcome
            ws.send(JSON.stringify({
                type: 'connected',
                playerId,
                serverTime: Date.now()
            }));

            // Setup heartbeat
            heartbeats.set(playerId, Date.now());

            ws.on('pong', () => {
                ws.isAlive = true;
                heartbeats.set(playerId, Date.now());
            });

            ws.on('message', (data) => {
                handleMessage(ws, playerId, data);
            });

            ws.on('close', () => {
                logger.debug('[WS] Client disconnected', { playerId });
                clients.delete(playerId);
                heartbeats.delete(playerId);
                unsubscribe(playerId);
                // Clean up any pending batched events
                const batch = eventBatches.get(playerId);
                if (batch?.timer) {
                    clearTimeout(batch.timer);
                }
                eventBatches.delete(playerId);
            });

            ws.on('error', (error) => {
                logger.error('[WS] Client error', { playerId, error: error.message });
            });

        } catch (error) {
            logger.error('[WS] Connection error', { error: error.message });
            ws.close(4500, 'Server error');
        }
    });

    // Heartbeat interval
    setInterval(() => {
        const now = Date.now();

        wss.clients.forEach((ws) => {
            if (!ws.isAlive) {
                logger.debug('[WS] Client timeout', { playerId: ws.playerId });
                return ws.terminate();
            }

            // Check if heartbeat is too old
            const lastPong = heartbeats.get(ws.playerId);
            if (lastPong && now - lastPong > WEBSOCKET.PONG_TIMEOUT) {
                logger.debug('[WS] Client pong timeout', { playerId: ws.playerId });
                return ws.terminate();
            }

            ws.isAlive = false;
            ws.ping();
        });
    }, WEBSOCKET.PING_INTERVAL);
}

/**
 * Handle incoming WebSocket message
 */
function handleMessage(ws, playerId, data) {
    try {
        const message = JSON.parse(data.toString());

        switch (message.type) {
            case 'ping':
                ws.send(JSON.stringify({ type: 'pong', time: Date.now() }));
                break;

            case 'subscribe':
                if (message.channel) {
                    // Validate channel access
                    if (message.channel.startsWith('player:') && message.channel !== `player:${playerId}`) {
                        // Can't subscribe to other players' channels
                        break;
                    }
                    subscribe(playerId, message.channel);
                    ws.send(JSON.stringify({ type: 'subscribed', channel: message.channel }));
                }
                break;

            case 'unsubscribe':
                if (message.channel && message.channel !== `player:${playerId}`) {
                    unsubscribe(playerId, message.channel);
                    ws.send(JSON.stringify({ type: 'unsubscribed', channel: message.channel }));
                }
                break;

            default:
                logger.debug('[WS] Unknown message type', { playerId, type: message.type });
        }
    } catch (error) {
        logger.warn('[WS] Invalid message', { playerId, error: error.message });
    }
}

/**
 * Send message to a specific player (immediate, bypasses batching)
 * @param {number} playerId - Player ID
 * @param {object} message - Message to send
 * @param {boolean} immediate - If true, bypass batching (default: false)
 */
export function sendToPlayer(playerId, message, immediate = false) {
    const ws = clients.get(playerId);
    if (!ws || ws.readyState !== 1) return false;

    // High-priority message types that should never be batched
    const immediateTyes = ['connected', 'pong', 'subscribed', 'unsubscribed', 'error', 'level:up'];

    if (immediate || immediateTyes.includes(message.type)) {
        ws.send(JSON.stringify(message));
        return true;
    }

    // Add to batch
    queueEventForBatching(playerId, message);
    return true;
}

/**
 * Queue an event for batched delivery
 */
function queueEventForBatching(playerId, event) {
    let batch = eventBatches.get(playerId);

    if (!batch) {
        batch = { events: [], timer: null };
        eventBatches.set(playerId, batch);
    }

    batch.events.push(event);

    // Force flush if batch is full
    if (batch.events.length >= MAX_BATCH_SIZE) {
        flushPlayerBatch(playerId);
        return;
    }

    // Start timer if not already running
    if (!batch.timer) {
        batch.timer = setTimeout(() => {
            flushPlayerBatch(playerId);
        }, BATCH_INTERVAL);
    }
}

/**
 * Flush batched events for a player
 */
function flushPlayerBatch(playerId) {
    const batch = eventBatches.get(playerId);
    if (!batch || batch.events.length === 0) return;

    const ws = clients.get(playerId);
    if (ws && ws.readyState === 1) {
        // Send as batched message if multiple events, otherwise send single
        if (batch.events.length === 1) {
            ws.send(JSON.stringify(batch.events[0]));
        } else {
            ws.send(JSON.stringify({
                type: 'batch',
                events: batch.events,
                time: Date.now()
            }));
        }
    }

    // Clear batch
    if (batch.timer) {
        clearTimeout(batch.timer);
    }
    eventBatches.delete(playerId);
}

/**
 * Flush all pending batches (call on shutdown)
 */
export function flushAllBatches() {
    for (const playerId of eventBatches.keys()) {
        flushPlayerBatch(playerId);
    }
}

/**
 * Get connected client count
 */
export function getClientCount() {
    return clients.size;
}

/**
 * Check if player is connected
 */
export function isPlayerConnected(playerId) {
    const ws = clients.get(playerId);
    return ws && ws.readyState === 1;
}

export default { setupWebSocket, sendToPlayer, getClientCount, isPlayerConnected, flushAllBatches };
