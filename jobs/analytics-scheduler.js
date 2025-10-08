const path = require("path");
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client, GatewayIntentBits } = require("discord.js");
const db = require('../utils/db');
const logger = require('../utils/logger');
const { checkStatroles } = require('../core/statrole-manager');
const { updateStatdocks } = require('../core/statdock-manager');

// A lightweight client just for these tasks
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

async function runJobs() {
    logger.init(client, db);
    await client.login(process.env.DISCORD_TOKEN);
    logger.info('[AnalyticsScheduler] Logged in and ready to run jobs.');

    try {
        await checkStatroles(client);
        await updateStatdocks(client);
    } catch (e) {
        logger.error('[AnalyticsScheduler] A critical error occurred during job execution:', e);
    } finally {
        logger.info('[AnalyticsScheduler] Jobs complete. Shutting down.');
        await client.destroy();
        await db.end(); // Ensure db connection is closed
        process.exit(0);
    }
}

runJobs();
