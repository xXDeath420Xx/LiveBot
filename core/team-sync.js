import * as twitchApi from '../utils/platforms/twitch.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { getStreamEndDefaults } from './stream-end-defaults.js';
import { buildExclusionSet, isExcluded, normaliseLogin } from './team-sync-exclusions.js';
import { logFeatureEvent, userLabel } from './feature-log.js';

/** The guild as seen by the bot that serves it — server-log posts go through that bot. */
function servedGuild(guildId) {
    return global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
}

/** At most 15 names, then "+N more" (rosters can be large). */
function nameList(names) {
    const shown = names.slice(0, 15).join(', ');
    return names.length > 15 ? `${shown} +${names.length - 15} more` : shown;
}

async function syncTwitchTeam(teamId, client = null) {
    if (!teamId) return { success: false, message: "No team ID provided." };

    let guildId = 'unknown';
    let connection;
    // Every bot runs every team each hour (default bot first, then each custom bot). A change is
    // applied by whichever run gets there first, so changes are posted by that run (through the
    // serving bot's guild). Failures repeat on every run, so only the serving bot reports them.
    let logGuild = null;
    let isServingRun = false;
    let teamName = null;
    const logTeamFailure = (why) => {
        if (!isServingRun) return;
        void logFeatureEvent(() => (logGuild), 'team-sync.failed', () => ({
            title: '❌ Team Sync Failed',
            description: `The hourly sync of the Twitch team **${teamName || `#${teamId}`}** did not complete. It will try again next hour.`,
            fields: [['Team', teamName], ['Why', why, false]],
            throttle: { key: 'teamsync-fail:' + teamId, ms: 6 * 3600e3 },
        }));
    };

    try {
        connection = await pool.getConnection();

        const [teams] = await connection.execute("SELECT * FROM twitch_teams WHERE id = ?", [teamId]);
        const team = teams[0];
        if (!team) {
            logger.warn(`[TeamSync] Team with ID ${teamId} not found.`, { category: 'team-sync' });
            return { success: false, message: "Team not found." };
        }
        guildId = team.guild_id;
        teamName = team.team_name;
        const servingClient = global.botManager?.getClientForGuild?.(guildId);
        logGuild = servedGuild(guildId) || client?.guilds?.cache?.get(guildId) || null;
        isServingRun = servingClient ? client === servingClient : !!client?.guilds?.cache?.has(guildId);
        logger.debug(`[TeamSync] Starting aggressive sync for team: ${team.team_name}`, { guildId, category: 'team-sync' });

        // 1. Get all data sources
        const twitchMembers = await twitchApi.getTwitchTeamMembers(team.team_name);
        if (!twitchMembers) {
            logger.error(`[TeamSync] Failed to fetch members for Twitch team: ${team.team_name}.`, { guildId, category: 'team-sync' });
            logTeamFailure('Could not fetch the team roster from Twitch (team renamed or deleted, or Twitch is down)');
            return { success: false, message: `Failed to fetch Twitch team members.` };
        }

        // Exclusions: global rows (guild_id NULL) plus this server's own (/admin teamsync exclude).
        const [blacklistedUsers] = await connection.execute(
            'SELECT platform, platform_user_id, username FROM blacklisted_users WHERE guild_id IS NULL OR guild_id = ?',
            [guildId]
        );
        const blacklist = buildExclusionSet(blacklistedUsers);

        const [dbTeamStreamers] = await connection.execute(
            `SELECT s.streamer_id, s.username, s.platform_user_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.team_subscription_id = ? AND s.platform = 'twitch'`,
            [teamId]
        );

        // 2. Reconcile members (destructive sync)
        const twitchUsernames = new Set(twitchMembers.map(m => m.user_login.toLowerCase()));
        const dbUsernames = new Set(dbTeamStreamers.map(s => s.username.toLowerCase()));

        // Still on the roster but excluded in this server: released below rather than deleted
        // outright, so a subscription the server had before the team adopted it survives.
        const excludedOnTeam = dbTeamStreamers.filter(s => isExcluded(blacklist, s));
        const usersToAdd = twitchMembers.filter(m => !dbUsernames.has(m.user_login.toLowerCase()));
        const usersToRemove = dbTeamStreamers.filter(s => !twitchUsernames.has(s.username.toLowerCase()) && !isExcluded(blacklist, s));

        // Info only when the roster actually changes; the per-cycle 'nothing to do' line is debug.
        logger[usersToAdd.length || usersToRemove.length ? 'info' : 'debug'](`[TeamSync] For ${team.team_name}: ${usersToAdd.length} to add, ${usersToRemove.length} to remove, ${excludedOnTeam.length} excluded.`, { guildId, category: 'team-sync' });

        if (excludedOnTeam.length > 0) {
            const ids = excludedOnTeam.map(s => s.streamer_id);
            const [subs] = await connection.execute(
                `SELECT subscription_id, tracking_origin FROM subscriptions WHERE team_subscription_id = ? AND streamer_id IN (${ids.map(() => '?').join(',')})`,
                [teamId, ...ids]
            );
            const released = await releaseTeamSubscriptions(connection, subs);
            logger.info(`[TeamSync] Released ${released.deleted + released.detached} subscription(s) of excluded streamers from team ${team.team_name}.`, { guildId, category: 'team-sync', ...released });
            if (released.deleted + released.detached > 0) {
                void logFeatureEvent(() => (logGuild), 'team-sync.excluded', () => ({
                    title: '🚫 Streamer Excluded from Team',
                    description: `Excluded streamers still on the Twitch team **${team.team_name}** were released from the team sync.`,
                    fields: [
                        ['Team', team.team_name],
                        ['How', 'Released by the team sync'],
                        ['Streamers', nameList(excludedOnTeam.map(s => s.username)), false],
                        ['Removed', released.deleted],
                        ['Kept as server tracking', released.detached],
                    ],
                }));
            }
        }

        if (usersToRemove.length > 0) {
            const streamerIdsToRemove = usersToRemove.map(s => s.streamer_id);
            const placeholders = streamerIdsToRemove.map(() => '?').join(',');
            const [removed] = await connection.execute(`DELETE FROM subscriptions WHERE team_subscription_id = ? AND streamer_id IN (${placeholders})`, [teamId, ...streamerIdsToRemove]);
            logger.info(`[TeamSync] Deleted subscriptions for ${streamerIdsToRemove.length} streamers removed from team ${team.team_name}.`, { guildId, category: 'team-sync' });
            if (removed?.affectedRows > 0) {
                void logFeatureEvent(() => (logGuild), 'team-sync.removed', () => ({
                    title: '➖ Team Members Removed',
                    description: `${usersToRemove.length} streamer(s) left the Twitch team **${team.team_name}**, so they are no longer announced for it.`,
                    fields: [['Team', team.team_name], ['Streamers', nameList(usersToRemove.map(s => s.username)), false]],
                }));
            }
        }

        // Filter out excluded members first. Debug, not warn: an excluded member is skipped every
        // hour for as long as they stay on the roster, which is the point of excluding them.
        const validMembers = usersToAdd.filter(member => {
            if (isExcluded(blacklist, member)) {
                logger.debug(`[TeamSync] Skipped adding ${member.user_login} to team ${team.team_name}: excluded.`, { guildId, category: 'team-sync' });
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
                // Only adopt subs that are team-less, already ours, or orphaned by a deleted team.
                // A sub owned by ANOTHER live team in this guild (a streamer on two rosters) is
                // left alone and this team gets its own row — otherwise the two teams' hourly
                // syncs flip one row back and forth and the streamer announces in only one channel.
                // A team-less sub hand-routed to a channel is also left alone: adopting it would clear
                // that channel. The team gets its own row, which then applies roles only.
                const [existingSubs] = await connection.execute(
                    `SELECT subscription_id, streamer_id FROM subscriptions
                     WHERE guild_id = ? AND streamer_id IN (${subPlaceholders})
                       AND (team_subscription_id = ?
                            OR (team_subscription_id IS NULL AND announcement_channel_id IS NULL)
                            OR team_subscription_id NOT IN (SELECT id FROM twitch_teams))`,
                    [guildId, ...streamerIds, teamId]
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

                // Batch insert new subscriptions, stamped with the guild's stream-end default.
                // Channel left NULL → the team's channel; if this guild already hand-routes the
                // streamer elsewhere, the stream manager keeps this row to roles only.
                if (toInsert.length > 0) {
                    const streamEnd = await getStreamEndDefaults(guildId);
                    // 'external': the Twitch team roster governs these rows, not Discord membership
                    // — this same function reconciles them against the live roster every hour.
                    const insertValues = toInsert.map(s => `('${s.guildId}', ${s.streamerId}, ${teamId}, ${streamEnd.delete_on_end}, ${streamEnd.edit_on_end}, 'external')`).join(',');
                    await connection.execute(
                        `INSERT INTO subscriptions (guild_id, streamer_id, team_subscription_id, delete_on_end, edit_on_end, tracking_origin) VALUES ${insertValues}`
                    );
                }

                logger.info(`[TeamSync] Added ${validMembers.length} members to team ${team.team_name} (${toUpdate.length} updated, ${toInsert.length} inserted).`, { guildId, category: 'team-sync' });
                if (toUpdate.length + toInsert.length > 0) {
                    // Every member with a streamer row went into toUpdate or toInsert above.
                    const logins = validMembers.filter(m => streamerMap.get(m.user_id)).map(m => m.user_login);
                    void logFeatureEvent(() => (logGuild), 'team-sync.added', () => ({
                        title: '➕ Team Members Added',
                        description: `${logins.length} streamer(s) on the Twitch team **${team.team_name}** are now announced for it.`,
                        fields: [
                            ['Team', team.team_name],
                            ['Streamers', nameList(logins), false],
                            ['New subscriptions', toInsert.length],
                            ['Existing ones adopted', toUpdate.length],
                        ],
                    }));
                }
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
                void logFeatureEvent(() => (logGuild || guild), 'team-sync.linked', () => ({
                    title: '🔗 Team Accounts Linked',
                    description: `${autoLinkCount} streamer(s) on **${team.team_name}** were linked to the Discord member with the same username.`,
                    fields: [
                        ['Team', team.team_name],
                        ['Linked', toUpdate.slice(0, 15).map(u => `${u.username} → <@${u.discordId}>`).join('\n')
                            + (toUpdate.length > 15 ? `\n+${toUpdate.length - 15} more` : ''), false],
                    ],
                }));
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
            // Explicitly skip the owner's special Kick account. This is not a team exclusion (the
            // owner stays on the roster); it stops the owner's Twitch identity being linked to an
            // unrelated Kick account of the same name, so it stays here rather than in
            // blacklisted_users, which only governs roster membership.
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

        logger.debug(`[TeamSync] Aggressive sync complete for ${team.team_name}.`, { guildId, category: 'team-sync' });
        return { success: true, message: `Team sync complete.` };

    } catch (error) {
        logger.error(`[TeamSync] Error during team sync for ID ${teamId}:`, { error, guildId, category: 'team-sync'  });
        logTeamFailure(String(error?.message || 'Unexpected error').slice(0, 300));
        return { success: false, message: "An unexpected error occurred." };
    } finally {
        if (connection) connection.release();
    }
}

/**
 * Take subscriptions away from a team without losing a server's own tracking: rows the team
 * sync created ('external') are deleted, rows it adopted from the server's manual tracking are
 * detached (team_subscription_id = NULL) so they keep announcing as before.
 * @param {Array<{subscription_id: number, tracking_origin: string}>} subs
 */
async function releaseTeamSubscriptions(conn, subs) {
    const toDelete = subs.filter(s => s.tracking_origin === 'external').map(s => s.subscription_id);
    const toDetach = subs.filter(s => s.tracking_origin !== 'external').map(s => s.subscription_id);
    if (toDelete.length) {
        await conn.execute(`DELETE FROM subscriptions WHERE subscription_id IN (${toDelete.map(() => '?').join(',')})`, toDelete);
    }
    if (toDetach.length) {
        await conn.execute(`UPDATE subscriptions SET team_subscription_id = NULL WHERE subscription_id IN (${toDetach.map(() => '?').join(',')})`, toDetach);
    }
    return { deleted: toDelete.length, detached: toDetach.length };
}

/** Exclusions that apply to a server's team sync: its own plus global ones. */
async function listTeamExclusions(guildId) {
    const [rows] = await pool.execute(
        `SELECT id, guild_id, platform, platform_user_id, username, discord_user_id, blacklisted_by, reason, blacklisted_at
           FROM blacklisted_users
          WHERE guild_id = ? OR guild_id IS NULL
          ORDER BY guild_id IS NULL, username`,
        [guildId]
    );
    return rows;
}

/**
 * Exclude a Twitch streamer from every team sync in this server and release the subscriptions
 * the team sync currently holds for them here.
 *
 * @param {object} p
 * @param {string} p.guildId
 * @param {string} p.login           Twitch login as typed (normalised here)
 * @param {string|null} p.platformUserId  Twitch user id if known; falls back to the login
 * @param {string|null} p.reason
 * @param {string|null} p.addedBy    Discord id of the admin
 * @returns {Promise<{ok: boolean, error?: string, alreadyExcluded?: boolean, deleted?: number, detached?: number}>}
 */
async function addTeamExclusion({ guildId, login, platformUserId = null, discordUserId = null, reason = null, addedBy = null }) {
    const name = normaliseLogin(login);
    if (!name) return { ok: false, error: 'That is not a valid Twitch username.' };
    const id = platformUserId ? String(platformUserId) : name;

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [existing] = await conn.execute(
            `SELECT id, guild_id FROM blacklisted_users
              WHERE platform = 'twitch' AND (guild_id = ? OR guild_id IS NULL)
                AND (platform_user_id = ? OR LOWER(username) = ?)`,
            [guildId, id, name]
        );
        const alreadyExcluded = existing.length > 0;
        if (!alreadyExcluded) {
            await conn.execute(
                `INSERT INTO blacklisted_users (platform, platform_user_id, username, discord_user_id, blacklisted_by, guild_id, reason)
                 VALUES ('twitch', ?, ?, ?, ?, ?, ?)`,
                [id, name, discordUserId, addedBy, guildId, reason ? String(reason).slice(0, 255) : null]
            );
        }

        const [subs] = await conn.execute(
            `SELECT sub.subscription_id, sub.tracking_origin
               FROM subscriptions sub
               JOIN streamers s ON s.streamer_id = sub.streamer_id
               JOIN twitch_teams t ON t.id = sub.team_subscription_id
              WHERE sub.guild_id = ? AND t.guild_id = ? AND s.platform = 'twitch'
                AND (s.platform_user_id = ? OR LOWER(s.username) = ?)`,
            [guildId, guildId, id, name]
        );
        const released = await releaseTeamSubscriptions(conn, subs);

        await conn.commit();
        logger.info(`[TeamSync] Excluded ${name} from team sync`, { guildId, addedBy, category: 'team-sync', ...released });
        if (!alreadyExcluded || released.deleted + released.detached > 0) {
            void logFeatureEvent(() => (servedGuild(guildId)), 'team-sync.excluded', () => ({
                title: '🚫 Streamer Excluded from Team',
                description: `**${name}** will no longer be added by any team sync in this server.`,
                fields: [
                    ['Streamer', name],
                    ['How', alreadyExcluded ? 'Already excluded — team subscriptions released' : 'Excluded'],
                    ['By', userLabel(addedBy)],
                    ['Reason', reason ? String(reason).slice(0, 255) : null, false],
                    ['Removed', released.deleted || null],
                    ['Kept as server tracking', released.detached || null],
                ],
            }));
        }
        return { ok: true, alreadyExcluded, ...released };
    } catch (error) {
        await conn.rollback().catch(() => {});
        logger.error('[TeamSync] Failed to add exclusion', { guildId, login: name, error: error.message, category: 'team-sync' });
        throw error;
    } finally {
        conn.release();
    }
}

/**
 * Lift this server's exclusion. Global exclusions (guild_id NULL) are not removable from a
 * server. Returns { removed, globalOnly }. `liftedBy` (Discord id) is only for the server log.
 */
async function removeTeamExclusion(guildId, login, liftedBy = null) {
    const name = normaliseLogin(login);
    if (!name) return { removed: 0, globalOnly: false, invalid: true };
    const [result] = await pool.execute(
        `DELETE FROM blacklisted_users
          WHERE guild_id = ? AND platform = 'twitch' AND (LOWER(username) = ? OR platform_user_id = ?)`,
        [guildId, name, name]
    );
    let globalOnly = false;
    if (!result.affectedRows) {
        const [global] = await pool.execute(
            `SELECT id FROM blacklisted_users WHERE guild_id IS NULL AND platform = 'twitch' AND LOWER(username) = ? LIMIT 1`,
            [name]
        );
        globalOnly = global.length > 0;
    } else {
        logger.info(`[TeamSync] Exclusion lifted for ${name}`, { guildId, category: 'team-sync' });
        void logFeatureEvent(() => (servedGuild(guildId)), 'team-sync.excluded', () => ({
            title: '🚫 Streamer Excluded from Team',
            description: `**${name}** can be synced again; the next hourly team sync re-adds them if they are still on the team.`,
            fields: [['Streamer', name], ['How', 'Exclusion lifted'], ['By', userLabel(liftedBy)]],
        }));
    }
    return { removed: result.affectedRows, globalOnly };
}

export { syncTwitchTeam, listTeamExclusions, addTeamExclusion, removeTeamExclusion, releaseTeamSubscriptions };
