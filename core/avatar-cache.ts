import db from '../utils/db';
import { getTwitchUsers } from '../utils/twitch-api';
import logger from '../utils/logger';
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';

interface TwitchStreamer extends RowDataPacket {
    streamer_id: number;
    username: string;
    profile_image_url: string;
}

interface TwitchUserInfo {
    login: string;
    profile_image_url: string;
    id?: string;
    display_name?: string;
}

interface AvatarUpdate {
    streamer_id: number;
    new_avatar_url: string;
}

// Helper to break an array into smaller chunks
function chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

export async function cacheAllTwitchAvatars(): Promise<void> {
    logger.info("[AvatarCache] Starting Twitch avatar caching process...");
    try {
        const [twitchStreamers] = await db.execute<TwitchStreamer[]>(
            "SELECT streamer_id, username, profile_image_url FROM streamers WHERE platform = 'twitch'"
        );
        if (twitchStreamers.length === 0) {
            logger.info("[AvatarCache] No Twitch streamers found in the database. Skipping.");
            return;
        }

        logger.info(`[AvatarCache] Found ${twitchStreamers.length} total Twitch streamers to check.`);

        const streamerChunks = chunkArray(twitchStreamers, 100);
        const updates: AvatarUpdate[] = []; // Array to hold { streamer_id, new_avatar_url }

        for (const chunk of streamerChunks) {
            const usernames = chunk.map(s => s.username);
            try {
                const twitchUsers: TwitchUserInfo[] = await getTwitchUsers(usernames);
                if (!twitchUsers || twitchUsers.length === 0) continue;

                const twitchUserMap = new Map(twitchUsers.map(u => [u.login.toLowerCase(), u.profile_image_url]));

                for (const streamer of chunk) {
                    const newAvatarUrl = twitchUserMap.get(streamer.username.toLowerCase());
                    // Check if a new avatar URL was found and if it's different from the one in the DB
                    if (newAvatarUrl && newAvatarUrl !== streamer.profile_image_url) {
                        updates.push({ streamer_id: streamer.streamer_id, new_avatar_url: newAvatarUrl });
                    }
                }
            } catch (error: unknown) {
                logger.error(`[AvatarCache] Failed to process a chunk of avatars:`, { error: error instanceof Error ? error.stack : error });
            }
        }

        if (updates.length === 0) {
            logger.info("[AvatarCache] No new avatars found to update.");
            return;
        }

        logger.info(`[AvatarCache] Found ${updates.length} new avatars to update. Batching DB write...`);

        // Build a single UPDATE query with a CASE statement for efficiency
        const idsToUpdate = updates.map(u => u.streamer_id);
        let caseStatement = "CASE streamer_id ";
        const queryParams: (number | string)[] = [];

        for (const update of updates) {
            caseStatement += "WHEN ? THEN ? ";
            queryParams.push(update.streamer_id, update.new_avatar_url);
        }

        caseStatement += "END";
        queryParams.push(...idsToUpdate);

        const sql = `UPDATE streamers SET profile_image_url = ${caseStatement} WHERE streamer_id IN (?${',?'.repeat(idsToUpdate.length - 1)})`;

        const [result] = await db.execute<ResultSetHeader>(sql, queryParams);

        logger.info(`[AvatarCache] Finished caching avatars. Successfully updated ${result.affectedRows}/${updates.length} avatars.`);

    } catch (error: unknown) {
        logger.error("[AvatarCache] A critical error occurred during the avatar caching process:", { error: error instanceof Error ? error.stack : error });
    }
}
