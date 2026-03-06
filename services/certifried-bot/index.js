/**
 * CertiFriedUtility - Cannabis Community Chat Bot
 * Main entry point for Twitch and Kick bot services
 */

import 'dotenv/config';
import logger from '../../utils/logger.js';
import { TwitchBot } from './twitch-client.js';
import { KickBot } from './kick-client.js';
import pool from '../../utils/db.js';

class CertiFriedUtility {
    constructor() {
        this.twitchBot = null;
        this.kickBot = null;
        this.isRunning = false;
    }

    /**
     * Start the bot services
     */
    async start() {
        if (this.isRunning) {
            logger.warn('[CertiFriedUtility] Already running');
            return;
        }

        logger.info('[CertiFriedUtility] Starting CertiFriedUtility bot services...');

        try {
            // Initialize Twitch bot
            logger.info('[CertiFriedUtility] Step 1: Creating TwitchBot instance...');
            this.twitchBot = new TwitchBot();
            logger.info('[CertiFriedUtility] Step 2: Connecting TwitchBot...');
            await this.twitchBot.connect();
            logger.info('[CertiFriedUtility] Step 3: TwitchBot connected successfully');

            // Initialize Kick bot
            logger.info('[CertiFriedUtility] Step 4: Creating KickBot instance...');
            this.kickBot = new KickBot();
            logger.info('[CertiFriedUtility] Step 5: Connecting KickBot...');
            await this.kickBot.connect();
            logger.info('[CertiFriedUtility] Step 6: KickBot connected successfully');

            this.isRunning = true;
            logger.info('[CertiFriedUtility] All bot services started successfully');

            // Log activity
            await this.logActivity('system', 'bot_start', null, 'CertiFriedUtility bot services started');

        } catch (error) {
            logger.error('[CertiFriedUtility] Failed to start bot services', { error: error.message });
            throw error;
        }
    }

    /**
     * Stop the bot services
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        logger.info('[CertiFriedUtility] Stopping CertiFriedUtility bot services...');

        try {
            if (this.twitchBot) {
                await this.twitchBot.disconnect();
            }

            if (this.kickBot) {
                await this.kickBot.disconnect();
            }

            this.isRunning = false;
            await this.logActivity('system', 'bot_stop', null, 'CertiFriedUtility bot services stopped');
            logger.info('[CertiFriedUtility] All bot services stopped');

        } catch (error) {
            logger.error('[CertiFriedUtility] Error stopping bot services', { error: error.message });
        }
    }

    /**
     * Log activity to the database
     */
    async logActivity(platform, eventType, actor, details) {
        try {
            await pool.execute(
                `INSERT INTO tokes_activity_log (platform, event_type, actor, details)
                 VALUES (?, ?, ?, ?)`,
                [platform, eventType, actor, details]
            );
        } catch (error) {
            logger.error('[CertiFriedUtility] Failed to log activity', { error: error.message });
        }
    }

    /**
     * Get bot status
     */
    getStatus() {
        return {
            running: this.isRunning,
            twitch: {
                connected: this.twitchBot?.isConnected || false,
                channels: this.twitchBot?.getChannels() || []
            },
            kick: {
                connected: this.kickBot?.isConnected || false,
                channels: this.kickBot?.getChannels() || []
            }
        };
    }

    /**
     * Join a channel on the specified platform
     */
    async joinChannel(platform, channelName) {
        if (platform === 'twitch' && this.twitchBot) {
            await this.twitchBot.joinChannel(channelName);
        } else if (platform === 'kick' && this.kickBot) {
            await this.kickBot.joinChannel(channelName);
        }
    }

    /**
     * Leave a channel on the specified platform
     */
    async leaveChannel(platform, channelName) {
        if (platform === 'twitch' && this.twitchBot) {
            await this.twitchBot.leaveChannel(channelName);
        } else if (platform === 'kick' && this.kickBot) {
            await this.kickBot.leaveChannel(channelName);
        }
    }
}

// Create singleton instance
const certiFriedBot = new CertiFriedUtility();

// Handle graceful shutdown
process.on('SIGINT', async () => {
    await certiFriedBot.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await certiFriedBot.stop();
    process.exit(0);
});

export { certiFriedBot, CertiFriedUtility };
export default certiFriedBot;
