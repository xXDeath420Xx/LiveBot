const {Client, GatewayIntentBits, Collection, Events, Partials, PermissionsBitField, EmbedBuilder, ChannelType, ButtonBuilder, ButtonStyle} = require("discord.js");
const fs = require("fs");
const path = require("path");
require("dotenv-flow").config();
const logger = require("./utils/logger");
const initCycleTLS = require("cycletls");
const dashboard = require(path.join(__dirname, "dashboard", "server.js"));
const {handleInteraction} = require("./core/interaction-handler");
const {setStatus, getStatus} = require("./core/status-manager");
const db = require("./utils/db");
const cache = require("./utils/cache");
const {updateAnnouncement} = require("./utils/announcer");
const apiChecks = require("./utils/api_checks");

async function main() {
  try {
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration],
      partials: [Partials.User, Partials.GuildMember]
      // Removed shards and shardCount options to prevent implicit sharding
    });

    let isShuttingDown = false;
    const intervals = [];

    async function shutdown(signal) {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.warn(`[Shutdown] Received ${signal}. Shutting down gracefully...`);
      setStatus("MAINTENANCE", "Bot is shutting down.");
      intervals.forEach(clearInterval);
      await client.destroy();
      await db.end();
      await cache.redis.quit();
      process.exit(0);
    }

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    client.commands = new Collection();
    const commandsPath = path.join(__dirname, "commands");
    const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith(".js"));
    for (const file of commandFiles) {
      try {
        const command = require(path.join(commandsPath, file));
        if (command.data && command.execute) {
          client.commands.set(command.data.name, command);
        }
      } catch (e) {
        logger.error(`[CMD Load Error] Failed to load ${file}:`, e);
      }
    }
    logger.info(`[Startup] ${client.commands.size} commands loaded.`);

    function getFilesRecursively(directory) {
      let files = [];
      const items = fs.readdirSync(directory, {withFileTypes: true});
      for (const item of items) {
        const fullPath = path.join(directory, item.name);
        if (item.isDirectory()) {
          files = files.concat(getFilesRecursively(fullPath));
        } else {
          files.push(fullPath);
        }
      }
      return files;
    }

    client.buttons = new Collection();
    client.modals = new Collection();
    client.selects = new Collection();
    const interactionsPath = path.join(__dirname, "interactions");
    const interactionFolders = fs.readdirSync(interactionsPath);
    for (const folder of interactionFolders) {
      const folderPath = path.join(interactionsPath, folder);
      const interactionFiles = getFilesRecursively(folderPath).filter(file => file.endsWith(".js"));
      for (const file of interactionFiles) {
        try {
          const handler = require(file);
          if (handler.customId && handler.execute) {
            const key = handler.customId.toString();
            if (folder === "buttons") client.buttons.set(key, handler);
            else if (folder === "modals") client.modals.set(key, handler);
            else if (folder === "selects") client.selects.set(key, handler);
          }
        } catch (e) {
          logger.error(`[Interaction Load Error] Failed to load ${file}:`, e);
      }
    }
    }
    logger.info(`[Startup] Loaded ${client.buttons.size} button handlers, ${client.modals.size} modal handlers, and ${client.selects.size} select menu handlers.`);

    client.on(Events.InteractionCreate, handleInteraction);
    client.once(Events.ClientReady, async c => {
      logger.info(`[READY] Logged in as ${c.user.tag}${c.shard ? ` on Shard #${c.shard.ids.join()}` : ""}`);
      
      // Removed conditional sharding check for dashboard startup
      setStatus("STARTING", "Initializing Dashboard...");
      // Pass startupCleanup to dashboard.start to break circular dependency
      const app = dashboard.start(c, PermissionsBitField, startupCleanup);
      const port = process.env.DASHBOARD_PORT || 3000;
      app.listen(port, () => {
          logger.info(`[Dashboard] Web dashboard listening on port ${port}`);
      });

      setStatus("STARTING", "Running startup cleanup...");
      await startupCleanup(c);
      
      setStatus("ONLINE", "Bot is online and operational.");

      await checkStreams(c);
      await checkTeams(c);

      intervals.push(setInterval(() => checkStreams(c), 180 * 1000));
      intervals.push(setInterval(() => checkTeams(c), 15 * 60 * 1000));
    });

    await client.login(process.env.DISCORD_TOKEN);

  } 
  catch (error) {
    logger.error("[Main Error] A fatal error occurred during bot startup:", error);
    process.exit(1);
  }
}

