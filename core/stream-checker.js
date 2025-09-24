// Forcing overwrite with full, correct content at: 2025-09-23T10:30:00.000Z
const logger = require("../utils/logger");
const db = require("../utils/db");
const cache = require("../utils/cache");
const apiChecks = require("../utils/api_checks.js");
const {announcementQueue} = require("../jobs/announcement-queue");
const {summaryQueue} = require("../jobs/summary-queue");
const initCycleTLS = require("cycletls");
const {handleRole} = require("./role-manager");

let isChecking = false;
let isCheckingTeams = false;

async function fetchAndCache(key, fetcher, ttl) {
  let data = await cache.get(key);
  if (data) {
    return data;
  }
  data = await fetcher();
  if (data) {
    await cache.set(key, data, ttl);
  }
  return data;
}

async function checkStreams(client) {
  if (isChecking) {
    return;
  }
  isChecking = true;
  logger.info(`[Check] ---> Starting stream check @ ${new Date().toLocaleTimeString()}`);
  let cycleTLS = null;
  try {
    const [subscriptions] = await db.execute("SELECT sub.*, s.*, s.discord_user_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id");

    // Modified to fetch only the latest announcement for each subscription_id
    const [announcementsInDb] = await db.execute(`
        SELECT a1.*
        FROM announcements a1
                 JOIN (SELECT subscription_id, MAX(announcement_id) as max_announcement_id
                       FROM announcements
                       GROUP BY subscription_id) a2 ON a1.subscription_id = a2.subscription_id AND a1.announcement_id = a2.max_announcement_id
    `);
    const announcementsMap = new Map(announcementsInDb.map(a => [a.subscription_id, a]));

    const guildSettingsList = await fetchAndCache("db:guilds", () => db.execute("SELECT * FROM guilds").then(res => res[0]), 300);
    const guildSettingsMap = new Map(guildSettingsList.map(g => [g.guild_id, g]));

    const channelSettingsList = await fetchAndCache("db:channel_settings", () => db.execute("SELECT * FROM channel_settings").then(res => res[0]), 300);
    const channelSettingsMap = new Map(channelSettingsList.map(cs => [`${cs.guild_id}-${cs.channel_id}`, cs]));

    const teamSettingsList = await fetchAndCache("db:twitch_teams", () => db.execute("SELECT * FROM twitch_teams").then(res => res[0]), 300);
    const teamSettingsMap = new Map(teamSettingsList.map(ts => [`${ts.guild_id}-${ts.announcement_channel_id}`, ts]));

    cycleTLS = await initCycleTLS({timeout: 60000});
    const liveStatusMap = new Map();
    const uniqueStreamers = [...new Map(subscriptions.map(item => [item.streamer_id, item])).values()];

    for (const streamer of uniqueStreamers) {
      try {
        const cacheKey = `api:${streamer.platform}:${streamer.username}`;
        const liveData = await fetchAndCache(cacheKey, async () => {
          if (streamer.platform === "twitch") {
            return apiChecks.checkTwitch(streamer);
          }
          if (streamer.platform === "kick") {
            return apiChecks.checkKick(cycleTLS, streamer.username);
          }
          if (streamer.platform === "youtube") {
            return apiChecks.checkYouTube(streamer.platform_user_id);
          }
          return null;
        }, 75);

        if (liveData?.isLive) {
          liveStatusMap.set(streamer.streamer_id, liveData);
        }
      } catch (e) {
        logger.error(`[API Check Error] for ${streamer.username}:`, {error: e});
      }
    }

    const desiredAnnouncementKeys = new Set();
    for (const sub of subscriptions) {
      const liveData = liveStatusMap.get(sub.streamer_id);
      if (!liveData) {
        continue;
      }

      const guildSettings = guildSettingsMap.get(sub.guild_id);
      const channelSettings = channelSettingsMap.get(`${sub.guild_id}-${sub.announcement_channel_id}`);
      const teamSettings = teamSettingsMap.get(`${sub.guild_id}-${sub.announcement_channel_id}`);

      if (!guildSettings || !guildSettings.announcement_channel_id) {
        continue;
      }

      // --- Role Assignment: Add role when streamer goes live ---
      if (guildSettings.live_role_id && sub.discord_user_id) {
        logger.debug(`[Role Manager] Attempting to add live role for ${sub.username} (Discord ID: ${sub.discord_user_id}) in guild ${sub.guild_id}. Role ID: ${guildSettings.live_role_id}`);
        try {
          const guild = client.guilds.cache.get(sub.guild_id);
          if (guild) {
            const member = await guild.members.fetch(sub.discord_user_id).catch(e => {
              logger.warn(`[Role Manager] Could not fetch member ${sub.discord_user_id} in guild ${sub.guild_id} for role assignment: ${e.message}`);
              return null;
            });
            if (member) {
              logger.debug(`[Role Manager] Member ${member.id} fetched. Calling handleRole to add.`);
              await handleRole(member, [guildSettings.live_role_id], "add", sub.guild_id);
            } else {
              logger.warn(`[Role Manager] Member object is null for ${sub.discord_user_id} in guild ${sub.guild_id}. Cannot add role.`);
            }
          } else {
            logger.warn(`[Role Manager] Guild ${sub.guild_id} not found for role assignment.`);
          }
        } catch (e) {
          logger.error(`[Role Manager] Error adding live role for ${sub.username} in guild ${sub.guild_id}:`, {error: e});
        }
      }
      // --- End Role Assignment: Add role ---

      desiredAnnouncementKeys.add(sub.subscription_id);
      await announcementQueue.add(`announcement-${sub.subscription_id}`, {client, sub, liveData, existing: announcementsMap.get(sub.subscription_id), guildSettings, channelSettings, teamSettings}, {jobId: `announcement-${sub.subscription_id}`, removeOnComplete: true, removeOnFail: 50});
    }

    for (const [subscription_id, existing] of announcementsMap.entries()) {
      if (!desiredAnnouncementKeys.has(subscription_id)) {
        try {
          await db.execute("UPDATE stream_sessions SET end_time = NOW() WHERE announcement_id = ? AND end_time IS NULL", [existing.announcement_id]);
          const guildSettings = guildSettingsMap.get(existing.guild_id);

          // --- Role Assignment: Remove role when streamer goes offline ---
          const [streamerInfo] = await db.execute("SELECT discord_user_id FROM streamers WHERE streamer_id = ?", [existing.streamer_id]);
          const existingDiscordUserId = streamerInfo.length > 0 ? streamerInfo[0].discord_user_id : null;

          if (guildSettings?.live_role_id && existingDiscordUserId) {
            logger.debug(`[Role Manager] Attempting to remove live role for streamer ${existing.streamer_id} (Discord ID: ${existingDiscordUserId}) in guild ${existing.guild_id}. Role ID: ${guildSettings.live_role_id}`);
            try {
              const guild = client.guilds.cache.get(existing.guild_id);
              if (guild) {
                const member = await guild.members.fetch(existingDiscordUserId).catch(e => {
                  logger.warn(`[Role Manager] Could not fetch member ${existingDiscordUserId} in guild ${existing.guild_id} for role removal: ${e.message}`);
                  return null;
                });
                if (member) {
                  logger.debug(`[Role Manager] Member ${member.id} fetched. Calling handleRole to remove.`);
                  await handleRole(member, [guildSettings.live_role_id], "remove", existing.guild_id);
                } else {
                  logger.warn(`[Role Manager] Member object is null for ${existingDiscordUserId} in guild ${existing.guild_id}. Cannot remove role.`);
                }
              } else {
                logger.warn(`[Role Manager] Guild ${existing.guild_id} not found for role removal.`);
              }
            } catch (e) {
              logger.error(`[Role Manager] Error removing live role for streamer ${existing.streamer_id} in guild ${existing.guild_id}:`, {error: e});
            }
          }
          // --- End Role Assignment: Remove role ---

          if (guildSettings?.enable_stream_summaries) {
            await summaryQueue.add(`summary-${existing.announcement_id}`, {announcement: existing});
          } else {
            const channel = await client.channels.fetch(existing.channel_id).catch(() => null);
            if (channel) {
              await channel.messages.delete(existing.message_id).catch(() => {
              });
            }
          }
          await db.execute("DELETE FROM announcements WHERE announcement_id = ?", [existing.announcement_id]);
        } catch (e) {
          logger.error(`[Cleanup] Error for announcement ${existing.announcement_id}:`, {error: e});
        }
      }
    }

  } catch (e) {
    logger.error("[checkStreams] CRITICAL ERROR:", {error: e});
  } finally {
    if (cycleTLS) {
      try {
        await cycleTLS.exit();
      } catch (e) {
      }
    }
    isChecking = false;
    logger.info(`[Check] ---> Finished stream check`);
  }
}

