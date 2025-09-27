const logger = require("../utils/logger");
const db = require("../utils/db");
const { PermissionsBitField } = require("discord.js");
const { handleRole, cleanupInvalidRole } = require("./role-manager");
const apiChecks = require("../utils/api_checks.js"); // Added for avatar caching

async function startupCleanup(client, targetGuildId = null) {
  const scope = targetGuildId ? ` for guild ${targetGuildId}` : " globally";
  logger.info(`[Startup Process] Starting cleanup and caching${scope}...`);

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
    const uniqueGuildIds = targetGuildId ? [targetGuildId] : [...new Set(allRoleConfigs.map(c => c.guild_id))];

    for (const guildId of uniqueGuildIds) {
      try {
        const guild = await client.guilds.fetch(guildId);
        const uniqueRoleIds = [...new Set(allRoleConfigs.filter(c => c.guild_id === guildId).map(c => c.live_role_id))];
        for (const roleId of uniqueRoleIds) {
          if (roleId && !(await guild.roles.fetch(roleId).catch(() => null))) {
            logger.warn(`[Startup Process] Found invalid role ${roleId} in guild ${guildId}. Purging from configs.`);
            await cleanupInvalidRole(guildId, roleId);
          }
        }
      } catch (e) {
        logger.warn(`[Startup Process] Could not fetch guild ${guildId} during role validation: ${e.message}`);
      }
    }
    logger.info(`[Startup Process] Stage 1: Role validation complete.`);

    // --- STAGE 2: Remove Live Roles from Members and Purge Old Announcements ---
    const guildsToProcess = targetGuildId ? [targetGuildId] : uniqueGuildIds;
    logger.info(`[Startup Process] Stage 2: Processing roles and announcements for ${guildsToProcess.length} guild(s).`);

    for (const guildId of guildsToProcess) {
      try {
        const guild = await client.guilds.fetch(guildId);
        logger.info(`[Startup Process] Processing guild: ${guild.name} (${guildId})`);

        // Remove Live Roles
        const [guildLiveRole] = await db.execute("SELECT live_role_id FROM guilds WHERE guild_id = ?", [guildId]);
        const [teamLiveRoles] = await db.execute("SELECT live_role_id FROM twitch_teams WHERE guild_id = ?", [guildId]);
        const roleIdsToClear = new Set([...(guildLiveRole[0]?.live_role_id ? [guildLiveRole[0].live_role_id] : []), ...teamLiveRoles.map(t => t.live_role_id)].filter(Boolean));

        if (roleIdsToClear.size > 0) {
          for (const roleId of roleIdsToClear) {
            const role = await guild.roles.fetch(roleId).catch(() => null);
            if (role) {
              for (const member of role.members.values()) {
                await handleRole(member, [roleId], "remove", guildId).catch(e => logger.warn(`Failed to remove role from ${member.user.tag}: ${e.message}`));
              }
            }
          }
        }

        // Purge Announcements
        const [announcements] = await db.execute("SELECT announcement_id, message_id, channel_id FROM announcements WHERE guild_id = ?", [guildId]);
        for (const ann of announcements) {
          const channel = await client.channels.fetch(ann.channel_id).catch(() => null);
          if (channel?.isTextBased() && channel.guild.members.me.permissionsIn(channel).has(PermissionsBitField.Flags.ManageMessages)) {
            await channel.messages.delete(ann.message_id).catch(err => { if (err.code !== 10008) logger.warn(`Could not delete message ${ann.message_id}: ${err.message}`); });
          }
        }
        if (announcements.length > 0) {
          await db.execute("DELETE FROM announcements WHERE guild_id = ?", [guildId]);
          logger.info(`[Startup Process] Cleared ${announcements.length} announcements for guild ${guildId}.`);
        }

        // --- NEW: Delete bot/webhook messages from tracked channels (last 7 days) ---
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const [trackedChannels] = await db.execute(
            `SELECT DISTINCT announcement_channel_id FROM subscriptions WHERE guild_id = ? AND announcement_channel_id IS NOT NULL`,
            [guildId]
        );
        const [guildSettings] = await db.execute("SELECT announcement_channel_id FROM guilds WHERE guild_id = ? AND announcement_channel_id IS NOT NULL", [guildId]);

        const allTrackedChannelIds = new Set([
            ...trackedChannels.map(row => row.announcement_channel_id),
            ...(guildSettings[0]?.announcement_channel_id ? [guildSettings[0].announcement_channel_id] : [])
        ]);

        for (const channelId of allTrackedChannelIds) {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (channel && channel.isTextBased() && channel.guild.members.me.permissionsIn(channel).has(PermissionsBitField.Flags.ManageMessages | PermissionsBitField.Flags.ReadMessageHistory)) {
                logger.info(`[Startup Process] Deleting bot/webhook messages in channel ${channel.name} (${channelId}) for guild ${guildId}.`);
                let lastId;
                let messagesDeletedInChannel = 0;

                while (true) {
                    const fetchedMessages = await channel.messages.fetch({
                        limit: 100,
                        before: lastId
                    }).catch(e => { logger.warn(`Failed to fetch messages in channel ${channelId}: ${e.message}`); return null; });

                    if (!fetchedMessages || fetchedMessages.size === 0) break;

                    const deletableMessages = fetchedMessages.filter(msg => {
                        const isBotOrWebhook = msg.author.bot || msg.webhookId;
                        const isWithinSevenDays = msg.createdAt > sevenDaysAgo;
                        return isBotOrWebhook && isWithinSevenDays;
                    });

                    if (deletableMessages.size > 0) {
                        await channel.bulkDelete(deletableMessages, true).then(deleted => {
                            messagesDeletedInChannel += deleted.size;
                            logger.debug(`Bulk deleted ${deleted.size} messages in ${channel.name}.`);
                        }).catch(e => logger.error(`Failed to bulk delete messages in ${channel.name}: ${e.message}`));
                    }

                    lastId = fetchedMessages.last()?.id;
                    if (!lastId || fetchedMessages.size < 100 || fetchedMessages.last().createdAt < sevenDaysAgo) break;
                }
                if (messagesDeletedInChannel > 0) {
                    logger.info(`[Startup Process] Deleted ${messagesDeletedInChannel} bot/webhook messages in #${channel.name} (${channelId}).`);
                }
            }
        }
        // --- END NEW: Delete bot/webhook messages ---

      } catch (e) {
        logger.error(`[Startup Process] Failed to process guild ${guildId} for purge: ${e.message}`);
      }
    }
    if (!targetGuildId) {
        await db.execute("TRUNCATE TABLE announcements");
        logger.info("[Startup Process] Global: Announcements table truncated.");
    }
    logger.info(`[Startup Process] Stage 2: Role and announcement purge complete.`);

    // --- STAGE 3: Cache and Update Avatars ---
    logger.info(`[Startup Process] Stage 3: Caching and verifying avatars${scope}.`);
    try {
        let query = `SELECT s.streamer_id, s.platform, s.username, s.discord_user_id, s.profile_image_url FROM streamers s`;
        if (targetGuildId) {
            query += ` JOIN subscriptions sub ON s.streamer_id = sub.streamer_id WHERE sub.guild_id = ? GROUP BY s.streamer_id`;
        }
        const [streamersToUpdate] = await db.execute(query, targetGuildId ? [targetGuildId] : []);

        const discordUserIds = [...new Set(streamersToUpdate.map(s => s.discord_user_id).filter(id => id && /^\d+$/.test(id)))];
        let allRelevantAccounts = [...streamersToUpdate];

        if (discordUserIds.length > 0) {
            const placeholders = discordUserIds.map(() => '?').join(',');
            const [linkedAccounts] = await db.execute(`SELECT * FROM streamers WHERE discord_user_id IN (${placeholders})`, discordUserIds);
            allRelevantAccounts = [...new Map([...allRelevantAccounts, ...linkedAccounts].map(item => [item.streamer_id, item])).values()];
        }

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
        logger.error(`[Startup Process] CRITICAL ERROR in Stage 3 (Avatar Caching):`, { error: e });
    }

    // --- STAGE 4: Enforce Owner Account Unlink ---
    if (!targetGuildId) { // Only run on global startup
        logger.info("[Startup Process] Stage 4: Enforcing owner-specific account rules.");
        try {
            const kickUsername = "xxdeath420xx";
            const [[kickAccountToDelete]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = 'kick' AND username = ?", [kickUsername]);

            if (kickAccountToDelete) {
                const streamerIdToDelete = kickAccountToDelete.streamer_id;
                logger.warn(`[Startup Purge] Found owner's Kick account ('${kickUsername}') with streamer_id ${streamerIdToDelete}. Purging...`);

                const [subDeletionResult] = await db.execute("DELETE FROM subscriptions WHERE streamer_id = ?", [streamerIdToDelete]);
                if (subDeletionResult.affectedRows > 0) {
                    logger.info(`[Startup Purge] Deleted ${subDeletionResult.affectedRows} subscriptions for Kick account '${kickUsername}'.`);
                }

                const [streamerDeletionResult] = await db.execute("DELETE FROM streamers WHERE streamer_id = ?", [streamerIdToDelete]);
                if (streamerDeletionResult.affectedRows > 0) {
                    logger.info(`[Startup Purge] Deleted streamer entry for Kick account '${kickUsername}'.`);
                }
            }
        } catch(e) {
            logger.error("[Startup Process] Error during owner account purge:", e);
        }
        logger.info("[Startup Process] Stage 4: Owner account rules enforcement complete.");
    }

  } catch (e) {
    logger.error(`[Startup Process] A CRITICAL ERROR occurred:`, { error: e });
  }
  finally {
    logger.info(`[Startup Process] Full cleanup and caching process has finished${scope}.`);
  }
}

module.exports = { startupCleanup };