async function cleanupInvalidRole(guildId, roleId) {
  if (!guildId || !roleId) return;
  logger.info(`[Role Cleanup] Aggressively purging invalid role ID ${roleId} for guild ${guildId}.`);
  try {
    await db.execute("UPDATE guilds SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?", [guildId, roleId]);
    await db.execute("UPDATE twitch_teams SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?", [guildId, roleId]);
  } catch (dbError) {
    logger.error(`[Role Cleanup] DB Error while purging role ${roleId} for guild ${guildId}:`, dbError);
  }
}

async function startupCleanup(client, targetGuildId = null) {
  logger.info(`[Startup Cleanup] Starting${targetGuildId ? ` for guild ${targetGuildId}` : ""}...`);
  try {
    logger.info(`[Startup Cleanup] Stage 1: Validating configured role IDs${targetGuildId ? ` for guild ${targetGuildId}` : ""}...`);
    let guildRolesQuery = "SELECT guild_id, live_role_id FROM guilds WHERE live_role_id IS NOT NULL";
    let teamRolesQuery = "SELECT guild_id, live_role_id FROM twitch_teams WHERE live_role_id IS NOT NULL";
    const queryParams = [];

    if (targetGuildId) {
      guildRolesQuery += " AND guild_id = ?";
      teamRolesQuery += " AND guild_id = ?";
      queryParams.push(targetGuildId, targetGuildId);
    }

    const [guildRoles] = await db.execute(guildRolesQuery, targetGuildId ? [targetGuildId] : []);
    const [teamRoles] = await db.execute(teamRolesQuery, targetGuildId ? [targetGuildId] : []);
    
    const allRoleConfigs = [...guildRoles, ...teamRoles];
    const uniqueGuildIds = targetGuildId ? [targetGuildId] : [...new Set(allRoleConfigs.map(c => c.guild_id))];

    for (const guildId of uniqueGuildIds) {
      try {
        const guild = await client.guilds.fetch(guildId);
        const rolesForGuild = allRoleConfigs.filter(c => c.guild_id === guildId);
        const uniqueRoleIds = [...new Set(rolesForGuild.map(c => c.live_role_id))];

        for (const roleId of uniqueRoleIds) {
          if (!roleId) continue;
          const roleExists = await guild.roles.fetch(roleId).catch(() => null);
          if (!roleExists) {
            logger.info(`[Startup Cleanup] Found invalid role ${roleId} in guild ${guildId} during validation. Purging.`);
            await cleanupInvalidRole(guildId, roleId);
          }
        }
      } catch (e) {
        logger.warn(`[Startup Cleanup] Could not fetch guild ${guildId} during role validation. It may no longer exist.`, e);
      }
    }
    logger.info(`[Startup Cleanup] Stage 1: Proactive role validation complete${targetGuildId ? ` for guild ${targetGuildId}` : ""}.`);

    logger.info(`[Startup Cleanup] Stage 2: Checking for deleted announcement messages${targetGuildId ? ` for guild ${targetGuildId}` : ""}...`);
    let announcementsQuery = "SELECT a.*, s.username, s.platform, s.profile_image_url, sub.custom_message, sub.override_nickname, sub.override_avatar_url, sub.discord_user_id FROM announcements a JOIN streamers s ON a.streamer_id = s.streamer_id JOIN subscriptions sub ON a.subscription_id = sub.subscription_id";
    const announcementsQueryParams = [];

    if (targetGuildId) {
      announcementsQuery += " WHERE a.guild_id = ?";
      announcementsQueryParams.push(targetGuildId);
    }

    const [allAnnouncements] = await db.execute(announcementsQuery, announcementsQueryParams);

    for (const ann of allAnnouncements) {
      try {
        const channel = await client.channels.fetch(ann.channel_id).catch(e => {
          if (e.code === 10003) {
            logger.warn(`[Startup Cleanup] Channel ${ann.channel_id} for announcement ${ann.announcement_id} not found. Deleting from DB.`);
            return null;
          }
          throw e;
        });

        if (!channel || !channel.isTextBased()) {
          await db.execute("DELETE FROM announcements WHERE announcement_id = ?", [ann.announcement_id]);
          continue;
        }

        const message = await channel.messages.fetch(ann.message_id).catch(e => {
          if (e.code === 10008) {
            logger.warn(`[Startup Cleanup] Message ${ann.message_id} in channel ${ann.channel_id} not found. Reposting.`);
            return null;
          }
          throw e;
        });

        if (!message) {
          const [guildSettingsResult] = await db.execute("SELECT * FROM guilds WHERE guild_id = ?", [ann.guild_id]);
          const guildSettings = guildSettingsResult[0] || {};
          const [channelSettingsResult] = await db.execute("SELECT * FROM channel_settings WHERE guild_id = ? AND channel_id = ?", [ann.guild_id, ann.channel_id]);
          const channelSettings = channelSettingsResult[0] || {};
          const [teamSettingsResult] = await db.execute("SELECT * FROM twitch_teams WHERE guild_id = ? AND announcement_channel_id = ?", [ann.guild_id, ann.channel_id]);
          const teamSettings = teamSettingsResult[0] || {};

          const subContext = { ...ann };
          const liveData = {
            username: ann.username, platform: ann.platform, title: ann.stream_title, game: ann.stream_game, thumbnailUrl: ann.stream_thumbnail_url,
            url: ann.platform === "twitch" ? `https://twitch.tv/${ann.username}` : ann.platform === "kick" ? `https://kick.com/${ann.username}` : "#"
          };

          const repostedMessage = await updateAnnouncement(client, subContext, liveData, null, guildSettings, channelSettings, teamSettings);

          if (repostedMessage && repostedMessage.id) {
            await db.execute("UPDATE announcements SET message_id = ? WHERE announcement_id = ?", [repostedMessage.id, ann.announcement_id]);
            logger.info(`[Startup Cleanup] Reposted announcement ${ann.announcement_id} with new message ID ${repostedMessage.id}.`);
          } else {
            logger.error(`[Startup Cleanup] Failed to repost announcement ${ann.announcement_id}.`, { returned: repostedMessage });
          }
        }
      } catch (e) {
        logger.error(`[Startup Cleanup] Error processing announcement ${ann.announcement_id}:`, e);
      }
    }
    logger.info(`[Startup Cleanup] Stage 2: Deleted announcement message check complete${targetGuildId ? ` for guild ${targetGuildId}` : ""}.`);
    logger.info(`[Startup Cleanup] Stage 3: Load existing announcements for persistence${targetGuildId ? ` for guild ${targetGuildId}` : ""}...`);

  } catch (e) {
    logger.error("[Startup Cleanup] A CRITICAL ERROR occurred:", e);
  }
  finally {
    logger.info(`[Startup Cleanup] Full-stage cleanup/load process has finished${targetGuildId ? ` for guild ${targetGuildId}` : ""}.`);
  }
}

