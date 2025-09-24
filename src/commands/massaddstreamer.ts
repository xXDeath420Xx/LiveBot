const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ChannelType} = require("discord.js");
const db = require("../utils/db");
const apiChecks = require("../utils/api_checks");
const initCycleTLS = require("cycletls");
const {getBrowser, closeBrowser} = require("../utils/browserManager");

module.exports = {
  data: new SlashCommandBuilder().setName("massaddstreamer").setDescription("Adds multiple streamers from a platform.")
    .addStringOption(o => o.setName("platform").setDescription("The platform to add streamers to.").setRequired(true).addChoices(
      {name: "Twitch", value: "twitch"}, {name: "YouTube", value: "youtube"},
      {name: "Kick", value: "kick"}, {name: "TikTok", value: "tiktok"}, {name: "Trovo", value: "trovo"}
    ))
    .addStringOption(o => o.setName("usernames").setDescription("A comma-separated list of usernames or Channel IDs.").setRequired(true))
    .addChannelOption(o => o.setName("channel").setDescription("Announce all streamers in this list to a specific channel.").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))
    .addStringOption(o => o.setName("nickname").setDescription("Apply a custom webhook nickname to all streamers in this list."))
    .addAttachmentOption(o => o.setName("avatar").setDescription("Apply a custom webhook avatar to all streamers in this list. (Uploads to a temporary channel)").setRequired(false))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const platform = interaction.options.getString("platform");
    const channelOverride = interaction.options.getChannel("channel");
    const nickname = interaction.options.getString("nickname");
    const avatarAttachment = interaction.options.getAttachment("avatar");
    const usernames = [...new Set(interaction.options.getString("usernames").split(",").map(name => name.trim()).filter(Boolean))];
    if (usernames.length === 0) {
      return interaction.editReply("Please provide at least one username.");
    }

    const added = [], failed = [], updated = [];
    let cycleTLS = null;
    let browser = null;
    let finalAvatarUrl = null;

    try {
      if (avatarAttachment) {
        if (!avatarAttachment.contentType?.startsWith("image/")) {
          return interaction.editReply({content: "The provided avatar must be an image file (PNG, JPG, GIF)."});
        }
        const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
        if (!tempUploadChannelId) {
          throw new Error("Temporary upload channel ID is not configured. Please set TEMP_UPLOAD_CHANNEL_ID in your .env file for avatar uploads.");
        }
        try {
          const tempChannel = await interaction.client.channels.fetch(tempUploadChannelId);
          if (!tempChannel) {
            throw new Error("Temporary upload channel not found. Check TEMP_UPLOAD_CHANNEL_ID in .env.");
          }
          const tempMessage = await tempChannel.send({files: [{attachment: avatarAttachment.url, name: avatarAttachment.name}]});
          finalAvatarUrl = tempMessage.attachments.first().url;
          // FIX: Do not delete the message to get a permanent URL
          // await tempMessage.delete();
        } catch (uploadError) {
          console.error("[Mass Add Streamer] Error uploading temporary avatar to Discord:", uploadError);
          throw new Error("Failed to upload custom avatar. Check bot's permissions or TEMP_UPLOAD_CHANNEL_ID.");
        }
      }

      if (platform === "kick") {
        cycleTLS = await initCycleTLS({timeout: 60000});
      }
      if (platform === "tiktok" || platform === "youtube") {
        browser = await getBrowser();
      }

      for (const username of usernames) {
        try {
          let streamerInfo = null;
          if (platform === "twitch") {
            const u = await apiChecks.getTwitchUser(username);
            if (u) {
              streamerInfo = {puid: u.id, dbUsername: u.login};
            }
          } else if (platform === "kick" && cycleTLS) {
            const u = await apiChecks.getKickUser(cycleTLS, username);
            if (u) {
              streamerInfo = {puid: u.id.toString(), dbUsername: u.user.username};
            }
          } else if (platform === "youtube") {
            // Adjusted to get both ID and canonical name if available
            const {channelId, channelName} = await apiChecks.getYouTubeChannelId(username);
            if (channelId) {
              streamerInfo = {puid: channelId, dbUsername: channelName || username};
            }
          } else if (platform === "tiktok" && browser) {
            // TODO: Implement a robust API check for a stable TikTok PUID (e.g., a stable user ID).
            // For now, using username as PUID, but this is unreliable.
            console.warn(`[Mass Add Streamer] TikTok PUID uses username '${username}'. Implement proper API check for stable ID.`);
            streamerInfo = {puid: username, dbUsername: username};
          } else if (platform === "trovo") {
            // TODO: Implement apiChecks.getTrovoUser(username) to get reliable puid and dbUsername
            // For now, using username as PUID, but this is unreliable.
            console.warn(`[Mass Add Streamer] Trovo PUID uses username '${username}'. Implement proper API check for stable ID.`);
            streamerInfo = {puid: username, dbUsername: username};
          }

          if (!streamerInfo) {
            failed.push(`${username} (Not Found)`);
            continue;
          }

          let [[existingStreamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?", [platform, streamerInfo.puid]);
          let streamerId;
          if (existingStreamer) {
            streamerId = existingStreamer.streamer_id;
          } else {
            const [result] = await db.execute("INSERT INTO streamers (platform,username,platform_user_id) VALUES (?,?,?)", [platform, streamerInfo.dbUsername, streamerInfo.puid]);
            streamerId = result.insertId;
          }

          const announcementChannel = channelOverride?.id || null;

          const [[existingSubscription]] = await db.execute(
            "SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ? AND announcement_channel_id <=> ?",
            [interaction.guild.id, streamerId, announcementChannel]
          );

          if (existingSubscription) {
            await db.execute(
              `UPDATE subscriptions
               SET override_nickname   = ?,
                   override_avatar_url = IF(? IS NOT NULL, ?, override_avatar_url)
               WHERE subscription_id = ?`,
              [nickname || null, finalAvatarUrl, finalAvatarUrl, existingSubscription.subscription_id]
            );
            updated.push(username);
          } else {
            await db.execute(
              `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, override_nickname, override_avatar_url)
               VALUES (?, ?, ?, ?, ?)`,
              [interaction.guild.id, streamerId, announcementChannel, nickname || null, finalAvatarUrl]
            );
            added.push(username);
          }

        } catch (e) {
          console.error(`Mass add error for ${username}:`, e);
          failed.push(`${username} (API/DB Error)`);
        }
      }
    } finally {
      if (cycleTLS) {
        try {
          cycleTLS.exit();
        } catch (e) {
          console.error("[Mass Add Streamer] Error exiting cycleTLS:", e);
        }
      }
      if (browser) {
        await closeBrowser();
      }
    }

    const embed = new EmbedBuilder().setTitle("Mass Add Report").setColor("#5865F2");
    const field = (l) => l.length > 0 ? l.join(", ").substring(0, 1020) : "None";
    embed.addFields(
      {name: `✅ Added (${added.length})`, value: field(added)},
      {name: `🔄 Updated/Already Existed (${updated.length})`, value: field(updated)},
      {name: `❌ Failed (${failed.length})`, value: field(failed)}
    );

    let footerText = [];
    if (channelOverride) {
      footerText.push(`Channel: #${channelOverride.name}`);
    }
    if (nickname) {
      footerText.push(`Nickname: ${nickname}`);
    }
    if (finalAvatarUrl) {
      footerText.push(`Avatar URL provided`);
    }
    if (footerText.length > 0) {
      embed.setFooter({text: `Applied to all successful entries: ${footerText.join(" | ")}`});
    }

    await interaction.editReply({embeds: [embed]});
  },
};