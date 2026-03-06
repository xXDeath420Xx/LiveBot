import pool from './utils/db.js';
import logger from './utils/logger.js';

const CHANNEL_ID = '1437627867587547317';
const DUPLICATES = [
    '1439648489943466076', // Twitch duplicate
    '1439648500122910740'  // Kick duplicate
];

async function deleteMessages() {
    try {
        // Get guild
        const [guildData] = await pool.execute(
            'SELECT guild_id FROM guilds WHERE guild_id = ?',
            ['1404239197987930114']
        );

        if (guildData.length === 0) {
            console.error('Guild not found');
            return;
        }

        // Import botManager to get correct client
        const { default: botManager } = await import('./core/botManager.js');
        const targetClient = botManager.getClientForGuild(guildData[0].guild_id);

        if (!targetClient) {
            console.error('Could not get bot client for guild');
            return;
        }

        const channel = await targetClient.channels.fetch(CHANNEL_ID);
        if (!channel) {
            console.error('Channel not found');
            return;
        }

        console.log(`Found channel: ${channel.name}`);

        for (const messageId of DUPLICATES) {
            try {
                const message = await channel.messages.fetch(messageId);
                await message.delete();
                console.log(`Deleted duplicate message ${messageId}`);
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                console.error(`Failed to delete ${messageId}:`, error.message);
            }
        }

        console.log('Done!');
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

// Give bot time to initialize
setTimeout(deleteMessages, 5000);
