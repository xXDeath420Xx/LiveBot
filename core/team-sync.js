import * as twitchApi from '../utils/platforms/twitch.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

async function syncTwitchTeam(teamId, client = null) {
    if (!teamId) return { success: false, message: "No team ID provided." };

    let guildId = 'unknown';
    let connection;

    try {
        connection = await pool.getConnection();

        const [teams] = await connection.execute("SELECT * FROM twitch_teams WHERE id = ?", [teamId]);
        const team = teams[0];
        if (!team) {
            logger.warn(`[TeamSync] Team with ID ${teamId} not found.`, { category: 'team-sync' });
            return { success: false, message: "Team not found." };
        }
        guildId = team.guild_id;
        logger.info(`[TeamSync] Starting aggressive sync for team: ${team.team_name}`, { guildId, category: 'team-sync' });

        // 1. Get all data sources
        const twitchMembers = await twitchApi.getTwitchTeamMembers(team.team_name);
        if (!twitchMembers) {
            logger.error(`[TeamSync] Failed to fetch members for Twitch team: ${team.team_name}.`, { guildId, category: 'team-sync' });
            return { success: false, message: `Failed to fetch Twitch team members.` };
        }

        const [blacklistedUsers] = await connection.execute('SELECT platform, platform_user_id, username FROM blacklisted_users');
        const blacklist = new Set(blacklistedUsers.map(u => `${u.platform}:${u.username.toLowerCase()}`));
        blacklistedUsers.forEach(u => blacklist.add(`${u.platform}:${u.platform_user_id}`));

        const [dbTeamStreamers] = await connection.execute(
            `SELECT s.streamer_id, s.username FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.team_subscription_id = ? AND s.platform = 'twitch'`,
            [teamId]
        );

        // 2. Reconcile members (destructive sync)
        const twitchUsernames = new Set(twitchMembers.map(m => m.user_login.toLowerCase()));
        const dbUsernames = new Set(dbTeamStreamers.map(s => s.username.toLowerCase()));

        const usersToAdd = twitchMembers.filter(m => !dbUsernames.has(m.user_login.toLowerCase()));
        const usersToRemove = dbTeamStreamers.filter(s => !twitchUsernames.has(s.username.toLowerCase()));

        logger.info(`[TeamSync] For ${team.team_name}: ${usersToAdd.length} to add, ${usersToRemove.length} to remove.`, { guildId, category: 'team-sync' });

        if (usersToRemove.length > 0) {
            const streamerIdsToRemove = usersToRemove.map(s => s.streamer_id);
            const placeholders = streamerIdsToRemove.map(() => '?').join(',');
            await connection.execute(`UPDATE subscriptions SET team_subscription_id = NULL WHERE team_subscription_id = ? AND streamer_id IN (${placeholders})`, [teamId, ...streamerIdsToRemove]);
            logger.info(`[TeamSync] Disassociated ${streamerIdsToRemove.length} streamers from team ${team.team_name}.`, { guildId, category: 'team-sync' });
        }

        // Filter out blacklisted members first
        const validMembers = usersToAdd.filter(member => {
            if (blacklist.has(`twitch:${member.user_login.toLowerCase()}`) || blacklist.has(`twitch:${member.user_id}`)) {
                logger.warn(`[TeamSync] Skipped adding ${member.user_login} to team ${team.team_name} because they are on the blacklist.`, { guildId, category: 'team-sync' });
                return false;
            }
            return true;
        });

        if (validMembers.length > 0) {
            // Batch insert/update all streamers at once
            const streamerValues = validMembers.map(m => `('twitch', '${m.user_id}', '${m.user_login.replace(/'/g, "''")}')`).join(',');
            await connection.execute(
                `INSERT INTO streamers (platform, platform_user_id, username) VALUES ${streamerValues} ON DUPLICATE KEY UPDATE username=VALUES(username)`
            );

            // Get all streamer IDs in a single query
            const platformUserIds = validMembers.map(m => m.user_id);
            const placeholders = platformUserIds.map(() => '?').join(',');
            const [streamers] = await connection.execute(
                `SELECT streamer_id, platform_user_id FROM streamers WHERE platform = 'twitch' AND platform_user_id IN (${placeholders})`,
                platformUserIds
            );

            // Create a map for quick lookup
            const streamerMap = new Map(streamers.map(s => [s.platform_user_id, s.streamer_id]));
            const streamerIds = streamers.map(s => s.streamer_id);

            // Get all existing subscriptions in a single query
            if (streamerIds.length > 0) {
                const subPlaceholders = streamerIds.map(() => '?').join(',');
                const [existingSubs] = await connection.execute(
                    `SELECT subscription_id, streamer_id FROM subscriptions WHERE guild_id = ? AND streamer_id IN (${subPlaceholders})`,
                    [guildId, ...streamerIds]
                );
                const existingSubMap = new Map(existingSubs.map(s => [s.streamer_id, s.subscription_id]));

                // Batch update existing subscriptions
                const toUpdate = [];
                const toInsert = [];

                for (const member of validMembers) {
                    const streamerId = streamerMap.get(member.user_id);
                    if (!streamerId) continue;

                    const existingSubId = existingSubMap.get(streamerId);
                    if (existingSubId) {
                        toUpdate.push(existingSubId);
                    } else {
                        toInsert.push({ guildId, streamerId });
                    }
                }

                // Batch update existing subscriptions — clear announcement_channel_id
                // so it falls through to the team's channel instead of keeping a stale override
                if (toUpdate.length > 0) {
                    const updatePlaceholders = toUpdate.map(() => '?').join(',');
                    await connection.execute(
                        `UPDATE subscriptions SET team_subscription_id = ?, announcement_channel_id = NULL WHERE subscription_id IN (${updatePlaceholders})`,
                        [teamId, ...toUpdate]
                    );
                }

                // Batch insert new subscriptions
                if (toInsert.length > 0) {
                    const insertValues = toInsert.map(s => `('${s.guildId}', ${s.streamerId}, ${teamId})`).join(',');
                    await connection.execute(
                        `INSERT INTO subscriptions (guild_id, streamer_id, team_subscription_id) VALUES ${insertValues}`
                    );
                }

                logger.info(`[TeamSync] Added ${validMembers.length} members to team ${team.team_name} (${toUpdate.length} updated, ${toInsert.length} inserted).`, { guildId, category: 'team-sync' });
            }
        }

        // 4. Auto-link Discord IDs based on username match or Twitch connections
        logger.info(`[TeamSync] Starting automatic Discord ID linking for team ${team.team_name}.`, { guildId, category: 'team-sync' });

        // Get all team members that don't have Discord IDs yet
        const [unlinkdMembers] = await connection.execute(
            `SELECT s.streamer_id, s.username, s.platform
             FROM subscriptions sub
             JOIN streamers s ON sub.streamer_id = s.streamer_id
             WHERE sub.team_subscription_id = ? AND s.discord_user_id IS NULL`,
            [teamId]
        );

        // Get the Discord guild
        const guild = client?.guilds.cache.get(guildId);
        if (guild && unlinkdMembers.length > 0) {
            let autoLinkCount = 0;

            // Only fetch members if we have unlinked members to process
            // Use cached members first, only fetch if cache is empty
            if (guild.members.cache.size < 10) {
                await guild.members.fetch();
            }

            // Build a map of lowercase usernames to member IDs for quick lookup
            const memberMap = new Map();
            for (const [id, member] of guild.members.cache) {
                memberMap.set(member.user.username.toLowerCase(), id);
            }

            // Batch collect all Discord IDs to update
            const toUpdate = [];

            for (const streamer of unlinkdMembers) {
                // Method 1: Check if Discord username matches Twitch username (case-insensitive)
                const discordId = memberMap.get(streamer.username.toLowerCase());

                if (discordId) {
                    toUpdate.push({ streamerId: streamer.streamer_id, discordId, username: streamer.username });
                    logger.debug(`[TeamSync] Found Discord username match for ${streamer.username}: ${discordId}`, { guildId, category: 'team-sync' });
                }
            }

            // Batch update all found Discord IDs
            if (toUpdate.length > 0) {
                for (const { streamerId, discordId, username } of toUpdate) {
                    await connection.execute(
                        'UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ?',
                        [discordId, streamerId]
                    );
                    autoLinkCount++;
                }
                logger.info(`[TeamSync] Successfully auto-linked ${autoLinkCount} streamers to Discord users.`, { guildId, category: 'team-sync' });
            }
        }

        // 5. Aggressive Kick Account Linking (keep existing logic)
        logger.info(`[TeamSync] Starting aggressive Kick account linking for team ${team.team_name}.`, { guildId, category: 'team-sync' });
        const [currentTeamMembers] = await connection.execute(
            `SELECT s.discord_user_id, s.username FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.team_subscription_id = ? AND s.platform = 'twitch' AND s.discord_user_id IS NOT NULL`,
            [teamId]
        );

        let linkCount = 0;
        for (const twitchMember of currentTeamMembers) {
            // Explicitly skip the owner's special Kick account
            if (twitchMember.username.toLowerCase() === 'xxdeath420xx') continue;

            const [result] = await connection.execute(
                `UPDATE streamers SET discord_user_id = ? WHERE platform = 'kick' AND username = ? AND discord_user_id IS NULL AND username != 'death420'`,
                [twitchMember.discord_user_id, twitchMember.username]
            );
            if (result.affectedRows > 0) {
                linkCount++;
                logger.info(`[TeamSync] Linked Kick account '${twitchMember.username}' to Discord user ${twitchMember.discord_user_id}.`, { guildId, category: 'team-sync' });
            }
        }
        if (linkCount > 0) {
            logger.info(`[TeamSync] Successfully linked ${linkCount} new Kick accounts.`, { guildId, category: 'team-sync' });
        }

        logger.info(`[TeamSync] Aggressive sync complete for ${team.team_name}.`, { guildId, category: 'team-sync' });
        return { success: true, message: `Team sync complete.` };

    } catch (error) {
        logger.error(`[TeamSync] Error during team sync for ID ${teamId}:`, { error, guildId, category: 'team-sync'  });
        return { success: false, message: "An unexpected error occurred." };
    } finally {
        if (connection) connection.release();
    }
}

export { syncTwitchTeam };