async function checkTeams(client) {
  if (isCheckingTeams) {
    return;
  }
  isCheckingTeams = true;
  logger.info(`[Team Sync] ---> Starting team sync @ ${new Date().toLocaleTimeString()}`);
  try {
    const teamSubscriptions = await fetchAndCache("db:twitch_teams", () => db.execute("SELECT * FROM twitch_teams").then(res => res[0]), 600);
    if (teamSubscriptions.length === 0) {
      return;
    }

    for (const sub of teamSubscriptions) {
      try {
        const apiMembers = await apiChecks.getTwitchTeamMembers(sub.team_name);
        if (!apiMembers) {
          continue;
        }

        const apiMemberIds = new Set(apiMembers.map(m => m.user_id));
        const [dbSubs] = await db.execute(`SELECT s.streamer_id, s.platform_user_id
                                           FROM subscriptions sub
                                                    JOIN streamers s ON sub.streamer_id = s.streamer_id
                                           WHERE sub.guild_id = ?
                                             AND sub.announcement_channel_id = ?
                                             AND s.platform = 'twitch'`, [sub.guild_id, sub.announcement_channel_id]);

        for (const member of apiMembers) {
          await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, profile_image_url)
                            VALUES ('twitch', ?, ?, ?)
                            ON DUPLICATE KEY UPDATE username=VALUES(username),
                                                    profile_image_url=VALUES(profile_image_url)`, [member.user_id, member.user_login, member.profile_image_url || null]);
          const [[ts]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform=? AND platform_user_id=?", ["twitch", member.user_id]);
          await db.execute("INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)", [sub.guild_id, ts.streamer_id, sub.announcement_channel_id]);
        }

        const toRemove = dbSubs.filter(dbSub => !apiMemberIds.has(dbSub.platform_user_id));
        if (toRemove.length > 0) {
          const idsToRemove = toRemove.map(s => s.streamer_id);
          await db.execute(`DELETE
                            FROM subscriptions
                            WHERE streamer_id IN (?)
                              AND guild_id = ?
                              AND announcement_channel_id = ?`, [idsToRemove, sub.guild_id, sub.announcement_channel_id]);
        }
      } catch (e) {
        logger.error(`[Team Sync] Error processing team ${sub.team_name}:`, {error: e.message});
      }
    }
  } catch (error) {
    logger.error("[Team Sync] CRITICAL ERROR:", {error: error});
  } finally {
    isCheckingTeams = false;
    logger.info("[Team Sync] ---> Finished team sync.");
  }
}

module.exports = {checkStreams, checkTeams};