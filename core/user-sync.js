const db = require('../utils/db');
const logger = require('../utils/logger');

async function syncDiscordUserIds(client) {
    logger.info('[UserSync] Starting Discord user ID sync...');
    try {
        const [streamersToSync] = await db.execute('SELECT DISTINCT username FROM streamers WHERE discord_user_id IS NULL');

        if (streamersToSync.length === 0) {
            logger.info('[UserSync] No streamers found needing a Discord ID sync.');
            return;
        }

        const usernamesToSync = new Set(streamersToSync.map(s => s.username.toLowerCase()));
        logger.info(`[UserSync] Found ${usernamesToSync.size} unique usernames to check.`);

        let updatedCount = 0;

        for (const guild of client.guilds.cache.values()) {
            const members = await guild.members.fetch();
            
            for (const member of members.values()) {
                const discordUsername = member.user.username.toLowerCase();
                if (usernamesToSync.has(discordUsername)) {
                    logger.info(`[UserSync] Found match: ${discordUsername} (Discord ID: ${member.user.id})`);

                    const [accountsToUpdate] = await db.execute('SELECT streamer_id FROM streamers WHERE LOWER(username) = ? AND discord_user_id IS NULL', [discordUsername]);

                    if (accountsToUpdate.length > 0) {
                        const streamerIds = accountsToUpdate.map(s => s.streamer_id);
                        const placeholders = streamerIds.map(() => '?').join(',');
                        
                        const [updateResult] = await db.execute(
                            `UPDATE streamers SET discord_user_id = ? WHERE streamer_id IN (${placeholders})`,
                            [member.user.id, ...streamerIds]
                        );

                        if (updateResult.affectedRows > 0) {
                            logger.info(`[UserSync] Updated ${updateResult.affectedRows} streamer account(s) for ${discordUsername} with Discord ID ${member.user.id}.`);
                            updatedCount += updateResult.affectedRows;
                            usernamesToSync.delete(discordUsername);
                        }
                    }
                }
            }
        }
        logger.info(`[UserSync] Finished Discord user ID sync. Updated ${updatedCount} account(s).`);

    } catch (error) {
        logger.error('[UserSync] CRITICAL ERROR during Discord user ID sync:', error);
    }
}

module.exports = { syncDiscordUserIds };
