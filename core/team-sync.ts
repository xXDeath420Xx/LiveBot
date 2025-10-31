import * as twitchApi from "../utils/twitch-api";
import logger from '../utils/logger';
import { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

interface SyncResult {
    success: boolean;
    message: string;
}

interface TeamRow extends RowDataPacket {
    id: number;
    team_name: string;
    guild_id: string;
}

interface BlacklistedUser extends RowDataPacket {
    platform: string;
    platform_user_id: string;
    username: string;
}

interface TeamStreamer extends RowDataPacket {
    streamer_id: string;
    username: string;
}

interface TwitchTeamMember {
    user_id: string;
    user_login: string;
}

interface CurrentTeamMember extends RowDataPacket {
    discord_user_id: string;
    username: string;
}

interface StreamerRow extends RowDataPacket {
    streamer_id: string;
}

interface SubscriptionRow extends RowDataPacket {
    subscription_id: string;
}

async function syncTwitchTeam(teamId: number, db: Pool): Promise<SyncResult> {
    if (!teamId) return { success: false, message: "No team ID provided." };

    let guildId = 'unknown';

    try {
        const [teams] = await db.execute<TeamRow[]>("SELECT * FROM twitch_teams WHERE id = ?", [teamId]);
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

        const [blacklistedUsers] = await db.execute<BlacklistedUser[]>('SELECT platform, platform_user_id, username FROM blacklisted_users');
        const blacklist = new Set(blacklistedUsers.map(u => `${u.platform}:${u.username.toLowerCase()}`));
        blacklistedUsers.forEach(u => blacklist.add(`${u.platform}:${u.platform_user_id}`));

        const [dbTeamStreamers] = await db.execute<TeamStreamer[]>(
            `SELECT s.streamer_id, s.username FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.team_subscription_id = ? AND s.platform = 'twitch'`,
            [teamId]
        );

        // 2. Reconcile members (destructive sync)
        const twitchUsernames = new Set(twitchMembers.map((m: TwitchTeamMember) => m.user_login.toLowerCase()));
        const dbUsernames = new Set(dbTeamStreamers.map(s => s.username.toLowerCase()));

        const usersToAdd = twitchMembers.filter((m: TwitchTeamMember) => !dbUsernames.has(m.user_login.toLowerCase()));
        const usersToRemove = dbTeamStreamers.filter(s => !twitchUsernames.has(s.username.toLowerCase()));

        logger.info(`[TeamSync] For ${team.team_name}: ${usersToAdd.length} to add, ${usersToRemove.length} to remove.`, { guildId, category: 'team-sync' });

        if (usersToRemove.length > 0) {
            const streamerIdsToRemove = usersToRemove.map(s => s.streamer_id);
            const placeholders = streamerIdsToRemove.map(() => '?').join(',');
            await db.execute<ResultSetHeader>(`UPDATE subscriptions SET team_subscription_id = NULL WHERE team_subscription_id = ? AND streamer_id IN (${placeholders})`, [teamId, ...streamerIdsToRemove]);
            logger.info(`[TeamSync] Disassociated ${streamerIdsToRemove.length} streamers from team ${team.team_name}.`, { guildId, category: 'team-sync' });
        }

        for (const member of usersToAdd as TwitchTeamMember[]) {
            // 3. Enforce blacklist
            if (blacklist.has(`twitch:${member.user_login.toLowerCase()}`) || blacklist.has(`twitch:${member.user_id}`)) {
                logger.warn(`[TeamSync] Skipped adding ${member.user_login} to team ${team.team_name} because they are on the blacklist.`, { guildId, category: 'team-sync' });
                continue;
            }

            await db.execute<ResultSetHeader>(
                `INSERT INTO streamers (platform, platform_user_id, username) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username)`,
                ['twitch', member.user_id, member.user_login]
            );

            const [[streamer]] = await db.execute<StreamerRow[]>("SELECT streamer_id FROM streamers WHERE platform = 'twitch' AND platform_user_id = ?", [member.user_id]);
            if (!streamer) continue;

            const [[existingSub]] = await db.execute<SubscriptionRow[]>("SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?", [guildId, streamer.streamer_id]);
            if (existingSub) {
                await db.execute<ResultSetHeader>("UPDATE subscriptions SET team_subscription_id = ? WHERE subscription_id = ?", [teamId, existingSub.subscription_id]);
            } else {
                await db.execute<ResultSetHeader>(`INSERT INTO subscriptions (guild_id, streamer_id, team_subscription_id) VALUES (?, ?, ?)`, [guildId, streamer.streamer_id, teamId]);
            }
            logger.info(`[TeamSync] Added ${member.user_login} to team ${team.team_name}.`, { guildId, category: 'team-sync' });
        }

        // 4. Aggressive Kick Account Linking
        logger.info(`[TeamSync] Starting aggressive Kick account linking for team ${team.team_name}.`, { guildId, category: 'team-sync' });
        const [currentTeamMembers] = await db.execute<CurrentTeamMember[]>(
            `SELECT s.discord_user_id, s.username FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.team_subscription_id = ? AND s.platform = 'twitch' AND s.discord_user_id IS NOT NULL`,
            [teamId]
        );

        let linkCount = 0;
        for (const twitchMember of currentTeamMembers) {
            // Explicitly skip the owner's special Kick account
            if (twitchMember.username.toLowerCase() === 'xxdeath420xx') continue;

            const [result] = await db.execute<ResultSetHeader>(
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
        const err = _error as Error;
        logger.error(`[TeamSync] Error during team sync for ID ${teamId}:`, { error: err, guildId, category: 'team-sync'  });
        return { success: false, message: "An unexpected _error occurred." };
    }
}

export = { syncTwitchTeam };
