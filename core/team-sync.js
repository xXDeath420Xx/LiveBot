async function syncTwitchTeam(teamId, db, apiChecks, logger, cycleTLS) {
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
            await db.execute(`DELETE FROM subscriptions WHERE team_subscription_id = ? AND streamer_id IN (?)`, [teamId, streamerIdsToRemove]);
            logger.info(`[TeamSync] Removed ${streamerIdsToRemove.length} users from team subscription.`);
        }

        for (const twitchUsername of usersToAdd) {
            const twitchMember = twitchMembers.find(m => m.user_login.toLowerCase() === twitchUsername);
            if (!twitchMember) continue;

            const [existingAccounts] = await db.execute(`SELECT discord_user_id FROM streamers WHERE username = ?`, [twitchMember.user_login]);
            const canonicalDiscordId = existingAccounts.find(a => a.discord_user_id)?.discord_user_id || null;

            await db.execute(
                `INSERT INTO streamers (platform, platform_user_id, username, profile_image_url, discord_user_id) VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE 
                    username=VALUES(username), 
                    profile_image_url=VALUES(profile_image_url),
                    discord_user_id=COALESCE(streamers.discord_user_id, VALUES(discord_user_id))`,
                ['twitch', twitchMember.user_id, twitchMember.user_login, twitchMember.profile_image_url || null, canonicalDiscordId]
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

            // Custom block for xXDeath420Xx
            if (twitchUsername.toLowerCase() === 'xxdeath420xx') {
                logger.info(`[TeamSync] Skipping Kick auto-link for owner account '${twitchUsername}'.`);
            } else {
                let kickUsername = null;
                try {
                    const kickUser = await apiChecks.getKickUser(cycleTLS, twitchUsername);
                    if (kickUser && kickUser.user) {
                        kickUsername = kickUser.user.username;
                        logger.info(`[TeamSync] Found matching Kick user for ${twitchUsername}: ${kickUsername}`);
                        
                        const finalDiscordId = twitchStreamer.discord_user_id;

                        await db.execute(
                            `INSERT INTO streamers (platform, platform_user_id, username, profile_image_url, discord_user_id) VALUES (?, ?, ?, ?, ?)
                             ON DUPLICATE KEY UPDATE 
                                username=VALUES(username), 
                                profile_image_url=VALUES(profile_image_url),
                                discord_user_id=COALESCE(streamers.discord_user_id, VALUES(discord_user_id))`,
                            ['kick', kickUser.id.toString(), kickUsername, kickUser.user.profile_pic || null, finalDiscordId]
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

                const allRelatedUsernames = [twitchUsername, kickUsername].filter(Boolean);
                if (allRelatedUsernames.length > 0) {
                    const usernamePlaceholders = allRelatedUsernames.map(() => '?').join(',');
                    const [allAccounts] = await db.execute(`SELECT discord_user_id FROM streamers WHERE username IN (${usernamePlaceholders})`, allRelatedUsernames);
                    const ultimateDiscordId = allAccounts.find(a => a.discord_user_id)?.discord_user_id || null;

                    if (ultimateDiscordId) {
                        await db.execute(
                            `UPDATE streamers SET discord_user_id = ? WHERE username IN (${usernamePlaceholders}) AND (discord_user_id IS NULL OR discord_user_id != ?)`,
                            [ultimateDiscordId, ...allRelatedUsernames, ultimateDiscordId]
                        );
                    }
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