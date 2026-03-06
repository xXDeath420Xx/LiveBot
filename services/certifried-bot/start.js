#!/usr/bin/env node
/**
 * CertiFriedUtility Bot Startup Script
 * Run this to start the bot services
 */

import { certiFriedBot } from './index.js';
import logger from '../../utils/logger.js';

async function main() {
    console.log('=====================================');
    console.log('  CertiFriedUtility - Cannabis Bot');
    console.log('=====================================');
    console.log();

    try {
        await certiFriedBot.start();

        console.log();
        console.log('Bot is now running!');
        console.log('Press Ctrl+C to stop.');
        console.log();

        // Keep process alive
        process.stdin.resume();

    } catch (error) {
        logger.error('[CertiFriedUtility] Failed to start', { error: error.message });
        console.error('Failed to start bot:', error.message);
        process.exit(1);
    }
}

main();
