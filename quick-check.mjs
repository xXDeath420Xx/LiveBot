import pool from './utils/db.js';
import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once('ready', async () => {
    console.log('Bot ready!');

    const CHANNEL_ID = '1437627867587547317';

    try {
        // Get guild ID
        const [guildData] = await pool.execute(
            'SELECT guild_id FROM guilds WHERE guild_id = ?',
            ['1404239197987930114']
        );

        // Fetch channel
        const channel = await client.channels.fetch(CHANNEL_ID);
        console.log(`Channel: ${channel.name}`);

        // Fetch recent messages
        const messages = await channel.messages.fetch({ limit: 50 });
        const botMessages = messages.filter(m => m.author.bot);

        console.log(`\nFound ${botMessages.size} bot messages in channel:`);
        for (const [id, msg] of botMessages) {
            console.log(`\nMessage ID: ${id}`);
            console.log(`Author: ${msg.author.tag}`);
            console.log(`Timestamp: ${msg.createdAt.toISOString()}`);
            if (msg.embeds.length > 0) {
                console.log(`Embeds: ${msg.embeds.length}`);
                msg.embeds.forEach((e, i) => {
                    console.log(`  Embed ${i+1}: ${e.title || e.description?.substring(0, 50) || e.author?.name || 'No title'}`);
                });
            }
        }

        // Check database
        const [dbAnnouncements] = await pool.execute(
            'SELECT message_id, platform, username FROM live_announcements WHERE channel_id = ?',
            [CHANNEL_ID]
        );

        console.log(`\nDatabase has ${dbAnnouncements.length} announcements:`);
        dbAnnouncements.forEach(a => {
            console.log(`  ${a.platform}/${a.username}: ${a.message_id}`);
        });

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
