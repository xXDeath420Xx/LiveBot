const logger = require("../utils/logger");
const db = require("../utils/db");
const { cleanupInvalidRole } = require("./role-manager");
const apiChecks = require("../utils/api_checks.js");
const twitchApi = require("../utils/twitch-api.js");
const initCycleTLS = require("cycletls");

async function startupCleanup(client, targetGuildId = null) {
    const scope = targetGuildId ? ` for guild ${targetGuildId}` : " globally";
    logger.info(`[Startup Process] Starting cleanup and caching${scope}...`);
    let cycleTLS;

    try {
        // --- STAGE 1: Proactive Role Validation ---
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
                const configuredRoleIds = allRoleConfigs.filter(c => c.guild_id === guildId && c.live_role_id).map(c => c.live_role_id);
                for (const roleId of configuredRoleIds) {
                    const role = await guild.roles.fetch(roleId).catch(() => null);
                    if (!role) {
                        logger.warn(`[Startup Process] Found invalid role ${roleId} in guild ${guildId}. Purging from configs.`);
                        await cleanupInvalidRole(guildId, roleId);
                    }
                }
            } catch (e) {
                if (e.code !== 10004) { // Ignore Unknown Guild errors
                    logger.error(`[Startup Process] Error processing guild ${guildId} during role validation:`, { error: e.stack });
                }
            }
        }
        logger.info(`[Startup Process] Stage 1: Role validation complete.`);

        // --- STAGE 2: REMOVED ---
        logger.info(`[Startup Process] Stage 2: Role and announcement purge is now handled by the dedicated stream manager.`);

        // --- STAGE 3: Cache and Update Avatars ---
        logger.info(`[Startup Process] Stage 3: Caching and verifying avatars${scope}.`);
        try {
            const [streamersToUpdate] = await db.execute(`SELECT streamer_id, platform, username, profile_image_url FROM streamers WHERE platform = 'twitch'`);
            let updatedCount = 0;
            for (const twitchAccount of streamersToUpdate) {
                try {
                    const twitchUser = await twitchApi.getTwitchUser(twitchAccount.username);
                    const newAvatarUrl = twitchUser?.profile_image_url;

                    if (newAvatarUrl && twitchAccount.profile_image_url !== newAvatarUrl) {
                        await db.execute(`UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?`, [newAvatarUrl, twitchAccount.streamer_id]);
                        updatedCount++;
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
                await db.execute(`UPDATE streamers SET discord_user_id = ? WHERE platform = 'twitch' AND username = ?`, [ownerDiscordId, twitchUsername]);
            } catch(e) {
                logger.error("[Startup Process] Error during owner account linking:", { error: e.stack });
            }
            logger.info("[Startup Process] Stage 4: Owner account linking enforcement complete.");
        }

    } catch (e) {
        logger.error(`[Startup Process] A CRITICAL ERROR occurred:`, { error: e.stack });
    } finally {
        if (cycleTLS) await cycleTLS.exit();
        logger.info(`[Startup Process] Full cleanup and caching process has finished${scope}.`);
    }
}

module.exports = { startupCleanup };