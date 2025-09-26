const db = require("../utils/db");
const apiChecks = require("../utils/api_checks");
const logger = require("../utils/logger");

async function cacheAllTwitchAvatars() {
    logger.info("[AvatarCache] Starting Twitch avatar caching process...");
    try {
        const [twitchStreamers] = await db.execute("SELECT streamer_id, username FROM streamers WHERE platform = 'twitch'");
        if (twitchStreamers.length === 0) {
            logger.info("[AvatarCache] No Twitch streamers found in the database. Skipping.");
            return;
        }

        logger.info(`[AvatarCache] Found ${twitchStreamers.length} Twitch streamers to update.`);

        let updatedCount = 0;
        for (const streamer of twitchStreamers) {
            try {
                const twitchUser = await apiChecks.getTwitchUser(streamer.username);
                if (twitchUser && twitchUser.profile_image_url) {
                    await db.execute("UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?", [twitchUser.profile_image_url, streamer.streamer_id]);
                    updatedCount++;
                }
            } catch (error) {
                logger.error(`[AvatarCache] Failed to update avatar for ${streamer.username}:`, error);
            }
        }

        logger.info(`[AvatarCache] Finished caching avatars. Successfully updated ${updatedCount}/${twitchStreamers.length} avatars.`);
    } catch (error) {
        logger.error("[AvatarCache] A critical error occurred during the avatar caching process:", error);
    }
}

module.exports = { cacheAllTwitchAvatars };
