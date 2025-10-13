const logger = require("../utils/logger");
const db = require("../utils/db");
const { PermissionsBitField } = require("discord.js");
const { processRole, cleanupInvalidRole } = require("./role-manager");
const apiChecks = require("../utils/api_checks.js");
const initCycleTLS = require("cycletls");

async function startupCleanup(client, targetGuildId = null) {
    const scope = targetGuildId ? ` for guild ${targetGuildId}` : " globally";
    logger.info(`[Startup Process] Starting cleanup and caching${scope}...`);
    let cycleTLS;

    try {
        // --- STAGE 1: Proactive Role Validation and Cleanup ---
        logger.info(`[Startup Process] Stage 1: Validating configured role IDs${scope}.`);
        let guildRolesQuery = "SELECT guild_id, live_role_id FROM guilds WHERE live_role_id IS NOT NULL";
        let teamRolesQuery = "SELECT guild_id, live_role_id FROM twitch_teams WHERE live_role_id IS NOT NULL";
        if (targetGuildId) {
            guildRolesQuery += " AND guild_id = ?";
            teamRolesQuery += " AND guild_id = ?";
        }
        const [guildRoles] = await db.execute(guildRolesQuery, targetGuildId ? [targetGuildId] : []);
        const [teamRoles] = await db.execute(teamRolesQuery, targetGuildId ? [targetGuildId] : []);

        const allRoleConfigs = [...guildRoles, ...teamRoles];
        const uniqueGuildIds = Array.from(new Set(allRoleConfigs.map(r => r.guild_id)));

        for (const guildId of uniqueGuildIds) {
            if (!guildId) continue;
            try {
                const guild = await client.guilds.fetch(guildId);
                
                const configuredRoleIds = allRoleConfigs
                    .filter(c => c.guild_id === guildId && c.live_role_id)
                    .map(c => c.live_role_id);

                // FIX: Fetch roles individually to avoid RangeError on large guilds
                for (const roleId of configuredRoleIds) {
                    const role = await guild.roles.fetch(roleId).catch(() => null);
                    if (!role) {
                        logger.warn(`[Startup Process] Found invalid role ${roleId} in guild ${guildId}. Purging from configs.`);
                        await cleanupInvalidRole(guildId, roleId);
                    }
                }
            } catch (e) {
                if (e.code === 10004) { // Unknown Guild
                    logger.warn(`[Startup Process] Bot is not in guild ${guildId} during role validation. It may have been kicked.`);
                } else {
                    logger.error(`[Startup Process] Error processing guild ${guildId} during role validation:`, { error: e.stack });
                }
            }
        }
        logger.info(`[Startup Process] Stage 1: Role validation complete.`);

        // --- STAGE 2: Remove Live Roles from Members and Purge Old Announcements ---
        const guildsToProcess = targetGuildId ? [targetGuildId] : uniqueGuildIds;
        logger.info(`[Startup Process] Stage 2: Processing roles and announcements for ${guildsToProcess.length} guild(s).`);

        for (const guildId of guildsToProcess) {
            if (!guildId) continue;
            try {
                const guild = await client.guilds.fetch(guildId);
                logger.info(`[Startup Process] Processing guild: ${guild.name} (${guildId})`);

                const [guildLiveRole] = await db.execute("SELECT live_role_id FROM guilds WHERE guild_id = ?", [guildId]);
                const [teamLiveRoles] = await db.execute("SELECT live_role_id FROM twitch_teams WHERE guild_id = ?", [guildId]);

                const roleIdsToClear = new Set([
                    ...(guildLiveRole[0]?.live_role_id ? [guildLiveRole[0].live_role_id] : []),
                    ...teamLiveRoles.map(r => r.live_role_id).filter(Boolean)
                ]);

                if (roleIdsToClear.size > 0) {
                    logger.info(`[Startup Process] Found ${roleIdsToClear.size} unique role(s) to clear for guild ${guildId}: ${Array.from(roleIdsToClear).join(', ')}`);
                    
                    for (const liveRoleId of roleIdsToClear) {
                        const role = await guild.roles.fetch(liveRoleId).catch(() => null);
                        if (role) {
                            const membersWithRole = role.members;
                            logger.info(`[Startup Process] Removing role '${role.name}' from ${membersWithRole.size} member(s) in guild ${guild.name}.`);
                            for (const member of membersWithRole.values()) {
                                if (!member.user.bot) {
                                    await processRole(member, [liveRoleId], "remove", guildId);
                                }
                            }
                        } else {
                            logger.warn(`[Startup Process] Role ${liveRoleId} not found in guild ${guildId} during cleanup.`);
                        }
                    }
                }

                // // Purge Announcements from DB - THIS IS THE CAUSE OF ANNOUNCEMENT SPAM. DISABLED.
                // if (!targetGuildId) {
                //     await db.execute("TRUNCATE TABLE announcements");
                //     logger.info("[Startup Process] Global: Announcements table truncated.");
                // } else {
                //     await db.execute("DELETE FROM announcements WHERE guild_id = ?", [guildId]);
                //     logger.info(`[Startup Process] Cleared announcements for guild ${guildId}.`);
                // }

            } catch (e) {
                logger.error(`[Startup Process] Failed to process guild ${guildId} for purge:`, { error: e.stack });
            }
        }
        // if (!targetGuildId) {
        //     // THIS IS THE CAUSE OF ANNOUNCEMENT SPAM. DISABLED.
        //     await db.execute("TRUNCATE TABLE stream_sessions");
        //     logger.info("[Startup Process] Global: Stream sessions table truncated.");
        // }
        logger.info(`[Startup Process] Stage 2: Role and announcement purge complete.`);

        // --- STAGE 3: Cache and Update Avatars ---
        logger.info(`[Startup Process] Stage 3: Caching and verifying avatars${scope}.`);
        try {
            let query = `SELECT s.streamer_id, s.platform, s.username, s.discord_user_id, s.profile_image_url FROM streamers s`;
            if (targetGuildId) {
                query += ` JOIN subscriptions sub ON s.streamer_id = sub.streamer_id WHERE sub.guild_id = ? GROUP BY s.streamer_id`;
            }
            const [streamersToUpdate] = await db.execute(query, targetGuildId ? [targetGuildId] : []);

            const allRelevantAccounts = streamersToUpdate;

            const userGroups = new Map();
            for (const acc of allRelevantAccounts) {
                const key = acc.discord_user_id || `streamer-${acc.streamer_id}`;
                if (!userGroups.has(key)) userGroups.set(key, []);
                userGroups.get(key).push(acc);
            }

            let updatedCount = 0;
            for (const accounts of userGroups.values()) {
                const twitchAccount = accounts.find(a => a.platform === 'twitch');
                if (!twitchAccount) continue;

                try {
                    const twitchUser = await apiChecks.getTwitchUser(twitchAccount.username);
                    const newAvatarUrl = twitchUser?.profile_image_url;

                    if (newAvatarUrl && twitchAccount.profile_image_url !== newAvatarUrl) {
                        logger.info(`[Avatar Cache] Found new avatar for ${twitchAccount.username}. Updating ${accounts.length} linked account(s).`);
                        const idsToUpdate = accounts.map(a => a.streamer_id);
                        const placeholders = idsToUpdate.map(() => '?').join(',');
                        const [result] = await db.execute(`UPDATE streamers SET profile_image_url = ? WHERE streamer_id IN (${placeholders})`, [newAvatarUrl, ...idsToUpdate]);
                        updatedCount += result.affectedRows;
                    }
                } catch (apiError) {
                    logger.warn(`[Avatar Cache] API error for Twitch user ${twitchAccount.username}: ${apiError.message}`);
                }
            }
            logger.info(`[Startup Process] Stage 3: Avatar caching complete. Updated ${updatedCount} records.`);

        } catch (e) {
            logger.error(`[Startup Process] CRITICAL ERROR in Stage 3 (Avatar Caching):`, { error: e.stack });
        }

        // --- STAGE 4: Enforce Owner Account Linking ---
        if (!targetGuildId) { // Only run on global startup
            logger.info("[Startup Process] Stage 4: Enforcing owner-specific account linking.");
            try {
                const ownerDiscordId = "365905620060340224";
                const twitchUsername = "xxdeath420xx";
                const kickUsername = "death420";

                await db.execute(
                    `UPDATE streamers SET discord_user_id = ? WHERE platform = 'twitch' AND username = ?`,
                    [ownerDiscordId, twitchUsername]
                );

                const [[kickAccount]] = await db.execute("SELECT * FROM streamers WHERE platform = 'kick' AND username = ?", [kickUsername]);

                if (!kickAccount) {
                    logger.info(`[Startup Linking] Owner's Kick account (${kickUsername}) not found. Attempting to create it.`);
                    cycleTLS = await initCycleTLS({ timeout: 20000 });
                    const kickUser = await apiChecks.getKickUser(cycleTLS, kickUsername).catch(() => null);
                    if (kickUser && kickUser.id) {
                        await db.execute(
                            `INSERT INTO streamers (platform, platform_user_id, username, discord_user_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE discord_user_id = VALUES(discord_user_id)`,
                            ['kick', kickUser.id.toString(), kickUsername, ownerDiscordId]
                        );
                        logger.info(`[Startup Linking] Successfully created and linked Kick account: ${kickUsername}`);
                    }
                } else if (kickAccount.discord_user_id !== ownerDiscordId) {
                    logger.info(`[Startup Linking] Found owner's Kick account (${kickUsername}) with incorrect link. Updating.`);
                    await db.execute(
                        `UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ?`,
                        [ownerDiscordId, kickAccount.streamer_id]
                    );
                }

            } catch(e) {
                logger.error("[Startup Process] Error during owner account linking:", { error: e.stack });
            }
            logger.info("[Startup Process] Stage 4: Owner account linking enforcement complete.");
        }

    } catch (e) {
        logger.error(`[Startup Process] A CRITICAL ERROR occurred:`, { error: e.stack });
    } finally {
        if (cycleTLS) {
            await cycleTLS.exit();
        }
        logger.info(`[Startup Process] Full cleanup and caching process has finished${scope}.`);
    }
}

module.exports = { startupCleanup };
