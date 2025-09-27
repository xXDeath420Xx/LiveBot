const db = require('../utils/db');
const logger = require('../utils/logger');

async function syncDiscordUserIds(client) {
    logger.info('[UserSync] Starting Discord user ID sync...');
    try {
        // Step 1: Fetch all members from all guilds and create a lookup map.
        logger.info('[UserSync] Building member map from all guilds...');
        const memberMap = new Map();
        const guilds = Array.from(client.guilds.cache.values());
        for (const guild of guilds) {
            try {
                const members = await guild.members.fetch();
                for (const member of members.values()) {
                    const usernameLower = member.user.username.toLowerCase();
                    if (!memberMap.has(usernameLower)) {
                        memberMap.set(usernameLower, member.user.id);
                    }
                }
            } catch (err) {
                logger.warn(`[UserSync] Could not fetch members for guild ${guild.name} (${guild.id}): ${err.message}`);
            }
        }
        logger.info(`[UserSync] Member map built with ${memberMap.size} unique users.`);

        // Step 2: Get all unique streamer usernames from DB that need a sync.
        const [streamersToSync] = await db.execute('SELECT DISTINCT LOWER(username) AS username FROM streamers WHERE discord_user_id IS NULL');

        if (streamersToSync.length === 0) {
            logger.info('[UserSync] No streamers found needing a Discord ID sync.');
            return;
        }
        logger.info(`[UserSync] Found ${streamersToSync.length} unique streamer usernames to sync.`);

        // Step 3: Find matches and group them by Discord ID for batch updating.
        const updates = new Map(); // Map<discord_id, username_lowercase[]>
        for (const streamer of streamersToSync) {
            const discordId = memberMap.get(streamer.username);
            if (discordId) {
                if (!updates.has(discordId)) {
                    updates.set(discordId, []);
                }
                updates.get(discordId).push(streamer.username);
            }
        }

        if (updates.size === 0) {
            logger.info('[UserSync] No matching Discord users found for streamers needing a sync.');
            return;
        }

        // Step 4: Execute the batched updates.
        let totalUpdatedCount = 0;
        logger.info(`[UserSync] Found matches for ${updates.size} Discord user(s). Preparing to update DB.`);

        for (const [discordId, usernames] of updates.entries()) {
            const placeholders = usernames.map(() => '?').join(',');
            try {
                const [updateResult] = await db.execute(
                    `UPDATE streamers SET discord_user_id = ? WHERE LOWER(username) IN (${placeholders}) AND discord_user_id IS NULL`,
                    [discordId, ...usernames]
                );

                if (updateResult.affectedRows > 0) {
                    logger.info(`[UserSync] Updated ${updateResult.affectedRows} streamer account(s) for Discord ID ${discordId} (Usernames: ${usernames.join(', ')}).`);
                    totalUpdatedCount += updateResult.affectedRows;
                }
            } catch (dbError) {
                logger.error(`[UserSync] Failed to update DB for Discord ID ${discordId}:`, dbError);
            }
        }

        logger.info(`[UserSync] Finished Discord user ID sync. Updated a total of ${totalUpdatedCount} account(s).`);

    } catch (error) {
        logger.error('[UserSync] CRITICAL ERROR during Discord user ID sync:', error);
    }
}

module.exports = { syncDiscordUserIds };