/**
 * Twitch IRC Client for CertiFriedUtility Bot
 * Uses tmi.js for Twitch chat integration
 */

import tmi from 'tmi.js';
import logger from '../../utils/logger.js';
import pool from '../../utils/db.js';
import { handleMessage } from './command-handler.js';
import { checkAutomod } from './automod.js';

export class TwitchBot {
    constructor() {
        this.client = null;
        this.isConnected = false;
        this.channels = new Set();
    }

    /**
     * Connect to Twitch IRC
     */
    async connect() {
        logger.info('[TwitchBot] Initializing Twitch connection...');

        // Get bot credentials from environment
        const username = process.env.TWITCH_BOT_USERNAME || process.env.TWITCH_USERNAME;
        const oauthToken = process.env.TWITCH_BOT_OAUTH || process.env.TWITCH_OAUTH_TOKEN;

        if (!username || !oauthToken) {
            logger.warn('[TwitchBot] Missing Twitch credentials, running in read-only mode');
        }

        // Get enabled channels from database
        const channelsToJoin = await this.getEnabledChannels();

        // Create client
        this.client = new tmi.Client({
            options: {
                debug: process.env.NODE_ENV === 'development'
            },
            connection: {
                reconnect: true,
                secure: true
            },
            identity: username && oauthToken ? {
                username: username,
                password: oauthToken.startsWith('oauth:') ? oauthToken : `oauth:${oauthToken}`
            } : undefined,
            channels: channelsToJoin
        });

        // Set up event handlers
        this.setupEventHandlers();

        // Connect
        try {
            await this.client.connect();
            this.isConnected = true;
            channelsToJoin.forEach(ch => this.channels.add(ch.toLowerCase()));
            logger.info(`[TwitchBot] Connected to ${channelsToJoin.length} channels`);
        } catch (error) {
            logger.error('[TwitchBot] Failed to connect', { error: error.message });
            throw error;
        }
    }

    /**
     * Disconnect from Twitch IRC
     */
    async disconnect() {
        if (this.client) {
            await this.client.disconnect();
            this.isConnected = false;
            this.channels.clear();
            logger.info('[TwitchBot] Disconnected from Twitch');
        }
    }

    /**
     * Reconnect to Twitch IRC
     */
    async reconnect() {
        logger.info('[TwitchBot] Reconnect requested...');
        try {
            // Disconnect if currently connected
            if (this.client && this.isConnected) {
                await this.disconnect();
            }
            // Establish fresh connection
            await this.connect();
            logger.info('[TwitchBot] Reconnect successful');
        } catch (error) {
            logger.error('[TwitchBot] Reconnect failed', { error: error.message });
            throw error;
        }
    }

    /**
     * Get enabled Twitch channels from database
     */
    async getEnabledChannels() {
        try {
            const [rows] = await pool.execute(
                `SELECT channel_name FROM tokes_channels
                 WHERE platform = 'twitch' AND is_enabled = 1`
            );
            return rows.map(r => r.channel_name);
        } catch (error) {
            logger.error('[TwitchBot] Failed to get enabled channels', { error: error.message });
            return [];
        }
    }

    /**
     * Set up event handlers
     */
    setupEventHandlers() {
        // Connected
        this.client.on('connected', (addr, port) => {
            logger.info(`[TwitchBot] Connected to ${addr}:${port}`);
        });

        // Disconnected
        this.client.on('disconnected', (reason) => {
            logger.warn('[TwitchBot] Disconnected', { reason });
            this.isConnected = false;
        });

        // Reconnecting
        this.client.on('reconnect', () => {
            logger.info('[TwitchBot] Reconnecting...');
        });

        // Joined channel
        this.client.on('join', (channel, username, self) => {
            if (self) {
                const cleanChannel = channel.replace('#', '').toLowerCase();
                this.channels.add(cleanChannel);
                logger.info(`[TwitchBot] Joined channel: ${cleanChannel}`);
            }
        });

        // Left channel
        this.client.on('part', (channel, username, self) => {
            if (self) {
                const cleanChannel = channel.replace('#', '').toLowerCase();
                this.channels.delete(cleanChannel);
                logger.info(`[TwitchBot] Left channel: ${cleanChannel}`);
            }
        });

        // Chat message
        this.client.on('message', async (channel, tags, message, self) => {
            // Ignore own messages
            if (self) return;

            const cleanChannel = channel.replace('#', '').toLowerCase();

            try {
                // Run automod checks before command handling
                const deleted = await checkAutomod({
                    channel,
                    tags,
                    message
                });
                if (deleted) return;

                await handleMessage({
                    platform: 'twitch',
                    channelId: tags['room-id'],
                    channelName: cleanChannel,
                    userId: tags['user-id'],
                    username: tags['display-name'] || tags.username,
                    message: message.trim(),
                    isBroadcaster: tags.badges?.broadcaster === '1',
                    isMod: tags.mod || tags.badges?.moderator === '1',
                    reply: (text) => this.say(channel, text)
                });
            } catch (error) {
                logger.error('[TwitchBot] Error handling message', { error: error.message });
            }
        });

        // Notice (e.g., slow mode, sub mode)
        this.client.on('notice', (channel, msgid, message) => {
            logger.debug(`[TwitchBot] Notice in ${channel}: ${message}`);
        });
    }

    /**
     * Send a message to a channel
     */
    async say(channel, message) {
        if (!this.client || !this.isConnected) {
            logger.warn('[TwitchBot] Cannot send message, not connected');
            return;
        }

        try {
            // Ensure channel has # prefix
            const formattedChannel = channel.startsWith('#') ? channel : `#${channel}`;
            await this.client.say(formattedChannel, message);
        } catch (error) {
            logger.error('[TwitchBot] Failed to send message', { error: error.message });
        }
    }

    /**
     * Join a channel
     */
    async joinChannel(channelName) {
        if (!this.client || !this.isConnected) {
            logger.warn('[TwitchBot] Cannot join channel, not connected');
            return false;
        }

        try {
            const cleanChannel = channelName.toLowerCase().replace('#', '');
            if (this.channels.has(cleanChannel)) {
                return true; // Already in channel
            }

            await this.client.join(cleanChannel);
            this.channels.add(cleanChannel);
            logger.info(`[TwitchBot] Joined channel: ${cleanChannel}`);
            return true;

        } catch (error) {
            logger.error('[TwitchBot] Failed to join channel', {
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
        if (!this.client || !this.isConnected) {
            return false;
        }

        try {
            const cleanChannel = channelName.toLowerCase().replace('#', '');
            if (!this.channels.has(cleanChannel)) {
                return true; // Not in channel
            }

            await this.client.part(cleanChannel);
            this.channels.delete(cleanChannel);
            logger.info(`[TwitchBot] Left channel: ${cleanChannel}`);
            return true;

        } catch (error) {
            logger.error('[TwitchBot] Failed to leave channel', {
                channel: channelName,
                error: error.message
            });
            return false;
        }
    }

    /**
     * Get list of joined channels
     */
    getChannels() {
        return Array.from(this.channels);
    }
}
