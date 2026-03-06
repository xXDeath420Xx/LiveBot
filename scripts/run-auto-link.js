import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
import { autoLinkAllDiscordIds } from './auto-link-discord-ids.js';
import logger from '../utils/logger.js';

dotenv.config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

client.once('ready', async () => {
    logger.info('[Auto-Link Runner] Bot is ready, starting auto-link process...', { category: 'auto-link' });

    try {
        const result = await autoLinkAllDiscordIds(client);
        logger.info('[Auto-Link Runner] Process completed:', result, { category: 'auto-link' });

        // Give it a moment to log, then exit
        setTimeout(() => {
            logger.info('[Auto-Link Runner] Exiting...', { category: 'auto-link' });
            process.exit(0);
        }, 2000);
    } catch (error) {
        logger.error('[Auto-Link Runner] Fatal error:', { error, category: 'auto-link' });
        process.exit(1);
    }
});

logger.info('[Auto-Link Runner] Logging in...', { category: 'auto-link' });
client.login(process.env.DISCORD_TOKEN);
