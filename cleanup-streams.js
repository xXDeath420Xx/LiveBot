import { Client, GatewayIntentBits } from 'discord.js';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'LiveHostBot2025',
    database: 'CertiFriedUtility',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function cleanup() {
    try {
        await client.login(process.env.BOT_TOKEN);
        console.log('Bot logged in');

        // Get all live announcements
        const [announcements] = await pool.query(
            'SELECT message_id, channel_id, username, platform FROM live_announcements WHERE guild_id = ?',
            ['1342779579168981065']
        );

        console.log(`Found ${announcements.length} announcements to clean up`);

        for (const ann of announcements) {
            try {
                const channel = await client.channels.fetch(ann.channel_id);
                if (channel) {
                    const message = await channel.messages.fetch(ann.message_id);
                    await message.delete();
                    console.log(`Deleted message for ${ann.username} on ${ann.platform}`);
                }
            } catch (error) {
                console.error(`Failed to delete message ${ann.message_id}:`, error.message);
            }
        }

        // Clean up database
        await pool.query('DELETE FROM live_announcements WHERE guild_id = ?', ['1342779579168981065']);
        console.log('Database cleaned up');

        await client.destroy();
        await pool.end();
        process.exit(0);
    } catch (error) {
        console.error('Cleanup error:', error);
        process.exit(1);
    }
}

cleanup();
