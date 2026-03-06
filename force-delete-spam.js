import pool from './utils/db.js';
import logger from './utils/logger.js';

const CHANNEL_ID = '1437627867587547317';
const MIN_MESSAGE_ID = '1439635695064059944';
const MAX_MESSAGE_ID = '1439636881913544704';

export async function forceDeleteSpam(client) {
    try {
        logger.info('[Force Delete] Starting forced spam deletion...');

        // Get guild from database
        const [guildData] = await pool.execute(
            'SELECT guild_id FROM live_announcements WHERE channel_id = ? LIMIT 1',
            [CHANNEL_ID]
        );

        if (guildData.length === 0) {
            logger.error('[Force Delete] No guild found for channel');
            return;
        }

        // Get the correct client for this guild
        let targetClient = client;
        if (global.botManager) {
            targetClient = global.botManager.getClientForGuild(guildData[0].guild_id);
            if (!targetClient) {
                logger.error('[Force Delete] Could not get client for guild');
                return;
            }
        }

        logger.info(`[Force Delete] Using client for guild ${guildData[0].guild_id}`);

        const channel = await targetClient.channels.fetch(CHANNEL_ID);
        if (!channel) {
            logger.error('[Force Delete] Channel not found');
            return;
        }

        logger.info(`[Force Delete] Found channel: ${channel.name}`);

        // Fetch messages
        const messages = await channel.messages.fetch({ limit: 100 });
        logger.info(`[Force Delete] Fetched ${messages.size} messages`);

        let deletedCount = 0;

        for (const [messageId, message] of messages) {
            // Delete if message is:
            // 1. From a bot
            // 2. Within the ID range OR has stream-related embeds
            const inRange = messageId >= MIN_MESSAGE_ID && messageId <= MAX_MESSAGE_ID;
            const isBot = message.author.bot;
            const hasEmbed = message.embeds.length > 0;

            if (isBot && (inRange || hasEmbed)) {
                try {
                    logger.info(`[Force Delete] Deleting message ${messageId}`);
                    await message.delete();
                    deletedCount++;
                    await new Promise(resolve => setTimeout(resolve, 300));
                } catch (error) {
                    logger.error(`[Force Delete] Failed to delete ${messageId}: ${error.message}`);
                }
            }
        }

        logger.info(`[Force Delete] Deleted ${deletedCount} messages`);
    } catch (error) {
        logger.error('[Force Delete] Error:', error);
    }
}
