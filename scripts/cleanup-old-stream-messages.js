import botManager from '../core/bot-manager.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

/**
 * Clean up old stream announcement messages from channels after bot switch
 * This removes webhook messages posted by the old bot before custom bots took over
 */

// Guild assignments with their switch times
const GUILDS_TO_CLEAN = [
    {
        guildId: '985116833193553930',
        channelId: '1415373602068496545',
        botId: '1438889625388060723', // ReeferRealm Utility
        switchedAt: new Date('2025-11-14T13:55:38Z') // assigned_at from guild_bot_mapping
    },
    {
        guildId: '844406178799943730',
        channelId: '1414766370217787573',
        botId: '1438897897289552054', // DabFam Utility
        switchedAt: new Date('2025-11-14T14:28:19Z')
    }
];

async function cleanupOldMessages() {
    try {
        logger.info('[Cleanup] Starting cleanup of old stream messages');

        // Initialize default bot to access channels
        const defaultBot = await botManager.initializeDefaultBot(process.env.DISCORD_TOKEN);

        // Load custom bots from database
        logger.info('[Cleanup] Loading custom bots from database...');
        const [customBots] = await pool.execute(
            'SELECT * FROM custom_bots WHERE enabled = 1'
        );

        for (const botConfig of customBots) {
            try {
                // Get guild mappings for this bot
                const [mappings] = await pool.execute(
                    'SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?',
                    [botConfig.bot_id]
                );

                const guildIds = mappings.map(m => m.guild_id);

                if (guildIds.length > 0) {
                    await botManager.addCustomBot({
                        bot_id: botConfig.bot_id,
                        bot_token: JSON.parse(botConfig.bot_token),
                        guild_ids: guildIds
                    });
                    logger.info(`[Cleanup] Loaded custom bot ${botConfig.bot_id} for ${guildIds.length} guild(s)`);
                }
            } catch (error) {
                logger.error(`[Cleanup] Failed to load custom bot ${botConfig.bot_id}:`, error);
            }
        }

        let totalDeleted = 0;

        for (const config of GUILDS_TO_CLEAN) {
            logger.info(`[Cleanup] Processing guild ${config.guildId}, channel ${config.channelId}`);

            // Use the custom bot for this guild
            const botClient = botManager.getClient(config.botId);
            if (!botClient) {
                logger.error(`[Cleanup] Bot ${config.botId} not found, skipping guild ${config.guildId}`);
                continue;
            }

            // Get the channel
            const channel = await botClient.channels.fetch(config.channelId).catch(() => null);
            if (!channel || !channel.isTextBased()) {
                logger.error(`[Cleanup] Channel ${config.channelId} not found or not text-based`);
                continue;
            }

            logger.info(`[Cleanup] Fetching messages from channel #${channel.name}`);

            // Fetch messages (Discord allows fetching up to 100 at a time)
            let deletedCount = 0;
            let lastMessageId = null;
            let hasMore = true;

            while (hasMore) {
                const options = { limit: 100 };
                if (lastMessageId) {
                    options.before = lastMessageId;
                }

                const messages = await channel.messages.fetch(options);

                if (messages.size === 0) {
                    hasMore = false;
                    break;
                }

                logger.info(`[Cleanup] Fetched ${messages.size} messages, checking for old announcements`);

                for (const [messageId, message] of messages) {
                    // Check if message is older than the switch time
                    if (message.createdAt < config.switchedAt) {
                        // Check if it's a webhook message or from a bot
                        if (message.webhookId || message.author.bot) {
                            // Check if it has an embed (stream announcements have embeds)
                            if (message.embeds.length > 0) {
                                try {
                                    await message.delete();
                                    deletedCount++;
                                    logger.info(`[Cleanup] Deleted old message ${messageId} from ${message.createdAt.toISOString()}`);

                                    // Rate limit: wait 1 second between deletes
                                    await new Promise(resolve => setTimeout(resolve, 1000));
                                } catch (error) {
                                    logger.error(`[Cleanup] Failed to delete message ${messageId}:`, error.message);
                                }
                            }
                        }
                    }

                    lastMessageId = messageId;
                }

                // If we fetched less than 100, we've reached the end
                if (messages.size < 100) {
                    hasMore = false;
                }

                // Safety: stop if we've gone back more than 7 days
                const oldestMessage = messages.last();
                if (oldestMessage && (Date.now() - oldestMessage.createdTimestamp) > 7 * 24 * 60 * 60 * 1000) {
                    logger.info('[Cleanup] Reached messages older than 7 days, stopping');
                    hasMore = false;
                }
            }

            logger.info(`[Cleanup] Deleted ${deletedCount} old messages from guild ${config.guildId}`);
            totalDeleted += deletedCount;
        }

        logger.info(`[Cleanup] Cleanup complete. Total messages deleted: ${totalDeleted}`);
        process.exit(0);

    } catch (error) {
        logger.error('[Cleanup] Error during cleanup:', error);
        process.exit(1);
    }
}

// Run the cleanup
cleanupOldMessages();
