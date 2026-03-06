/**
 * Kick Chat Client for CertiFriedUtility Bot
 * Uses Kick's official API and Pusher-based WebSocket for chat
 */

import WebSocket from 'ws';
import logger from '../../utils/logger.js';
import pool from '../../utils/db.js';
import { handleMessage } from './command-handler.js';
import { decryptToken, encryptToken } from '../../utils/token-encryption.js';
import { fetchAndStoreChatroomId } from '../../utils/platforms/kick-scraper.js';

const KICK_PUSHER_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.0.1&flash=false';
const KICK_API_BASE = 'https://api.kick.com/public/v1';
const KICK_AUTH_BASE = 'https://id.kick.com';

export class KickBot {
    constructor() {
        this.socket = null;
        this.isConnected = false;
        this.channels = new Map(); // channelId -> { name, chatroomId, broadcasterId }
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 5000;
        this.pingInterval = null;
        this.accessToken = null;
        this.appAccessToken = null;
        this.appTokenExpiry = null;
    }

    /**
     * Get App Access Token for server-to-server API calls
     */
    async getAppAccessToken() {
        // Return cached token if still valid
        if (this.appAccessToken && this.appTokenExpiry && Date.now() < this.appTokenExpiry) {
            return this.appAccessToken;
        }

        try {
            const response = await fetch(`${KICK_AUTH_BASE}/oauth/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'client_credentials',
                    client_id: process.env.KICK_CLIENT_ID,
                    client_secret: process.env.KICK_CLIENT_SECRET
                })
            });

            if (!response.ok) {
                const error = await response.text();
                logger.error('[KickBot] Failed to get app access token', { error });
                return null;
            }

            const data = await response.json();
            this.appAccessToken = data.access_token;
            // Set expiry 5 minutes before actual expiry for safety
            this.appTokenExpiry = Date.now() + (data.expires_in - 300) * 1000;

            logger.info('[KickBot] Got app access token');
            return this.appAccessToken;

        } catch (error) {
            logger.error('[KickBot] Error getting app access token', { error: error.message });
            return null;
        }
    }

    /**
     * Make authenticated API request to Kick official API
     */
    async kickApiRequest(endpoint, options = {}) {
        const token = await this.getAppAccessToken();
        if (!token) {
            throw new Error('No app access token available');
        }

        const response = await fetch(`${KICK_API_BASE}${endpoint}`, {
            ...options,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...options.headers
            }
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Kick API error (${response.status}): ${error}`);
        }

        if (response.status === 204) {
            return { success: true };
        }

        return response.json();
    }

    /**
     * Connect to Kick chat via Pusher WebSocket
     */
    async connect() {
        logger.info('[KickBot] Initializing Kick connection...');

        // Get bot credentials
        this.accessToken = process.env.KICK_BOT_ACCESS_TOKEN;

        // Get enabled channels from database
        const channelsToJoin = await this.getEnabledChannels();

        if (channelsToJoin.length === 0) {
            logger.info('[KickBot] No Kick channels enabled');
            return;
        }

        try {
            await this.connectWebSocket();

            // Join channels after connection
            for (const channel of channelsToJoin) {
                await this.joinChannel(channel.channel_name, channel.channel_id, channel.chatroom_id);
            }

            logger.info(`[KickBot] Connected to ${channelsToJoin.length} channels`);

        } catch (error) {
            logger.error('[KickBot] Failed to connect', { error: error.message });
            throw error;
        }
    }

    /**
     * Connect to Pusher WebSocket
     */
    connectWebSocket() {
        return new Promise((resolve, reject) => {
            this.socket = new WebSocket(KICK_PUSHER_URL);

            this.socket.on('open', () => {
                logger.info('[KickBot] WebSocket connected');
                this.isConnected = true;
                this.reconnectAttempts = 0;

                // Start ping interval
                this.pingInterval = setInterval(() => {
                    this.sendPing();
                }, 30000);

                resolve();
            });

            this.socket.on('message', (data) => {
                this.handleSocketMessage(data.toString());
            });

            this.socket.on('close', () => {
                logger.warn('[KickBot] WebSocket disconnected');
                this.isConnected = false;
                this.clearPingInterval();
                this.attemptReconnect();
            });

            this.socket.on('error', (error) => {
                logger.error('[KickBot] WebSocket error', { error: error.message });
                reject(error);
            });
        });
    }