let isChecking = false;
let isCheckingTeams = false;

async function checkStreams(client) {
  if (isChecking) return;
  isChecking = true;
  logger.info(`[Check] ---> Starting stream check @ ${new Date().toLocaleTimeString()}`);
  let cycleTLS = null;
  try {
    const [subscriptionsWithStreamerInfo] = await db.execute(
      "SELECT sub.*, s.discord_user_id AS streamer_discord_user_id, s.platform_user_id, s.username, s.platform, s.kick_username FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id"
    );
    const [announcementsInDb] = await db.execute("SELECT * FROM announcements");
    const announcementsMap = new Map(announcementsInDb.map(a => [a.subscription_id, a]));

    const [guildSettingsList] = await db.execute("SELECT * FROM guilds");
    const guildSettingsMap = new Map(guildSettingsList.map(g => [g.guild_id, g]));
    const [channelSettingsList] = await db.execute("SELECT * FROM channel_settings");
    const channelSettingsMap = new Map(channelSettingsList.map(cs => [`${cs.guild_id}-${cs.channel_id}`, cs]));
    const [teamConfigs] = await db.execute("SELECT * FROM twitch_teams");
    const teamSettingsMap = new Map(teamConfigs.map(t => [`${t.guild_id}-${t.announcement_channel_id}`, t]));

    cycleTLS = await initCycleTLS({timeout: 60000});
    const liveStatusMap = new Map();
    const uniqueStreamers = [...new Map(subscriptionsWithStreamerInfo.map(item => [item.streamer_id, item])).values()];

    for (const streamer of uniqueStreamers) {
      try {
        let primaryLiveData = null;
        switch (streamer.platform) {
          case "twitch": primaryLiveData = await apiChecks.checkTwitch(streamer); break;
          case "kick": primaryLiveData = await apiChecks.checkKick(cycleTLS, streamer.username); break;
          case "youtube": primaryLiveData = await apiChecks.checkYouTube(streamer.platform_user_id); break;
          case "tiktok": primaryLiveData = await apiChecks.checkTikTok(streamer.username); break;
          case "trovo": primaryLiveData = await apiChecks.checkTrovo(streamer.username); break;
        }

        if (primaryLiveData && primaryLiveData.profileImageUrl && primaryLiveData.profileImageUrl !== streamer.profile_image_url) {
          await db.execute("UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?", [primaryLiveData.profileImageUrl, streamer.streamer_id]);
          logger.info(`[Avatar Update] Updated ${streamer.username}'s avatar.`);
        }
        if (primaryLiveData?.isLive) {
          liveStatusMap.set(streamer.streamer_id, primaryLiveData);
        }

        // Handle linked Kick accounts
        if (streamer.platform === "twitch" && streamer.kick_username) {
          const [[kickInfo]] = await db.execute("SELECT streamer_id, profile_image_url FROM streamers WHERE platform='kick' AND username=?", [streamer.kick_username]);
          if (kickInfo) {
            const linkedKickLiveData = await apiChecks.checkKick(cycleTLS, streamer.kick_username);
            if (linkedKickLiveData?.isLive) {
              // Set live data for the Kick streamer itself
              liveStatusMap.set(kickInfo.streamer_id, linkedKickLiveData);

              // Also, if the Twitch streamer is not already marked live,
              // set the Twitch streamer's ID to point to the Kick live data.
              // This ensures that subscriptions tied to the Twitch streamer_id
              // will also pick up the Kick live event.
              // If Twitch is already live, we prioritize Twitch's live data.
              if (!liveStatusMap.has(streamer.streamer_id)) {
                liveStatusMap.set(streamer.streamer_id, linkedKickLiveData);
                logger.info(`[Linked Stream] Twitch streamer ${streamer.username} (ID: ${streamer.streamer_id}) is considered live via linked Kick account ${streamer.kick_username}.`);
              }

              if (linkedKickLiveData.profileImageUrl && linkedKickLiveData.profileImageUrl !== kickInfo.profile_image_url) {
                await db.execute(`UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?`, [linkedKickLiveData.profileImageUrl, kickInfo.streamer_id]);
                logger.info(`[Avatar Update] Updated linked Kick account ${streamer.kick_username}'s avatar.`);
              }
            }
          }
        }
      } catch (e) {
        logger.error(`[API Check Error] for ${streamer.username}:`, e);
      }
    }

    const desiredAnnouncementKeys = new Set();
    for (const sub of subscriptionsWithStreamerInfo) {
      const liveData = liveStatusMap.get(sub.streamer_id);
      if (!liveData) continue;

      const guildSettings = guildSettingsMap.get(sub.guild_id);
      const targetChannelId = sub.announcement_channel_id || guildSettings?.announcement_channel_id;
      if (!targetChannelId) continue;

      desiredAnnouncementKeys.add(sub.subscription_id);
      const existing = announcementsMap.get(sub.subscription_id);
      const channelSettings = channelSettingsMap.get(`${sub.guild_id}-${targetChannelId}`);
      const teamSettings = teamSettingsMap.get(`${sub.guild_id}-${targetChannelId}`);

      try {
        const sentMessage = await updateAnnouncement(client, sub, liveData, existing, guildSettings, channelSettings, teamSettings);
        if (sentMessage && sentMessage.id && sentMessage.channel_id) {
          if (!existing) {
            logger.info(`[Announce] CREATED new announcement for ${sub.username} in channel ${targetChannelId}`);
            const [announcementResult] = await db.execute("INSERT INTO announcements (subscription_id, streamer_id, guild_id, message_id, channel_id, stream_game, stream_title, platform, stream_thumbnail_url) VALUES (?,?,?,?,?,?,?,?,?)", [sub.subscription_id, sub.streamer_id, sub.guild_id, sentMessage.id, sentMessage.channel_id, liveData.game || null, liveData.title || null, liveData.platform, liveData.thumbnailUrl || null]);
            const newAnnouncementId = announcementResult.insertId;
            if (newAnnouncementId) {
              await db.execute("INSERT INTO stream_sessions (announcement_id, streamer_id, guild_id, start_time, game_name) VALUES (?, ?, ?, NOW(), ?)", [newAnnouncementId, sub.streamer_id, sub.guild_id, liveData.game || null]);
              logger.info(`[Stats] Started tracking new stream session for announcement ID: ${newAnnouncementId}`);
            }
          } else if (existing && sentMessage.id !== existing.message_id) {
            logger.info(`[Announce] UPDATED message ID for ${sub.username}`);
            await db.execute("UPDATE announcements SET message_id = ? WHERE announcement_id = ?", [sentMessage.id, existing.announcement_id]);
          }
        } else {
          logger.error(`[Announce] updateAnnouncement did not return a valid message object for ${sub.username}.`, { sentMessage });
          }
        } catch (error) {
          logger.error(`[Announce] Error processing announcement for ${sub.username}:`, error);
        }
      }

    for (const [subscription_id, existing] of announcementsMap.entries()) {
      if (desiredAnnouncementKeys.has(subscription_id)) continue;
      try {
        const channel = await client.channels.fetch(existing.channel_id).catch(() => null);
        if (channel) {
          await channel.messages.delete(existing.message_id).catch(err => {
            if (err.code !== 10008) logger.error(`[Cleanup] Failed to delete message ${existing.message_id}:`, err);
          });
        }
        await db.execute("DELETE FROM announcements WHERE announcement_id = ?", [existing.announcement_id]);
      } catch (e) {
        logger.error(`[Cleanup] Error during deletion for announcement ${existing.announcement_id}:`, e);
      }
    }

    const usersToUpdate = new Map();
    for (const sub of subscriptionsWithStreamerInfo) {
      if (!sub.streamer_discord_user_id) continue;
      const key = `${sub.guild_id}-${sub.streamer_discord_user_id}`;
      if (!usersToUpdate.has(key)) {
        usersToUpdate.set(key, {guildId: sub.guild_id, userId: sub.streamer_discord_user_id, livePlatforms: new Set()});
      }
      if (liveStatusMap.has(sub.streamer_id)) {
        usersToUpdate.get(key).livePlatforms.add(sub.platform);
      }
    }

    logger.info(`[Role Management] Processing ${usersToUpdate.size} users for role updates.`);
    for (const [key, userState] of usersToUpdate.entries()) {
      const {guildId, userId, livePlatforms} = userState;
      const member = await client.guilds.fetch(guildId).then(g => g.members.fetch(userId)).catch(() => null);
      if (!member) continue;

      const guildSettings = guildSettingsMap.get(guildId);
      const streamerSubscriptions = subscriptionsWithStreamerInfo.filter(s => s.streamer_discord_user_id === userId && s.guild_id === guildId);
      const allTeamConfigsForGuild = teamConfigs.filter(t => t.guild_id === guildId && t.live_role_id);

      const desiredRoles = new Set();
      if (guildSettings?.live_role_id && livePlatforms.size > 0) {
        desiredRoles.add(guildSettings.live_role_id);
      }

      for (const teamConfig of allTeamConfigsForGuild) {
        const isStreamerInTeam = streamerSubscriptions.some(sub => sub.announcement_channel_id === teamConfig.announcement_channel_id && sub.platform === "twitch");
        if (isStreamerInTeam && livePlatforms.size > 0) {
          desiredRoles.add(teamConfig.live_role_id);
        }
      }

      const allManagedRoles = new Set([guildSettings?.live_role_id, ...allTeamConfigsForGuild.map(t => t.live_role_id)].filter(Boolean));

      for (const roleId of allManagedRoles) {
        if (desiredRoles.has(roleId)) {
          if (!member.roles.cache.has(roleId)) await handleRole(member, [roleId], "add", guildId);
        } else {
          if (!member.roles.cache.has(roleId)) await handleRole(member, [roleId], "remove", guildId);
        }
      }
    }

  } catch (e) {
    logger.error("[checkStreams] CRITICAL ERROR:", e);
  } finally {
    if (cycleTLS) {
      try { await cycleTLS.exit(); } catch (e) {
        logger.error("[cycleTLS] Error during exit:", e);
      }
    }
    isChecking = false;
    logger.info("[Check] ---> Finished stream check");
  }
}

