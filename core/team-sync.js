const { handleRole } = require("./role-manager"); // Import handleRole

async function syncTwitchTeam(teamId, db, apiChecks, logger, cycleTLS, client) {
    if (!teamId) return { success: false, message: "No team ID provided." };

    logger.info(`[TeamSync] Starting sync for team ID: ${teamId}`);

    try {
        const [[team]] = await db.execute("SELECT * FROM twitch_teams WHERE id = ?", [teamId]);
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
            SELECT s.streamer_id, s.username, s.platform
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
                await db.execute(`DELETE FROM subscriptions WHERE team_subscription_id = ? AND streamer_id IN (?)`, [teamId, streamerIdsToRemove]);
                logger.info(`[TeamSync] Removed ${streamerIdsToRemove.length} users from team subscription.`);
            }
        }

        for (const twitchUsername of usersToAdd) {
            const twitchMember = twitchMembers.find(m => m.user_login.toLowerCase() === twitchUsername);
            if (!twitchMember) continue;

            // Always update the Twitch entry with the latest info from the Twitch API
            await db.execute(
                `INSERT INTO streamers (platform, platform_user_id, username, profile_image_url, discord_user_id) VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE 
                    username=VALUES(username), 
                    profile_image_url=VALUES(profile_image_url),
                    discord_user_id=COALESCE(streamers.discord_user_id, VALUES(discord_user_id))`,
                ['twitch', twitchMember.user_id, twitchMember.user_login, twitchMember.profile_image_url || null, null]
            );

            const [[twitchStreamer]] = await db.execute("SELECT streamer_id, discord_user_id FROM streamers WHERE platform = 'twitch' AND platform_user_id = ?", [twitchMember.user_id]);

            if (!twitchStreamer) {
                logger.warn(`[TeamSync] Could not find or create streamer entry for Twitch user ${twitchUsername}.`);
                continue;
            }

            await db.execute(
                `INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id, team_subscription_id) VALUES (?, ?, ?, ?)`,
                [team.guild_id, twitchStreamer.streamer_id, team.announcement_channel_id, teamId]
            );
            logger.info(`[TeamSync] Added Twitch user ${twitchUsername} to team subscription.`);

            let kickUsername = null;
            try {
                const kickUser = await apiChecks.getKickUser(cycleTLS, twitchUsername);
                if (kickUser && kickUser.user) {
                    kickUsername = kickUser.user.username;
                    logger.info(`[TeamSync] Found matching Kick user for ${twitchUsername}: ${kickUsername}`);
                    
                    // For Kick, only set the avatar if it's currently NULL
                    await db.execute(
                        `INSERT INTO streamers (platform, platform_user_id, username, profile_image_url, discord_user_id) VALUES (?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE 
                            username=VALUES(username), 
                            profile_image_url=COALESCE(streamers.profile_image_url, VALUES(profile_image_url)),
                            discord_user_id=COALESCE(streamers.discord_user_id, VALUES(discord_user_id))`,
                        ['kick', kickUser.id.toString(), kickUsername, kickUser.user.profile_pic || null, twitchStreamer.discord_user_id]
                    );

                    const [[kickStreamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = 'kick' AND platform_user_id = ?", [kickUser.id.toString()]);

                    if (kickStreamer) {
                        await db.execute(
                            `INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id, team_subscription_id) VALUES (?, ?, ?, ?)`,
                            [team.guild_id, kickStreamer.streamer_id, team.announcement_channel_id, teamId]
                        );
                        logger.info(`[TeamSync] Added linked Kick user ${kickUsername} to team subscription.`);
                    }
                }
            } catch (kickError) {
                logger.error(`[TeamSync] Error while searching for Kick user ${twitchUsername}:`, kickError);
            }

            // Final data synchronization step
            const allRelatedUsernames = [...new Set([twitchUsername, kickUsername].filter(Boolean).map(u => u.toLowerCase()))];
            if (allRelatedUsernames.length > 0) {
                const usernamePlaceholders = allRelatedUsernames.map(() => '?').join(',');
                const [allAccounts] = await db.execute(`SELECT discord_user_id, profile_image_url, platform FROM streamers WHERE LOWER(username) IN (${usernamePlaceholders})`, allRelatedUsernames);
                
                // Prioritize Twitch for canonical data
                const twitchAccount = allAccounts.find(a => a.platform === 'twitch');
                const ultimateDiscordId = twitchStreamer.discord_user_id || allAccounts.find(a => a.discord_user_id)?.discord_user_id || null;
                const ultimateAvatar = twitchAccount?.profile_image_url || allAccounts.find(a => a.profile_image_url)?.profile_image_url || null;

                if (ultimateDiscordId || ultimateAvatar) {
                    const updateFields = [];
                    const updateValues = [];
                    if (ultimateDiscordId) { updateFields.push("discord_user_id = ?"); updateValues.push(ultimateDiscordId); }
                    if (ultimateAvatar) { updateFields.push("profile_image_url = ?"); updateValues.push(ultimateAvatar); }

                    await db.execute(
                        `UPDATE streamers SET ${updateFields.join(", ")} WHERE LOWER(username) IN (${usernamePlaceholders})`,
                        [...updateValues, ...allRelatedUsernames]
                    );
                    logger.info(`[TeamSync] Synchronized Discord ID and avatar for user ${twitchUsername}.`);
                }
            }
        }

        logger.info(`[TeamSync] Finished sync for team ID: ${teamId}`);
        return { success: true, message: `Team sync complete. Added ${usersToAdd.length} and removed ${usersToRemove.length} members.` };

    } catch (error) {
        logger.error(`[TeamSync] Unhandled error during team sync for ID ${teamId}:`, error);
        return { success: false, message: "An unexpected error occurred during team sync." };
    }
}

module.exports = { syncTwitchTeam };