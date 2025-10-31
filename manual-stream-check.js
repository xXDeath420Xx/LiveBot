/**
 * Manual Stream Check - Tests the real-time stream checking system
 */

const { Client, GatewayIntentBits } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

async function main() {
    console.log('Initializing Discord client...');

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
        ]
    });

    await client.login(process.env.DISCORD_TOKEN);
    console.log('Discord client connected!');

    // Import the stream manager
    const { checkStreamers } = require('./dist/core/stream-manager.js');

    console.log('\n=== STARTING STREAM CHECK ===');
    console.log('Time started:', new Date().toISOString());

    const startTime = Date.now();

    try {
        await checkStreamers(client);
        const duration = Date.now() - startTime;

        console.log('\n=== STREAM CHECK COMPLETE ===');
        console.log('Duration:', duration + 'ms', '(' + (duration / 1000).toFixed(2) + 's)');
        console.log('Time completed:', new Date().toISOString());

        if (duration < 60000) {
            console.log('✓ Stream check completed within 1 minute');
        } else if (duration < 120000) {
            console.log('⚠ Stream check took over 1 minute');
        } else {
            console.log('✗ Stream check took over 2 minutes - optimization needed');
        }

    } catch (error) {
        console.error('Error during stream check:', error);
    }

    client.destroy();
    process.exit(0);
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