async function checkTeams(client) {
  if (!isCheckingTeams) {
    isCheckingTeams = true;
    logger.info(`[Team Sync] ---> Starting team sync @ ${new Date().toLocaleTimeString()}`);
    let cycleTLS = null;
    try {
      const [teamSubscriptions] = await db.execute("SELECT * FROM twitch_teams");
      if (teamSubscriptions.length === 0) return;

      for (const sub of teamSubscriptions) {
        try {
          const apiMembers = await apiChecks.getTwitchTeamMembers(sub.team_name);
          if (!apiMembers) continue;

          const [dbTwitchSubs] = await db.execute(`SELECT s.streamer_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? AND sub.announcement_channel_id = ? AND s.platform = 'twitch'`, [sub.guild_id, sub.announcement_channel_id]);
          const [dbKickSubs] = await db.execute(`SELECT s.streamer_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? AND sub.announcement_channel_id = ? AND s.platform = 'kick'`, [sub.guild_id, sub.announcement_channel_id]);

          const currentTwitchStreamerIds = new Set();
          const currentKickStreamerIds = new Set();

          for (const member of apiMembers) {
            await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, profile_image_url) VALUES ('twitch', ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), profile_image_url=VALUES(profile_image_url)`, [member.user_id, member.user_login, member.profile_image_url || null]);
            const [[ts]] = await db.execute("SELECT streamer_id, kick_username FROM streamers WHERE platform=? AND platform_user_id=?", ["twitch", member.user_id]);
            if (ts) {
              currentTwitchStreamerIds.add(ts.streamer_id);
              await db.execute("INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)", [sub.guild_id, ts.streamer_id, sub.announcement_channel_id]);

              if (ts.kick_username) {
                if (!cycleTLS) cycleTLS = await initCycleTLS({timeout: 60000});
                const kickUser = await apiChecks.getKickUser(cycleTLS, ts.kick_username);
                if (kickUser?.id) {
                  await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, profile_image_url) VALUES ('kick', ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), profile_image_url=VALUES(profile_image_url)`, [kickUser.id.toString(), kickUser.user.username, kickUser.user.profile_pic || null]);
                  const [[kickStreamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform=? AND platform_user_id=?", ["kick", kickUser.id.toString()]);
                  if (kickStreamer) {
                    currentKickStreamerIds.add(kickStreamer.streamer_id);
                    await db.execute("INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)", [sub.guild_id, kickStreamer.streamer_id, sub.announcement_channel_id]);
                  }
                } else {
                  logger.warn(`[Team Sync] Could not find Kick user details for ${ts.kick_username}.`);
                }
              }
            }
          }

          const twitchToRemove = dbTwitchSubs.filter(dbSub => !currentTwitchStreamerIds.has(dbSub.streamer_id));
          if (twitchToRemove.length > 0) {
            await db.execute(`DELETE FROM subscriptions WHERE streamer_id IN (?) AND guild_id = ? AND announcement_channel_id = ?`, [twitchToRemove.map(s => s.streamer_id), sub.guild_id, sub.announcement_channel_id]);
            logger.info(`[Team Sync] Removed ${twitchToRemove.length} old Twitch subscriptions.`);
          }

          const kickToRemove = dbKickSubs.filter(dbSub => !currentKickStreamerIds.has(dbSub.streamer_id));
          if (kickToRemove.length > 0) {
            await db.execute(`DELETE FROM subscriptions WHERE streamer_id IN (?) AND guild_id = ? AND announcement_channel_id = ?`, [kickToRemove.map(s => s.streamer_id), sub.guild_id, sub.announcement_channel_id]);
            logger.info(`[Team Sync] Removed ${kickToRemove.length} old Kick subscriptions.`);
          }

        } catch (e) {
          logger.error(`[Team Sync] Error processing team ${sub.team_name}:`, e);
        }
      }
    } catch (error) {
      logger.error("[Team Sync] CRITICAL ERROR:", error);
    } finally {
      if (cycleTLS) {
        try { await cycleTLS.exit(); } catch (e) {
          logger.error("[cycleTLS] Error during exit:", e);
        }
      }
      isCheckingTeams = false;
      logger.info("[Team Sync] ---> Finished team sync.");
    }
  }
}

