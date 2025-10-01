// B:/Code/LiveBot/core/team-sync.js - Updated on 2025-10-01 - Unique Identifier: TEAM-SYNC-FINAL-003
const { isBlacklisted } = require("./blacklist-manager");
const apiChecks = require("../utils/api_checks");

function normalizeUsername(username) {
    return username ? String(username).toLowerCase() : null;
}

async function syncTwitchTeam(teamId, db, logger) {
    if (!teamId) return { success: false, message: "No team ID provided." };

    logger.info(`[TeamSync] Starting sync for team ID: ${teamId}`);

    try {
        const [teams] = await db.execute("SELECT * FROM twitch_teams WHERE id = ?", [teamId]);
        const team = teams[0];

        if (!team) {
            logger.warn(`[TeamSync] Team with ID ${teamId} not found in database.`);
            return { success: false, message: "Team not found." };
        }

        const twitchTeamName = team.team_name;
        logger.info(`[TeamSync] Syncing Twitch team: ${twitchTeamName}`);

        const twitchMembers = await apiChecks.getTwitchTeamMembers(twitchTeamName);
        if (!twitchMembers) {
            logger.error(`[TeamSync] Failed to fetch members for Twitch team: ${twitchTeamName}`);
            return { success: false, message: `Failed to fetch Twitch team members for ${twitchTeamName}.` };
        }
        const twitchUsernames = new Set(twitchMembers.map(m => m.user_login.toLowerCase()));
        logger.info(`[TeamSync] Found ${twitchUsernames.size} members in Twitch team '${twitchTeamName}'.`);

        const [dbTeamStreamers] = await db.execute(`
            SELECT s.streamer_id, s.username
            FROM subscriptions sub
                     JOIN streamers s ON sub.streamer_id = s.streamer_id
            WHERE sub.team_subscription_id = ? AND s.platform = 'twitch'
        `, [teamId]);
        const dbUsernames = new Set(dbTeamStreamers.map(s => s.username.toLowerCase()));
        logger.info(`[TeamSync] Found ${dbUsernames.size} Twitch members in DB for team ID ${teamId}.`);

        const usersToAdd = [...twitchUsernames].filter(u => !dbUsernames.has(u));
        const usersToRemove = [...dbUsernames].filter(u => !twitchUsernames.has(u));

        logger.info(`[TeamSync] Users to add: ${usersToAdd.length}, Users to remove: ${usersToRemove.length}`);

        if (usersToRemove.length > 0) {
            const streamerIdsToRemove = dbTeamStreamers.filter(s => usersToRemove.includes(s.username.toLowerCase())).map(s => s.streamer_id);
            if (streamerIdsToRemove.length > 0) {
                const placeholders = streamerIdsToRemove.map(() => '?').join(',');
                await db.execute(`DELETE FROM subscriptions WHERE team_subscription_id = ? AND streamer_id IN (${placeholders})`, [teamId, ...streamerIdsToRemove]);
                logger.info(`[TeamSync] Removed ${streamerIdsToRemove.length} users from team subscription.`);
            }
        }

        for (const twitchUsername of usersToAdd) {
            const twitchMember = twitchMembers.find(m => m.user_login.toLowerCase() === twitchUsername);
            if (!twitchMember) continue;

            if (await isBlacklisted('twitch', twitchMember.user_id)) {
                logger.warn(`[TeamSync] Skipping blacklisted user found in team '${twitchTeamName}': ${twitchUsername}`);
                continue;
            }

            const [existingAccounts] = await db.execute(`SELECT discord_user_id FROM streamers WHERE username = ?`, [twitchMember.user_login]);
            const canonicalDiscordId = existingAccounts.find(a => a.discord_user_id)?.discord_user_id || null;

            await db.execute(
                `INSERT INTO streamers (platform, platform_user_id, username, normalized_username, profile_image_url, discord_user_id) VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                                      username=VALUES(username),
                                      normalized_username=VALUES(normalized_username),
                                      profile_image_url=VALUES(profile_image_url),
                                      discord_user_id=COALESCE(streamers.discord_user_id, VALUES(discord_user_id))`,
                ['twitch', twitchMember.user_id, twitchMember.user_login, normalizeUsername(twitchMember.user_login), twitchMember.profile_image_url || null, canonicalDiscordId]
            );
            const [twitchStreamerRows] = await db.execute("SELECT streamer_id, discord_user_id FROM streamers WHERE platform = 'twitch' AND platform_user_id = ?", [twitchMember.user_id]);
            const twitchStreamer = twitchStreamerRows[0];

            if (!twitchStreamer) {
                logger.warn(`[TeamSync] Could not find or create streamer entry for Twitch user ${twitchUsername}.`);
                continue;
            }

            await db.execute(
                `INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id, team_subscription_id) VALUES (?, ?, ?, ?)`,
                [team.guild_id, twitchStreamer.streamer_id, team.announcement_channel_id, teamId]
            );
            logger.info(`[TeamSync] Added Twitch user ${twitchUsername} to team subscription.`);
        }

        logger.info(`[TeamSync] Starting retroactive Kick account check for all ${twitchMembers.length} team members...`);

        for (const twitchMember of twitchMembers) {
            const twitchLogin = twitchMember.user_login;
            const twitchDisplayName = twitchMember.user_name;

            if (twitchLogin.toLowerCase() === 'xxdeath420xx') continue;

            const [existingTwitchRows] = await db.execute("SELECT streamer_id, discord_user_id, kick_username FROM streamers WHERE platform = 'twitch' AND platform_user_id = ?", [twitchMember.user_id]);
            const existingTwitch = existingTwitchRows[0];

            if (!existingTwitch) {
                logger.debug(`[TeamSync] No existing Twitch streamer entry found for ${twitchLogin}. Skipping Kick link attempt.`);
                continue;
            }

            let kickUser = null;
            let foundKickUsername = null;

            // Strategy 1: Try with the stored kick_username
            if (existingTwitch.kick_username) {
                try {
                    logger.debug(`[TeamSync] Attempting Kick API call with stored kick_username: ${existingTwitch.kick_username}`);
                    kickUser = await apiChecks.getKickUser(existingTwitch.kick_username);
                    if (kickUser && kickUser.user) foundKickUsername = kickUser.user.username;
                } catch (e) {
                    logger.warn(`[TeamSync] Stored kick_username "${existingTwitch.kick_username}" failed for ${twitchLogin}: ${e.message}`);
                }
            }

            // Strategy 2: If not found, try with the Twitch display name (often preserves case)
            if (!foundKickUsername) {
                try {
                    logger.debug(`[TeamSync] Attempting Kick API call with twitchDisplayName: ${twitchDisplayName}`);
                    kickUser = await apiChecks.getKickUser(twitchDisplayName);
                    if (kickUser && kickUser.user) foundKickUsername = kickUser.user.username;
                } catch (e) {
                    logger.warn(`[TeamSync] Twitch display name "${twitchDisplayName}" failed for Kick API: ${e.message}`);
                }
            }

            // Strategy 3: If still not found, try with the Twitch login name (lowercase)
            if (!foundKickUsername) {
                try {
                    logger.debug(`[TeamSync] Attempting Kick API call with twitchUsername (login): ${twitchLogin}`);
                    kickUser = await apiChecks.getKickUser(twitchLogin);
                    if (kickUser && kickUser.user) foundKickUsername = kickUser.user.username;
                } catch (e) {
                    logger.warn(`[TeamSync] Twitch username (login) "${twitchLogin}" failed for Kick API: ${e.message}`);
                }
            }

            if (foundKickUsername) {
                logger.info(`[TeamSync] Found Kick account for Twitch streamer ${twitchLogin}: ${foundKickUsername}`);

                await db.execute(`UPDATE streamers SET kick_username = ? WHERE streamer_id = ?`, [foundKickUsername, existingTwitch.streamer_id]);
                logger.info(`[TeamSync] Updated kick_username for Twitch streamer ${twitchLogin} (ID: ${existingTwitch.streamer_id}) to ${foundKickUsername}.`);

                await db.execute(
                    `INSERT INTO streamers (platform, platform_user_id, username, normalized_username, profile_image_url, discord_user_id, kick_username) VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE username=VALUES(username), normalized_username=VALUES(normalized_username), profile_image_url=VALUES(profile_image_url), discord_user_id=COALESCE(streamers.discord_user_id, VALUES(discord_user_id)), kick_username=VALUES(kick_username)`,
                    ['kick', kickUser.id.toString(), kickUser.user.username, normalizeUsername(kickUser.user.username), kickUser.user.profile_pic || null, existingTwitch.discord_user_id, kickUser.user.username]
                );
                const [kickStreamerRows] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = 'kick' AND platform_user_id = ?", [kickUser.id.toString()]);
                const kickStreamer = kickStreamerRows[0];

                if (kickStreamer) {
                    await db.execute(
                        `INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id, team_subscription_id) VALUES (?, ?, ?, ?)`,
                        [team.guild_id, kickStreamer.streamer_id, team.announcement_channel_id, teamId]
                    );
                    logger.info(`[TeamSync] Ensured subscription for Kick user ${kickUser.user.username} in team.`);
                }
            }
        }

        logger.info(`[TeamSync] Finished sync for team ID: ${teamId}`);
        return { success: true, message: `Team sync complete. Added ${usersToAdd.length} and removed ${usersToRemove.length} members.` };

    } catch (error) {
        logger.error(`[TeamSync] Unhandled error during team sync for ID ${teamId}:`, { error: error.stack });
        return { success: false, message: "An unexpected error occurred during team sync." };
    }
}

module.exports = { syncTwitchTeam };