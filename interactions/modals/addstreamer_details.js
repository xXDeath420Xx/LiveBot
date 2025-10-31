const {EmbedBuilder} = require("discord.js");
const { db } = require("../../utils/db");
const twitchApi = require("../../utils/twitch-api");
const kickApi = require("../../utils/kick-api");
const { getYouTubeChannelId, getFacebookUser, getInstagramUser } = require("../../utils/api_checks");
const {pendingInteractions} = require("../pending-interactions");

module.exports = {
  customId: /^addstreamer_details_/,
  async execute(interaction) {
    await interaction.deferUpdate();
    const interactionId = interaction.customId.split("_")[2];
    const data = pendingInteractions.get(interactionId);
    if (!data) {
      return interaction.editReply({content: "This interaction has expired.", components: []});
    }

    const channelIds = interaction.fields.getTextInputValue("channels") ? [...new Set(interaction.fields.getTextInputValue("channels").split(",").map(id => id.trim()).filter(Boolean))] : [interaction.channelId];
    const nickname = interaction.fields.getTextInputValue("nickname") || null;
    const customMessage = interaction.fields.getTextInputValue("message") || null;
    const youtubeVODs = (interaction.fields.getTextInputValue('youtube_vods') || 'no').toLowerCase() === 'yes';
    const tiktokVODs = (interaction.fields.getTextInputValue('tiktok_vods') || 'no').toLowerCase() === 'yes';
    const added = [], updated = [], failed = [];
    const allTouchedUsernames = new Set();

    if (data.discordUserId && !/^\d{17,19}$/.test(data.discordUserId)) {
        return interaction.editReply({ content: "Invalid Discord User ID provided. It must be a numeric ID.", components: [] });
    }

    try {
      for (const platform of data.platforms) {
        try {
          let streamerInfo = null, pfp = null;
          if (platform === "twitch") {
            const u = await twitchApi.getTwitchUser(data.username);
            if (u) {
              streamerInfo = {puid: u.id, dbUsername: u.login};
              pfp = u.profile_image_url;
            }
          } else if (platform === "kick") {
            const u = await kickApi.getKickUser(data.username);
            if (u) {
              streamerInfo = {puid: u.id.toString(), dbUsername: u.user.username};
              pfp = u.user.profile_pic;
            }
          } else if (platform === "youtube") {
            const c = await getYouTubeChannelId(data.username);
            if (c?.channelId) {
              streamerInfo = {puid: c.channelId, dbUsername: c.channelName || data.username};
            }
          } else if (platform === "facebook") {
            const u = await getFacebookUser(data.username);
            if (u) {
              streamerInfo = {puid: data.username, dbUsername: u.username};
              pfp = u.profileImageUrl;
            }
          } else if (platform === "instagram") {
            const u = await getInstagramUser(data.username);
            if (u) {
              streamerInfo = {puid: data.username, dbUsername: u.username};
              pfp = u.profileImageUrl;
            }
          } else if (["tiktok", "trovo"].includes(platform)) {
            streamerInfo = {puid: data.username, dbUsername: data.username};
          }
          if (!streamerInfo) {
            failed.push(`${data.username} on ${platform} (Not Found)`);
            continue;
          }

          await db.execute(
            `INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, profile_image_url) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                username=VALUES(username),
                discord_user_id=COALESCE(streamers.discord_user_id, VALUES(discord_user_id)),
                profile_image_url=IF(VALUES(platform) = 'twitch', VALUES(profile_image_url), COALESCE(streamers.profile_image_url, VALUES(profile_image_url)))`,
            [platform, streamerInfo.puid, streamerInfo.dbUsername, data.discordUserId, pfp || null]
          );

          const [[streamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?", [platform, streamerInfo.puid]);
          allTouchedUsernames.add(streamerInfo.dbUsername.toLowerCase());

          for (const channelId of channelIds) {
            const [res] = await db.execute(
              `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, override_nickname, override_avatar_url, custom_message, youtube_vod_notifications, tiktok_vod_notifications) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE override_nickname=VALUES(override_nickname), override_avatar_url=VALUES(override_avatar_url), custom_message=VALUES(custom_message), youtube_vod_notifications=VALUES(youtube_vod_notifications), tiktok_vod_notifications=VALUES(tiktok_vod_notifications)`,
              [data.guildId, streamer.streamer_id, channelId, nickname, data.avatarUrl, customMessage, youtubeVODs, tiktokVODs]
            );
            if (res.affectedRows > 1) {
              updated.push(`${streamerInfo.dbUsername} on ${platform}`);
            } else {
              added.push(`${streamerInfo.dbUsername} on ${platform}`);
            }
          }
        } catch (e) {
          console.error(`AddStreamer Modal Error for ${platform}:`, e);
          failed.push(`${data.username} on ${platform} (Error)`);
        }
      }
    } finally {}

    if (allTouchedUsernames.size > 0) {
        const usernames = Array.from(allTouchedUsernames);
        const [allAccounts] = await db.execute(`SELECT discord_user_id, profile_image_url, platform FROM streamers WHERE LOWER(username) IN (?)`, [usernames]);

        const finalTwitchAccount = allAccounts.find(a => a.platform === 'twitch');
        const ultimateDiscordId = allAccounts.find(a => a.discord_user_id)?.discord_user_id || null;
        const ultimateAvatar = finalTwitchAccount?.profile_image_url || allAccounts.find(a => a.profile_image_url)?.profile_image_url || null;

        if (ultimateDiscordId || ultimateAvatar) {
            const updateFields = [];
            const updateValues = [];
            if (ultimateDiscordId) { updateFields.push("discord_user_id = ?"); updateValues.push(ultimateDiscordId); }
            if (ultimateAvatar) { updateFields.push("profile_image_url = ?"); updateValues.push(ultimateAvatar); }

            await db.execute(
                `UPDATE streamers SET ${updateFields.join(", ")} WHERE LOWER(username) IN (?)`,
                [...updateValues, usernames]
            );
        }
    }

    let summary = `**Report for ${data.username}**\n`;
    if (added.length > 0) {
      summary += `✅ Added: ${[...new Set(added)].join(", ")}\n`;
    } 
    if (updated.length > 0) {
      summary += `🔄 Updated: ${[...new Set(updated)].join(", ")}\n`;
    }
    if (failed.length > 0) {
      summary += `❌ Failed: ${[...new Set(failed)].join(", ")}\n`;
    }

    await interaction.editReply({content: summary, components: []});
    pendingInteractions.delete(interactionId);
  },
};