async function handleRole(member, roleIds, action, guildId) {
  if (!member || !roleIds || roleIds.length === 0) return;
  try { 
    for (const roleId of roleIds) {
      if (!roleId) continue;
      if (action === "add" && !member.roles.cache.has(roleId)) {
        await member.roles.add(roleId);
      } else if (action === "remove" && member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId);
      }
    }
  } catch (e) {
    // The roleId that caused the error is not directly available in the catch block if the error is from an await inside the loop.
    // We log general information and handle specific error codes.
    if (e.code === 10011) {
      logger.warn(`[handleRole] Invalid role detected for guild ${guildId}. Attempting cleanup. Error: ${e.message}`);
      // Attempt to clean up the role that caused the error. This assumes 'e.roleId' might be present or we infer from context.
      // For now, we'll just log and let cleanupInvalidRole handle the DB update based on guildId and potentially a known invalid roleId.
      // If the error object doesn't contain the specific roleId, cleanupInvalidRole might need to be more generic or rely on other means.
      await cleanupInvalidRole(guildId, null); // Pass null or a specific roleId if available in 'e'
    } else if (e.code === 50013) {
      logger.error(`[handleRole] Missing permissions to ${action} role for member ${member.id} in guild ${guildId}.`, e);
    } else {
      logger.error(`[handleRole] Failed to ${action} role for member ${member.id} in guild ${guildId}:`, e);
    }
  }
}

main().catch(error => {
    logger.error("Unhandled rejection during main execution:", error);
    process.exit(1);
});

module.exports = { main, startupCleanup };