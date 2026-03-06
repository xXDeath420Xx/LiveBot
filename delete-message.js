import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

async function deleteMessage() {
    try {
        await client.login(process.env.BOT_TOKEN);
        console.log('Bot logged in');

        const channelId = '1422500245304115262';
        const messageId = '1438009562551816213';

        const channel = await client.channels.fetch(channelId);
        if (channel) {
            const message = await channel.messages.fetch(messageId);
            await message.delete();
            console.log(`Deleted message ${messageId}`);
        }

        await client.destroy();
        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

deleteMessage();
