const db = require("../utils/db");
const logger = require("../utils/logger");
const { handleRole } = require("./role-manager");

/**
 * Checks if a user is blacklisted based on their platform ID.
 * @param {string} platform The platform (e.g., 'twitch', 'kick').
 * @param {string} platformUserId The user's ID on the platform.
 * @returns {Promise<boolean>} True if the user is blacklisted, false otherwise.
 */
async function isBlacklisted(platform, platformUserId) {
    // Corrected: Use db.execute and proper destructuring
    const [rows] = await db.execute("SELECT 1 FROM blacklisted_users WHERE platform = ? AND platform_user_id = ?", [platform, platformUserId]);
    return rows.length > 0;
}

/**
 * Purges all data associated with a given streamer ID.
 * @param {number} streamerId The internal streamer ID to purge.
 * @param {object} client The Discord client instance for API actions.
 */
async function purgeStreamerData(streamerId, client) {
    logger.warn(`[Blacklist] Starting data purge for streamer ID: ${streamerId}`);

    // Corrected: Use db.execute and proper destructuring
    const [streamerInfoRows] = await db.execute("SELECT * FROM streamers WHERE streamer_id = ?", [streamerId]);
    const streamerInfo = streamerInfoRows[0];
    if (!streamerInfo) {
        logger.warn(`[Blacklist] No streamer found with ID ${streamerId} for purging. It might have been deleted already.`);
        return;
    }

    // Corrected: Use db.execute
    const [subscriptions] = await db.execute("SELECT * FROM subscriptions WHERE streamer_id = ?", [streamerId]);
    const [announcements] = await db.execute("SELECT * FROM announcements WHERE streamer_id = ?", [streamerId]);

    for (const ann of announcements) {
        try {
            const channel = await client.channels.fetch(ann.channel_id).catch(() => null);
            if (channel?.isTextBased()) {
                await channel.messages.delete(ann.message_id).catch(err => {
                    if (err.code !== 10008) logger.warn(`[Blacklist] Could not delete message ${ann.message_id}: ${err.message}`);
                });
            }
        } catch (e) {
            logger.error(`[Blacklist] Error fetching channel or deleting message for announcement ${ann.announcement_id}:`, e);
        }
    }

    if (streamerInfo.discord_user_id) {
        const guildIds = [...new Set(subscriptions.map(s => s.guild_id))];
        for (const guildId of guildIds) {
            try {
                const guild = await client.guilds.fetch(guildId);
                const member = await guild.members.fetch(streamerInfo.discord_user_id).catch(() => null);
                if (member) {
                    // Corrected: Use db.execute and proper destructuring
                    const [liveRolesRows] = await db.execute("SELECT live_role_id FROM guilds WHERE guild_id = ? AND live_role_id IS NOT NULL", [guildId]);
                    const liveRoles = liveRolesRows.map(r => r.live_role_id);
                    const [teamRolesRows] = await db.execute("SELECT live_role_id FROM twitch_teams WHERE guild_id = ? AND live_role_id IS NOT NULL", [guildId]);
                    const teamRoles = teamRolesRows.map(r => r.live_role_id);
                    const roleIdsToRemove = [...new Set([...liveRoles, ...teamRoles].filter(Boolean))]; // Filter out nulls
                    for (const roleId of roleIdsToRemove) {
                        if (member.roles.cache.has(roleId)) {
                            await handleRole(member, [roleId], "remove", guildId, "User blacklisted");
                        }
                    }
                }
            } catch (e) {
                logger.error(`[Blacklist] Error removing roles from user ${streamerInfo.discord_user_id} in guild ${guildId}:`, e);
            }
        }
    }

    logger.info(`[Blacklist] Deleting database records for streamer ID: ${streamerId}`);
    // Corrected: Use db.execute
    await db.execute("DELETE FROM announcements WHERE streamer_id = ?", [streamerId]);
    await db.execute("DELETE FROM subscriptions WHERE streamer_id = ?", [streamerId]);
    await db.execute("DELETE FROM stream_sessions WHERE streamer_id = ?", [streamerId]);
    await db.execute("DELETE FROM streamers WHERE streamer_id = ?", [streamerId]);

    logger.warn(`[Blacklist] Purge complete for streamer ID: ${streamerId}`);
}

/**
 * Adds a user and all their associated accounts to the blacklist and initiates a purge of their data.
 * @param {string} identifier The username or Discord ID of the user to blacklist.
 * @param {string} blacklistedBy The Discord client instance.
 * @param {object} client The Discord client instance.
 * @returns {Promise<{blacklistedCount: number}>}
 */
async function blacklistUser(identifier, blacklistedBy, client) {
    let accountsToBlacklist = [];
    const isDiscordId = /^\d{17,19}$/.test(identifier);

    if (isDiscordId) {
        // Corrected: Use db.execute
        const [streamers] = await db.execute("SELECT * FROM streamers WHERE discord_user_id = ?", [identifier]);
        accountsToBlacklist.push(...streamers);
    } else {
        // Corrected: Use db.execute
        const [streamers] = await db.execute("SELECT * FROM streamers WHERE username = ?", [identifier]);
        if (streamers.length > 0) {
            // If we find accounts by username, get all other accounts linked by the same Discord ID
            const discordIds = [...new Set(streamers.map(s => s.discord_user_id).filter(Boolean))];
            if (discordIds.length > 0) {
                const placeholders = discordIds.map(() => '?').join(',');
                // Corrected: Use db.execute
                const [linkedStreamers] = await db.execute(`SELECT * FROM streamers WHERE discord_user_id IN (${placeholders})`, discordIds);
                accountsToBlacklist.push(...linkedStreamers);
            } else {
                accountsToBlacklist.push(...streamers);
            }
        }
    }

    const uniqueAccounts = [...new Map(accountsToBlacklist.map(item => [item.streamer_id, item])).values()];

    if (uniqueAccounts.length === 0) {
        throw new Error(`No streamer accounts found for identifier "${identifier}".`);
    }

    for (const account of uniqueAccounts) {
        // Corrected: Use db.execute
        await db.execute(
            `INSERT INTO blacklisted_users (platform, platform_user_id, username, discord_user_id, blacklisted_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username), blacklisted_at = NOW()`,
            [account.platform, account.platform_user_id, account.username, account.discord_user_id, blacklistedBy]
        );
        await purgeStreamerData(account.streamer_id, client);
    }
    
    logger.info(`[Blacklist] Blacklisted and purged ${uniqueAccounts.length} account(s) for identifier "${identifier}".`);
    return { blacklistedCount: uniqueAccounts.length };
}

/**
 * Removes a user from the blacklist by their blacklist ID.
 * @param {number} id The ID of the entry in the blacklisted_users table.
 * @returns {Promise<boolean>}
 */
async function unblacklistUser(id) {
    // Corrected: Use db.execute
    const [result] = await db.execute("DELETE FROM blacklisted_users WHERE id = ?", [id]);
    if (result.affectedRows > 0) {
        logger.info(`[Blacklist] User with blacklist ID ${id} has been removed from the blacklist.`);
        return true;
    }
    return false;
}

module.exports = {
    blacklistUser,
    unblacklistUser,
    isBlacklisted,
    purgeStreamerData,
};