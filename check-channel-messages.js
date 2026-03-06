import pool from './utils/db.js';
import logger from './utils/logger.js';

const CHANNEL_ID = '1437627867587547317';

export async function checkChannelMessages(client) {
    try {
        logger.info('[Check Messages] Fetching channel messages...');

        // Get guild from database
        const [guildData] = await pool.execute(
            'SELECT guild_id FROM live_announcements WHERE channel_id = ? LIMIT 1',
            [CHANNEL_ID]
        );

        if (guildData.length === 0) {
            logger.error('[Check Messages] No guild found for channel');
            return;
        }

        // Get the correct client for this guild
        let targetClient = client;
        if (global.botManager) {
            targetClient = global.botManager.getClientForGuild(guildData[0].guild_id);
            if (!targetClient) {
                logger.error('[Check Messages] Could not get client for guild');
                return;
            }
        }

        const channel = await targetClient.channels.fetch(CHANNEL_ID);
        if (!channel) {
            logger.error('[Check Messages] Channel not found');
            return;
        }

        logger.info(`[Check Messages] Found channel: ${channel.name}`);

        // Fetch messages
        const messages = await channel.messages.fetch({ limit: 20 });
        logger.info(`[Check Messages] Fetched ${messages.size} messages`);

        const botMessages = messages.filter(m => m.author.bot);
        logger.info(`[Check Messages] Found ${botMessages.size} bot messages`);

        for (const [messageId, message] of botMessages) {
            const embeds = message.embeds.map(e => ({
                title: e.title,
                description: e.description?.substring(0, 100),
                author: e.author?.name,
                url: e.url
            }));

            logger.info(`[Check Messages] Message ${messageId}:`, {
                author: message.author.tag,
                embeds: embeds,
                timestamp: message.createdTimestamp
            });
        }

        // Get announcements from database
        const [dbAnnouncements] = await pool.execute(
            'SELECT message_id, platform, username FROM live_announcements WHERE channel_id = ?',
            [CHANNEL_ID]
        );

        logger.info(`[Check Messages] Database has ${dbAnnouncements.length} announcements:`, dbAnnouncements);

    } catch (error) {
        logger.error('[Check Messages] Error:', error);
    }
}
