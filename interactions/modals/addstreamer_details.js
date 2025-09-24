const {EmbedBuilder} = require("discord.js");
const db = require("../../utils/db");
const apiChecks = require("../../utils/api_checks");
const initCycleTLS = require("cycletls");
const {pendingInteractions} = require("../../commands/addstreamer");

module.exports = {
  customId: /^addstreamer_details_/,
  async execute(interaction) {
    await interaction.deferUpdate();
    const interactionId = interaction.customId.split("_")[2];
    const data = pendingInteractions.get(interactionId);
    if (!data) {
      return interaction.editReply({content: "This interaction has expired.", components: []});
    }

    const channelIds = interaction.fields.getTextInputValue("channels") ? [...new Set(interaction.fields.getTextInputValue("channels").split(",").map(id => id.trim()).filter(Boolean))] : [null];
    const nickname = interaction.fields.getTextInputValue("nickname") || null;
    const customMessage = interaction.fields.getTextInputValue("message") || null;
    const added = [], updated = [], failed = [];
    let cycleTLS = null;

    try {
      if (data.platforms.includes("kick")) {
        cycleTLS = await initCycleTLS({timeout: 60000});
      }
      for (const platform of data.platforms) {
        try {
          let streamerInfo = null, pfp = null;
          if (platform === "twitch") {
            const u = await apiChecks.getTwitchUser(data.username);
            if (u) {
              streamerInfo = {puid: u.id, dbUsername: u.login};
              pfp = u.profile_image_url;
            }
          } else if (platform === "kick" && cycleTLS) {
            const u = await apiChecks.getKickUser(cycleTLS, data.username);
            if (u) {
              streamerInfo = {puid: u.id.toString(), dbUsername: u.user.username};
              pfp = u.user.profile_pic;
            }
          } else if (platform === "youtube") {
            const c = await apiChecks.getYouTubeChannelId(data.username);
            if (c?.channelId) {
              streamerInfo = {puid: c.channelId, dbUsername: c.channelName || data.username};
            }
          } else if (["tiktok", "trovo"].includes(platform)) {
            streamerInfo = {puid: data.username, dbUsername: data.username};
          }
          if (!streamerInfo) {
            failed.push(`${data.username} on ${platform} (Not Found)`);
            continue;
          }
          await db.execute(`INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, profile_image_url)
                            VALUES (?, ?, ?, ?, ?)
                            ON DUPLICATE KEY UPDATE username=VALUES(username),
                                                    discord_user_id=IF(? IS NOT NULL, VALUES(discord_user_id), discord_user_id),
                                                    profile_image_url=VALUES(profile_image_url)`, [platform, streamerInfo.puid, streamerInfo.dbUsername, data.discordUserId, pfp || null, data.discordUserId]);
          const [[streamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?", [platform, streamerInfo.puid]);
          for (const channelId of channelIds) {
            const [res] = await db.execute(`INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, override_nickname, override_avatar_url, custom_message)
                                            VALUES (?, ?, ?, ?, ?, ?)
                                            ON DUPLICATE KEY UPDATE override_nickname=VALUES(override_nickname),
                                                                    override_avatar_url=VALUES(override_avatar_url),
                                                                    custom_message=VALUES(custom_message)`, [data.guildId, streamer.streamer_id, channelId, nickname, data.avatarUrl, customMessage]);
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
    } finally {
      if (cycleTLS) {
        try {
          await cycleTLS.exit();
        } catch (e) {
        }
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