"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheAllTwitchAvatars = cacheAllTwitchAvatars;
const db_1 = __importDefault(require("../utils/db"));
const twitch_api_1 = require("../utils/twitch-api");
const logger_1 = __importDefault(require("../utils/logger"));
// Helper to break an array into smaller chunks
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}
async function cacheAllTwitchAvatars() {
    logger_1.default.info("[AvatarCache] Starting Twitch avatar caching process...");
    try {
        const [twitchStreamers] = await db_1.default.execute("SELECT streamer_id, username, profile_image_url FROM streamers WHERE platform = 'twitch'");
        if (twitchStreamers.length === 0) {
            logger_1.default.info("[AvatarCache] No Twitch streamers found in the database. Skipping.");
            return;
        }
        logger_1.default.info(`[AvatarCache] Found ${twitchStreamers.length} total Twitch streamers to check.`);
        const streamerChunks = chunkArray(twitchStreamers, 100);
        const updates = []; // Array to hold { streamer_id, new_avatar_url }
        for (const chunk of streamerChunks) {
            const usernames = chunk.map(s => s.username);
            try {
                const twitchUsers = await (0, twitch_api_1.getTwitchUsers)(usernames);
                if (!twitchUsers || twitchUsers.length === 0)
                    continue;
                const twitchUserMap = new Map(twitchUsers.map(u => [u.login.toLowerCase(), u.profile_image_url]));
                for (const streamer of chunk) {
                    const newAvatarUrl = twitchUserMap.get(streamer.username.toLowerCase());
                    // Check if a new avatar URL was found and if it's different from the one in the DB
                    if (newAvatarUrl && newAvatarUrl !== streamer.profile_image_url) {
                        updates.push({ streamer_id: streamer.streamer_id, new_avatar_url: newAvatarUrl });
                    }
                }
            }
            catch (error) {
                logger_1.default.error(`[AvatarCache] Failed to process a chunk of avatars:`, { error: error instanceof Error ? error.stack : error });
            }
        }
        if (updates.length === 0) {
            logger_1.default.info("[AvatarCache] No new avatars found to update.");
            return;
        }
        logger_1.default.info(`[AvatarCache] Found ${updates.length} new avatars to update. Batching DB write...`);
        // Build a single UPDATE query with a CASE statement for efficiency
        const idsToUpdate = updates.map(u => u.streamer_id);
        let caseStatement = "CASE streamer_id ";
        const queryParams = [];
        for (const update of updates) {
            caseStatement += "WHEN ? THEN ? ";
            queryParams.push(update.streamer_id, update.new_avatar_url);
        }
        caseStatement += "END";
        queryParams.push(...idsToUpdate);
        const sql = `UPDATE streamers SET profile_image_url = ${caseStatement} WHERE streamer_id IN (?${',?'.repeat(idsToUpdate.length - 1)})`;
        const [result] = await db_1.default.execute(sql, queryParams);
        logger_1.default.info(`[AvatarCache] Finished caching avatars. Successfully updated ${result.affectedRows}/${updates.length} avatars.`);
    }
    catch (error) {
        logger_1.default.error("[AvatarCache] A critical error occurred during the avatar caching process:", { error: error instanceof Error ? error.stack : error });
    }
}
