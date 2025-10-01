const db = require('../utils/db');
const logger = require('../utils/logger');
const apiChecks = require('../utils/api_checks');
const { normalizeUsername } = require('../utils/db');

/**
 * The main function to sync Discord user IDs and link platform accounts.
 * @param {object} client The Discord client instance.
 */
async function syncDiscordUserIds(client) {
    logger.info('[UserSync] Starting comprehensive user and platform sync...');
    try {
        // --- PHASE 1: Consolidate Existing Accounts ---
        logger.info('[UserSync-P1] Consolidating all existing streamer accounts...');

        // 1a. Build a map of normalized Discord names to user IDs.
        const memberMap = new Map();
        const guilds = Array.from(client.guilds.cache.values());
        for (const guild of guilds) {
            try {
                const members = await guild.members.fetch();
                for (const member of members.values()) {
                    const normalizedUser = normalizeUsername(member.user.username);
                    if (normalizedUser && !memberMap.has(normalizedUser)) {
                        memberMap.set(normalizedUser, member.user.id);
                    }
                    const normalizedDisplay = normalizeUsername(member.displayName);
                    if (normalizedDisplay && !memberMap.has(normalizedDisplay)) {
                        memberMap.set(normalizedDisplay, member.user.id);
                    }
                }
            } catch (err) {
                logger.warn(`[UserSync-P1] Could not fetch members for guild ${guild.name}: ${err.message}`);
            }
        }
        logger.info(`[UserSync-P1] Member map built with ${memberMap.size} unique users.`);

        // 1b. Fetch ALL streamers and group them by their normalized username.
        const [allStreamers] = await db.pool.execute('SELECT streamer_id, username, platform, discord_user_id, normalized_username FROM streamers');
        const normalizedGroups = new Map();
        for (const streamer of allStreamers) {
            const normalized = streamer.normalized_username; // Use the already normalized column
            if (!normalized) continue;
            if (!normalizedGroups.has(normalized)) {
                normalizedGroups.set(normalized, []);
            }
            normalizedGroups.get(normalized).push(streamer);
        }
        logger.info(`[UserSync-P1] Grouped ${allStreamers.length} accounts into ${normalizedGroups.size} unique normalized names.`);

        // 1c. Consolidate each group and update the database.
        let totalUpdated = 0;
        for (const [normalized, group] of normalizedGroups.entries()) {
            if (group.length < 1) continue;

            let masterId = group.find(s => s.discord_user_id)?.discord_user_id || memberMap.get(normalized) || null;
            let needsUpdate = group.some(s => s.discord_user_id !== masterId);

            if (masterId && needsUpdate) {
                const idsToUpdate = group.map(s => s.streamer_id);
                const placeholders = idsToUpdate.map(() => '?').join(',');
                try {
                    const [result] = await db.pool.execute(`UPDATE streamers SET discord_user_id = ? WHERE streamer_id IN (${placeholders})`, [masterId, ...idsToUpdate]);
                    if (result.affectedRows > 0) {
                        logger.info(`[UserSync-P1] Consolidated ${result.affectedRows} account(s) for name '${normalized}' to Discord ID ${masterId}.`);
                        totalUpdated += result.affectedRows;
                    }
                } catch (dbError) {
                    logger.error(`[UserSync-P1] DB Error consolidating name '${normalized}':`, dbError);
                }
            }
        }
        logger.info(`[UserSync-P1] Consolidation complete. ${totalUpdated} accounts updated.`);

        // --- PHASE 2: Proactively Find and Add Missing Kick Accounts ---
        logger.info('[UserSync-P2] Searching for existing users missing a Kick account link...');
        const [usersMissingKick] = await db.pool.execute(`
            SELECT s.discord_user_id, s.username, s.normalized_username
            FROM streamers s
            WHERE s.discord_user_id IS NOT NULL
              AND s.platform != 'kick'
              AND NOT EXISTS (
                SELECT 1 FROM streamers s2 
                WHERE s2.discord_user_id = s.discord_user_id AND s2.platform = 'kick'
              )
            GROUP BY s.discord_user_id, s.username, s.normalized_username
        `);

        if (usersMissingKick.length === 0) {
            logger.info('[UserSync-P2] No users found requiring a retroactive Kick link.');
        } else {
            logger.info(`[UserSync-P2] Found ${usersMissingKick.length} users to check for a matching Kick account.`);

            for (const user of usersMissingKick) {
                const { discord_user_id, username, normalized_username } = user;
                if (!discord_user_id || !username || normalized_username === normalizeUsername('xxdeath420xx')) continue;

                // Check if a Kick account with the same normalized username already exists in the DB
                const [existingKickByNormalizedName] = await db.pool.execute("SELECT streamer_id FROM streamers WHERE platform = 'kick' AND normalized_username = ?", [normalized_username]);
                if (existingKickByNormalizedName.length > 0) {
                    logger.debug(`[UserSync-P2] Kick account for normalized username '${normalized_username}' already exists in DB. Ensuring Discord ID is linked.`);
                    // Ensure the existing Kick account has the correct Discord ID
                    await db.pool.execute(
                        `UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ? AND (discord_user_id IS NULL OR discord_user_id != ?)`,
                        [discord_user_id, existingKickByNormalizedName[0].streamer_id, discord_user_id]
                    );
                    continue;
                }

                try {
                    const kickUser = await apiChecks.getKickUser(username);
                    if (kickUser && kickUser.user) {
                        logger.info(`[UserSync-P2] Found and linking missing Kick account for ${username}: ${kickUser.user.username}`);
                        await db.pool.execute(
                            `INSERT INTO streamers (platform, platform_user_id, username, normalized_username, profile_image_url, discord_user_id) VALUES (?, ?, ?, ?, ?, ?) 
                             ON DUPLICATE KEY UPDATE 
                                username=VALUES(username), 
                                normalized_username=VALUES(normalized_username),
                                profile_image_url=VALUES(profile_image_url),
                                discord_user_id=COALESCE(streamers.discord_user_id, VALUES(discord_user_id))`,
                            ['kick', kickUser.id.toString(), kickUser.user.username, normalizeUsername(kickUser.user.username), kickUser.user.profile_pic || null, discord_user_id]
                        );
                    }
                } catch (kickError) {
                    logger.warn(`[UserSync-P2] Error checking Kick for username ${username}: ${kickError.message}`);
                }
            }
        }

        logger.info('[UserSync] Finished comprehensive user and platform sync.');

    } catch (error) {
        logger.error('[UserSync] CRITICAL ERROR during comprehensive sync:', { error: error.stack });
    }
}

module.exports = { syncDiscordUserIds };