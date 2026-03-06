/**
 * CertiFried Extension Service
 * Cannabis-themed Tycoon + Idle + RPG game
 * Twitch Panel Extension + Standalone Web App
 */

import logger from '../../utils/logger.js';
import { startServer, stopServer } from './server.js';
import { startJobs, stopJobs } from './jobs/index.js';

class CertiFriedExtension {
    constructor() {
        this.isRunning = false;
        this.server = null;
    }

    /**
     * Start the extension service
     */
    async start() {
        if (this.isRunning) {
            logger.warn('[CertiFriedExtension] Service already running');
            return;
        }

        try {
            logger.info('[CertiFriedExtension] Starting service...');

            // Start Express + WebSocket server
            this.server = await startServer();

            // Start background jobs (market tick, growth tick, etc.)
            await startJobs();

            this.isRunning = true;
            logger.info('[CertiFriedExtension] Service started successfully', {
                port: process.env.CFX_PORT || 4020
            });

        } catch (error) {
            logger.error('[CertiFriedExtension] Failed to start service', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Stop the extension service
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        try {
            logger.info('[CertiFriedExtension] Stopping service...');

            // Stop background jobs
            await stopJobs();

            // Stop server
            await stopServer();

            this.isRunning = false;
            logger.info('[CertiFriedExtension] Service stopped');

        } catch (error) {
            logger.error('[CertiFriedExtension] Error during shutdown', {
                error: error.message
            });
        }
    }

    /**
     * Check if service is running
     */
    get running() {
        return this.isRunning;
    }
}

// Export singleton
export const certiFriedExtension = new CertiFriedExtension();
export default certiFriedExtension;
