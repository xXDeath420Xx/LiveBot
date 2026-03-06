import pool from './utils/db.js';
import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const CHANNEL_ID = '1422500245304115262';
const DUPLICATE_MESSAGE_ID = '1439646974327652584';

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.once('ready', async () => {
    console.log('Bot ready! Deleting duplicate...');

    try {
        // Get guild from database
        const [guildData] = await pool.execute(
            'SELECT guild_id FROM live_announcements WHERE channel_id = ? LIMIT 1',
            [CHANNEL_ID]
        );

        if (guildData.length === 0) {
            console.error('No guild found for channel');
            await pool.end();
            client.destroy();
            process.exit(1);
            return;
        }

        // Get the correct client for this guild
        let targetClient = client;
        if (global.botManager) {
            targetClient = global.botManager.getClientForGuild(guildData[0].guild_id);
            if (!targetClient) {
                console.error('Could not get client for guild');
                await pool.end();
                client.destroy();
                process.exit(1);
                return;
            }
        }

        const channel = await targetClient.channels.fetch(CHANNEL_ID);
        if (!channel) {
            console.error('Channel not found');
            await pool.end();
            client.destroy();
            process.exit(1);
            return;
        }

        console.log(`Found channel: ${channel.name}`);

        // Delete the duplicate message
        const message = await channel.messages.fetch(DUPLICATE_MESSAGE_ID);
        await message.delete();
        console.log(`Deleted duplicate message ${DUPLICATE_MESSAGE_ID}`);

        await pool.end();
        client.destroy();
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        await pool.end();
        client.destroy();
        process.exit(1);
    }
});

client.login(process.env.DISCORD_TOKEN);