    /**
     * Disconnect from Kick
     */
    async disconnect() {
        this.clearPingInterval();

        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }

        this.isConnected = false;
        this.channels.clear();
        logger.info('[KickBot] Disconnected from Kick');
    }

    /**
     * Clear ping interval
     */
    clearPingInterval() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    /**
     * Send ping to keep connection alive
     */
    sendPing() {
        if (this.socket && this.isConnected) {
            this.socket.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
        }
    }

    /**
     * Attempt to reconnect
     */
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.error('[KickBot] Max reconnection attempts reached');
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * this.reconnectAttempts;

        logger.info(`[KickBot] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);

        setTimeout(async () => {
            try {
                await this.connectWebSocket();

                // Rejoin channels
                for (const [channelId, info] of this.channels) {
                    await this.subscribeToChannel(info.chatroomId);
                }
            } catch (error) {
                logger.error('[KickBot] Reconnection failed', { error: error.message });
            }
        }, delay);
    }

    /**
     * Get enabled Kick channels from database
     */
    async getEnabledChannels() {
        try {
            const [rows] = await pool.execute(
                `SELECT channel_id, channel_name, chatroom_id FROM tokes_channels
                 WHERE platform = 'kick' AND is_enabled = 1`
            );
            return rows;
        } catch (error) {
            logger.error('[KickBot] Failed to get enabled channels', { error: error.message });
            return [];
        }
    }

    /**
     * Handle incoming WebSocket message
     */
    handleSocketMessage(data) {
        try {
            const message = JSON.parse(data);

            // Log all events for debugging
            if (message.event && !message.event.includes('pong') && !message.event.includes('ping')) {
                logger.info('[KickBot] Received event', { event: message.event, channel: message.channel });
            }

            switch (message.event) {
                case 'pusher:connection_established':
                    logger.info('[KickBot] Pusher connection established');
                    break;

                case 'pusher:pong':
                    // Pong received, connection is alive
                    break;

                case 'pusher_internal:subscription_succeeded':
                    logger.info('[KickBot] Subscription succeeded', { channel: message.channel });
                    break;

                case 'App\\Events\\ChatMessageEvent':
                case 'ChatMessageEvent':
                case 'chat_message':
                    this.handleChatMessage(message);
                    break;

                default:
                    // Log unknown events that might be chat messages
                    if (message.data && message.channel?.includes('chatrooms')) {
                        logger.info('[KickBot] Unknown chatroom event', { event: message.event });
                        // Try to handle it as a chat message anyway
                        this.handleChatMessage(message);
                    }
                    break;
            }

        } catch (error) {
            logger.error('[KickBot] Failed to parse message', { error: error.message });
        }
    }

    /**
     * Handle chat message event
     */
    async handleChatMessage(message) {
        try {
            const data = JSON.parse(message.data);

            logger.info('[KickBot] Processing chat message', {
                channel: message.channel,
                sender: data.sender?.username,
                content: data.content?.substring(0, 50)
            });

            // Extract channel info from Pusher channel name (chatrooms.{id}.v2)
            const channelMatch = message.channel?.match(/chatrooms\.(\d+)/);
            if (!channelMatch) {
                logger.warn('[KickBot] No chatroom match in channel name', { channel: message.channel });
                return;
            }

            const chatroomId = channelMatch[1];
            const channelInfo = this.getChannelByChatroomId(chatroomId);

            if (!channelInfo) {
                logger.warn('[KickBot] Channel info not found for chatroom', { chatroomId });
                return;
            }

            // Build context
            await handleMessage({
                platform: 'kick',
                channelId: channelInfo.channelId,
                channelName: channelInfo.name,
                userId: data.sender?.id?.toString(),
                username: data.sender?.username || data.sender?.slug,
                message: data.content?.trim() || '',
                isBroadcaster: data.sender?.id === channelInfo.broadcasterId,
                isMod: data.sender?.is_moderator || data.sender?.is_staff,
                reply: (text) => this.sendMessage(chatroomId, text)
            });

        } catch (error) {
            logger.error('[KickBot] Error handling chat message', { error: error.message });
        }
    }

    /**
     * Get channel info by chatroom ID
     */
    getChannelByChatroomId(chatroomId) {
        for (const [channelId, info] of this.channels) {
            if (info.chatroomId === chatroomId) {
                return { channelId, ...info };
            }
        }
        return null;
    }

    /**
     * Subscribe to a channel's chatroom
     */
    subscribeToChannel(chatroomId) {
        if (!this.socket || !this.isConnected) return;

        const subscribeMessage = {
            event: 'pusher:subscribe',
            data: {
                channel: `chatrooms.${chatroomId}.v2`
            }
        };

        this.socket.send(JSON.stringify(subscribeMessage));
    }

    /**
     * Unsubscribe from a channel's chatroom
     */
    unsubscribeFromChannel(chatroomId) {
        if (!this.socket || !this.isConnected) return;

        const unsubscribeMessage = {
            event: 'pusher:unsubscribe',
            data: {
                channel: `chatrooms.${chatroomId}.v2`
            }
        };

        this.socket.send(JSON.stringify(unsubscribeMessage));
    }

    /**
     * Refresh an expired Kick access token
     * @param {number} connectionId - The platform connection ID
     * @param {string} encryptedRefreshToken - The encrypted refresh token
     * @returns {Promise<string|null>} New access token or null on failure
     */
    async refreshAccessToken(connectionId, encryptedRefreshToken) {
        try {
            const refreshToken = decryptToken(encryptedRefreshToken);
            if (!refreshToken) {
                logger.error('[KickBot] Failed to decrypt refresh token');
                return null;
            }

            const response = await fetch(`${KICK_AUTH_BASE}/oauth/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    client_id: process.env.KICK_CLIENT_ID,
                    client_secret: process.env.KICK_CLIENT_SECRET,
                    refresh_token: refreshToken
                })
            });

            if (!response.ok) {
                const error = await response.text();
                logger.error('[KickBot] Failed to refresh token', { status: response.status, error });
                return null;
            }

            const data = await response.json();
            if (!data.access_token) {
                logger.error('[KickBot] No access token in refresh response');
                return null;
            }

            // Calculate new expiry
            const expiresAt = new Date(Date.now() + (data.expires_in - 300) * 1000);

            // Update database with new tokens
            await pool.execute(`
                UPDATE tokes_platform_connections
                SET access_token = ?, refresh_token = ?, expires_at = ?, token_updated_at = NOW()
                WHERE id = ?
            `, [
                encryptToken(data.access_token),
                data.refresh_token ? encryptToken(data.refresh_token) : encryptedRefreshToken,
                expiresAt.toISOString().slice(0, 19).replace('T', ' '),
                connectionId
            ]);

            logger.info('[KickBot] Successfully refreshed access token', { connectionId });
            return data.access_token;

        } catch (error) {
            logger.error('[KickBot] Error refreshing token', { error: error.message });
            return null;
        }
    }

    /**
     * Get a valid access token for a channel, refreshing if expired
     * @param {string} dbChannelId - The channel ID in the database
     * @returns {Promise<string|null>} Valid access token or null
     */
    async getValidAccessToken(dbChannelId) {
        const [rows] = await pool.execute(`
            SELECT pc.id, pc.access_token, pc.refresh_token, pc.expires_at
            FROM tokes_channels c
            JOIN tokes_platform_connections pc ON c.connection_id = pc.id
            WHERE c.channel_id = ? AND c.platform = 'kick'
        `, [dbChannelId]);

        if (!rows[0]?.access_token) {
            logger.error('[KickBot] No access token found for channel', { dbChannelId });
            return null;
        }

        const { id: connectionId, access_token, refresh_token, expires_at } = rows[0];

        // Check if token is expired (with 5 min buffer)
        const isExpired = expires_at && new Date(expires_at) < new Date(Date.now() + 5 * 60 * 1000);

        if (isExpired && refresh_token) {
            logger.info('[KickBot] Token expired, refreshing...', { dbChannelId });
            const newToken = await this.refreshAccessToken(connectionId, refresh_token);
            if (newToken) {
                return newToken;
            }
            // Fall through to try the old token anyway
        }

        const token = decryptToken(access_token);
        if (!token) {
            logger.error('[KickBot] Failed to decrypt access token', { dbChannelId });
            return null;
        }

        return token;
    }

    /**
     * Send message to channel via official Kick API
     * Uses channel owner's token with type: 'bot' so message appears from CertiFriedUtility
     */
    async sendMessage(chatroomId, content) {
        // Find the channel info by chatroom ID to get broadcaster ID and db channel ID
        let broadcasterId = null;
        let dbChannelId = null;
        for (const [channelId, info] of this.channels) {
            if (info.chatroomId === chatroomId) {
                broadcasterId = info.broadcasterId;
                dbChannelId = channelId;
                break;
            }
        }

        if (!broadcasterId) {
            logger.warn('[KickBot] No broadcaster ID found for chatroom, cannot send message', { chatroomId });
            return;
        }

        try {
            // Get a valid access token (refreshes if expired)
            const token = await this.getValidAccessToken(dbChannelId);
            if (!token) {
                logger.error('[KickBot] Could not get valid access token', { chatroomId, dbChannelId });
                return;
            }

            // Use official API with type: 'bot'
            // The user token provides auth, type: 'bot' makes message appear from CertiFriedUtility app
            const response = await fetch(`${KICK_API_BASE}/chat`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    broadcaster_user_id: parseInt(broadcasterId),
                    content: content.substring(0, 500), // Kick max 500 chars
                    type: 'bot' // Message appears from CertiFriedUtility app name
                })
            });

            if (!response.ok) {
                const error = await response.text();
                logger.error('[KickBot] Failed to send message', { status: response.status, error, broadcasterId });
            } else {
                logger.info('[KickBot] Message sent successfully as CertiFriedUtility bot');
            }

        } catch (error) {
            logger.error('[KickBot] Error sending message', { error: error.message });
        }
    }

    /**
     * Join a channel
     * @param {string} channelName - Channel slug/name
     * @param {string} channelId - Database channel ID (broadcaster user ID)
     * @param {string} dbChatroomId - Chatroom ID from database (if known)
     */
    async joinChannel(channelName, channelId, dbChatroomId = null) {
        try {
            let chatroomId = dbChatroomId; // Use database value if provided
            let broadcasterId = channelId; // broadcaster_user_id

            // If no chatroom ID from database, try to fetch it
            if (!chatroomId) {
                try {
                    const channelData = await this.kickApiRequest(`/channels?slug=${channelName.toLowerCase()}`);
                    if (channelData.data?.[0]) {
                        const channel = channelData.data[0];
                        broadcasterId = channel.broadcaster_user_id;
                        // Official API doesn't return chatroom ID directly
                        logger.info(`[KickBot] Got channel info from official API`, { channel: channelName, broadcasterId });
                    }
                } catch (apiError) {
                    logger.warn('[KickBot] Official API failed', { error: apiError.message });
                }

                // Try to fetch chatroom ID using puppeteer scraper
                const fetchedChatroomId = await fetchAndStoreChatroomId(channelName);
                if (fetchedChatroomId) {
                    chatroomId = fetchedChatroomId;
                    logger.info(`[KickBot] Got chatroom ID from scraper`, { channel: channelName, chatroomId });
                }

                // If still no chatroom ID, use channel_id as fallback
                if (!chatroomId) {
                    logger.warn('[KickBot] No chatroom ID available, using channel_id as fallback', { channel: channelName });
                    chatroomId = channelId;
                }
            }

            // Store channel info
            this.channels.set(channelId, {
                name: channelName,
                chatroomId: chatroomId,
                broadcasterId: broadcasterId
            });

            // Subscribe to chatroom via Pusher
            this.subscribeToChannel(chatroomId);

            logger.info(`[KickBot] Joined channel: ${channelName} (chatroom: ${chatroomId})`);
            return true;

        } catch (error) {
            logger.error('[KickBot] Failed to join channel', {
                channel: channelName,
                error: error.message
            });
            return false;
        }
    }

    /**
     * Leave a channel
     */
    async leaveChannel(channelName) {
        for (const [channelId, info] of this.channels) {
            if (info.name.toLowerCase() === channelName.toLowerCase()) {
                this.unsubscribeFromChannel(info.chatroomId);
                this.channels.delete(channelId);
                logger.info(`[KickBot] Left channel: ${channelName}`);
                return true;
            }
        }
        return false;
    }

    /**
     * Get list of joined channels
     */
    getChannels() {
        return Array.from(this.channels.values()).map(info => info.name);
    }
}
