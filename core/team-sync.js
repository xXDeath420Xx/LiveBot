const apiChecks = require("../utils/api_checks");
const logger = require('../utils/logger');

async function syncTwitchTeam(teamId, db) {
    if (!teamId) return { success: false, message: "No team ID provided." };

    let guildId = 'unknown';

    try {
        const [teams] = await db.execute("SELECT * FROM twitch_teams WHERE id = ?", [teamId]);
        const team = teams[0];
        if (!team) {
            logger.warn(`[TeamSync] Team with ID ${teamId} not found.`, { category: 'team-sync' });
            return { success: false, message: "Team not found." };
        }
        guildId = team.guild_id;
        logger.info(`[TeamSync] Starting sync for team ID: ${teamId}`, { guildId, category: 'team-sync' });

        const twitchMembers = await apiChecks.getTwitchTeamMembers(team.team_name);
        if (!twitchMembers) {
            logger.error(`[TeamSync] Failed to fetch members for Twitch team: ${team.team_name}. API returned no data.`, { guildId, category: 'team-sync' });
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
        
        logger.info(`[TeamSync] For ${team.team_name}: ${usersToAdd.length} to add, ${usersToRemove.length} to remove.`, { guildId, category: 'team-sync' });

        if (usersToRemove.length > 0) {
            const streamerIdsToRemove = dbTeamStreamers.filter(s => usersToRemove.includes(s.username.toLowerCase())).map(s => s.streamer_id);
            if (streamerIdsToRemove.length > 0) {
                const placeholders = streamerIdsToRemove.map(() => '?').join(',');
                await db.execute(`UPDATE subscriptions SET team_subscription_id = NULL WHERE team_subscription_id = ? AND streamer_id IN (${placeholders})`, [teamId, ...streamerIdsToRemove]);
                logger.info(`[TeamSync] Disassociated ${streamerIdsToRemove.length} streamers from team ${team.team_name}.`, { guildId, category: 'team-sync' });
            }
        }

        for (const twitchUsername of usersToAdd) {
            const member = twitchMembers.find(m => m.user_login.toLowerCase() === twitchUsername);
            if (!member) continue;

            let streamerId;
            const [insertResult] = await db.execute(
                `INSERT INTO streamers (platform, platform_user_id, username, profile_image_url) VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE username=VALUES(username), profile_image_url=VALUES(profile_image_url)`,
                ['twitch', member.user_id, member.user_login, member.profile_image_url]
            );
            
            if (insertResult.insertId) {
                streamerId = insertResult.insertId;
            } else {
                // If it was a duplicate key update, fetch the existing streamer_id
                const [[existingStreamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = 'twitch' AND platform_user_id = ?", [member.user_id]);
                streamerId = existingStreamer?.streamer_id;
            }

            if (streamerId) {
                const [[existingSubscription]] = await db.execute("SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?", [team.guild_id, streamerId]);

                if (existingSubscription) {
                    await db.execute("UPDATE subscriptions SET team_subscription_id = ? WHERE subscription_id = ?", [teamId, existingSubscription.subscription_id]);
                } else {
                    await db.execute(
                        `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, team_subscription_id) VALUES (?, ?, ?, ?)`, 
                        [team.guild_id, streamerId, team.announcement_channel_id, teamId]
                    );
                }
            }
        }
        logger.info(`[TeamSync] Team sync complete for ${team.team_name}.`, { guildId, category: 'team-sync' });
        return { success: true, message: `Team sync complete.` };

    } catch (error) {
        const errorStack = error instanceof Error ? error.stack : String(error);
        logger.error(`[TeamSync] Error during team sync for ID ${teamId}:`, { guildId, category: 'team-sync', error: errorStack });
        return { success: false, message: "An unexpected error occurred." };
    }
}

module.exports = { syncTwitchTeam };