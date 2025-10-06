
const db = require('../utils/db');
const logger = require('../utils/logger');

// This function will be called by a scheduled job
async function collectServerStats() {
    if (!global.client) return;
    
    logger.info('[StatsManager] Starting daily server stats collection...');

    try {
        const guilds = global.client.guilds.cache;
        for (const [guildId, guild] of guilds) {
            try {
                // Fetch members to get accurate presence data
                await guild.members.fetch();
                
                const totalMembers = guild.memberCount;
                const onlineMembers = guild.members.cache.filter(member => member.presence?.status === 'online' || member.presence?.status === 'dnd').size;
                
                // For message count, we'll reset it daily. This is a simplified approach.
                // A more robust system might track this in memory or a faster DB like Redis.
                // For now, we assume this function runs once a day. The count itself would be incremented elsewhere.
                // Let's create a placeholder for today's message count.
                const messageCount = 0; // In a real system, you'd fetch this from a temporary store.

                const today = new Date().toISOString().slice(0, 10);

                await db.execute(
                    `INSERT INTO server_stats (guild_id, date, total_members, online_members, message_count) 
                     VALUES (?, ?, ?, ?, ?) 
                     ON DUPLICATE KEY UPDATE 
                        total_members = VALUES(total_members), 
                        online_members = VALUES(online_members),
                        message_count = message_count + VALUES(message_count)`,
                    [guildId, today, totalMembers, onlineMembers, messageCount]
                );
            } catch (guildError) {
                logger.error(`[StatsManager] Failed to collect stats for guild ${guildId}:`, guildError);
            }
        }
        logger.info(`[StatsManager] Finished collecting stats for ${guilds.size} guilds.`);
    } catch (error) {
        logger.error('[StatsManager] A critical error occurred during stats collection:', error);
    }
}

// We also need a function to increment the message count throughout the day
async function incrementMessageCount(guildId) {
    try {
        const today = new Date().toISOString().slice(0, 10);
        // This is an "upsert" that increments the count or creates the row if it doesn't exist.
        await db.execute(
            `INSERT INTO server_stats (guild_id, date, message_count) 
             VALUES (?, ?, 1) 
             ON DUPLICATE KEY UPDATE message_count = message_count + 1`,
            [guildId, today]
        );
    } catch (error) {
        logger.error(`[StatsManager] Failed to increment message count for guild ${guildId}:`, error);
    }
}


module.exports = { collectServerStats, incrementMessageCount };
