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
            logger.warn(`[TeamSync] Team with ID ${teamId} not found.`);
            return { success: false, message: "Team not found." };
        }

        const twitchMembers = await apiChecks.getTwitchTeamMembers(team.team_name);
        if (!twitchMembers) {
            logger.error(`[TeamSync] Failed to fetch members for Twitch team: ${team.team_name}`);
            return { success: false, message: `Failed to fetch Twitch team members.` };
        }
        
        const twitchUsernames = new Set(twitchMembers.map(m => m.user_login.toLowerCase()));

        const [dbTeamStreamers] = await db.execute(`
            SELECT s.streamer_id, s.username
            FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id
            WHERE sub.team_subscription_id = ? AND s.platform = 'twitch'`, [teamId]);
        const dbUsernames = new Set(dbTeamStreamers.map(s => s.username.toLowerCase()));
        
        const usersToAdd = [...twitchUsernames].filter(u => !dbUsernames.has(u));
        const usersToRemove = [...dbUsernames].filter(u => !twitchUsernames.has(u));
        
        logger.info(`[TeamSync] For ${team.team_name}: ${usersToAdd.length} to add, ${usersToRemove.length} to remove.`);

        if (usersToRemove.length > 0) {
            const streamerIdsToRemove = dbTeamStreamers.filter(s => usersToRemove.includes(s.username.toLowerCase())).map(s => s.streamer_id);
            if (streamerIdsToRemove.length > 0) {
                await db.execute(`DELETE FROM subscriptions WHERE team_subscription_id = ? AND streamer_id IN (?)`, [teamId, streamerIdsToRemove]);
            }
        }

        for (const twitchUsername of usersToAdd) {
            const member = twitchMembers.find(m => m.user_login.toLowerCase() === twitchUsername);
            if (!member) continue;

            const [result] = await db.execute(
                `INSERT INTO streamers (platform, platform_user_id, username, profile_image_url) VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE username=VALUES(username), profile_image_url=VALUES(profile_image_url)`,
                ['twitch', member.user_id, member.user_login, member.profile_image_url]
            );
            const streamerId = result.insertId || (await db.execute("SELECT streamer_id FROM streamers WHERE platform = 'twitch' AND platform_user_id = ?", [member.user_id]))[0][0].streamer_id;

            if (streamerId) {
                await db.execute(
                    `INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id, team_subscription_id) VALUES (?, ?, ?, ?)`, 
                    [team.guild_id, streamerId, team.announcement_channel_id, teamId]
                );
            }
        }

        return { success: true, message: `Team sync complete.` };

    } catch (error) {
        logger.error(`[TeamSync] Unhandled error during team sync for ID ${teamId}:`, { error: error.stack });
        return { success: false, message: "An unexpected error occurred." };
    }
}

module.exports = { syncTwitchTeam };