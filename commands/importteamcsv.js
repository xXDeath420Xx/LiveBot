const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder, MessageFlags, ChannelType} = require("discord.js");
const axios = require("axios");
const Papa = require("papaparse");
const db = require("../utils/db");
const twitchApi = require("../utils/twitch-api");
const kickApi = require("../utils/kick-api");
const { getYouTubeChannelId, exitCycleTLSInstance } = require("../utils/api_checks");
const {getBrowser} = require("../utils/browserManager");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder().setName("importteamcsv").setDescription("Syncs a specific channel with a CSV, adding/updating and removing streamers.")
    .addAttachmentOption(o => o.setName("csvfile")
      .setDescription("CSV with headers: platform, username, discord_user_id, etc.")
      .setRequired(true))
    .addChannelOption(o => o.setName("channel")
      .setDescription("The single channel to sync this team with.")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction) {
    const file = interaction.options.getAttachment("csvfile");
    const targetChannel = interaction.options.getChannel("channel");
    const targetChannelId = targetChannel.id;

    if (!file.name.endsWith(".csv")) {
      return interaction.reply({content: "Invalid file type. Must be a `.csv` file.", flags: [MessageFlags.Ephemeral]});
    }

    await interaction.deferReply({ephemeral: true});

    const added = [], updated = [], failed = [], removed = [];
    let browser = null;

    try {
      const fileContent = await axios.get(file.url, {responseType: "text"}).then(res => res.data);
      const {data: rows} = Papa.parse(fileContent, {header: true, skipEmptyLines: true});
      if (!rows || rows.length === 0) {
        return interaction.editReply({content: "CSV is empty or does not contain valid data rows."});
      }

      const platformsInCsv = new Set(rows.map(r => r.platform).filter(Boolean));

      if (platformsInCsv.has("youtube")) {
        browser = await getBrowser();
      }

      const [existingSubsInChannel] = await db.execute(
        "SELECT s.streamer_id, s.username FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? AND sub.announcement_channel_id = ?",
        [interaction.guild.id, targetChannelId]
      );
      const dbStreamerMap = new Map(existingSubsInChannel.map(sub => [sub.streamer_id, sub.username]));

      const csvStreamerIds = new Set();

      for (const row of rows) {
        const {platform, username, discord_user_id, custom_message, override_nickname, override_avatar_url} = row;
        if (!platform || !username) {
          failed.push(`(Skipped row: missing platform/username)`);
          continue;
        }

        const correctedDiscordId = /^[0-9]+$/.test(discord_user_id) ? discord_user_id : null;
        if (discord_user_id && !correctedDiscordId) {
          failed.push(`${username} (Invalid Discord ID)`);
        }

        try {
          let streamerInfo = null;
          let [[existingStreamer]] = await db.execute("SELECT streamer_id, platform_user_id, username FROM streamers WHERE platform = ? AND username = ?", [platform, username]);

          if (existingStreamer) {
            streamerInfo = {id: existingStreamer.streamer_id, puid: existingStreamer.platform_user_id, dbUsername: existingStreamer.username};
          } else {
            let apiResult;
            if (platform === "twitch") {
              apiResult = await twitchApi.getTwitchUser(username);
              if (apiResult) streamerInfo = {puid: apiResult.id, dbUsername: apiResult.login};
            } else if (platform === "kick") {
              apiResult = await kickApi.getKickUser(username);
              if (apiResult) streamerInfo = {puid: apiResult.id.toString(), dbUsername: apiResult.user.username};
            } else if (platform === "youtube") {
              apiResult = await getYouTubeChannelId(username, browser);
              if (apiResult?.channelId) streamerInfo = {puid: apiResult.channelId, dbUsername: apiResult.channelName || username};
            } else if (["tiktok", "trovo"].includes(platform)) {
              streamerInfo = {puid: username, dbUsername: username};
            }

            if (!streamerInfo || !streamerInfo.puid) {
              failed.push(`${username} (${platform}, Not Found via API)`);
              continue;
            }
          }

          const [result] = await db.execute(
            `INSERT INTO streamers (platform, platform_user_id, username, discord_user_id) VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE username=VALUES(username), discord_user_id=VALUES(discord_user_id)`,
            [platform, streamerInfo.puid, streamerInfo.dbUsername, correctedDiscordId]
          );
          const streamerId = result.insertId || (await db.execute("SELECT streamer_id FROM streamers WHERE platform=? AND platform_user_id=?", [platform, streamerInfo.puid]))[0][0].streamer_id;

          csvStreamerIds.add(streamerId);

          const [subResult] = await db.execute(
            `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, custom_message, override_nickname, override_avatar_url) VALUES (?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE custom_message=VALUES(custom_message), override_nickname=VALUES(override_nickname), override_avatar_url=VALUES(override_avatar_url)`,
            [interaction.guild.id, streamerId, targetChannelId, custom_message || null, override_nickname || null, override_avatar_url || null]
          );

          if (subResult.affectedRows > 1) {
            updated.push(username);
          } else {
            added.push(username);
          }

        } catch (err) {
          logger.error(`[Import Team CSV] Row Error for ${username}:`, err);
          failed.push(`${username} (DB Error)`);
        }
      }

      const idsToRemove = [];
      for (const [streamerId, streamerUsername] of dbStreamerMap.entries()) {
        if (!csvStreamerIds.has(streamerId)) {
          idsToRemove.push(streamerId);
          removed.push(streamerUsername);
        }
      }

      if (idsToRemove.length > 0) {
        const placeholders = idsToRemove.map(() => "?").join(",");
        await db.execute(
          `DELETE FROM subscriptions WHERE guild_id = ? AND announcement_channel_id = ? AND streamer_id IN (${placeholders})`,
          [interaction.guild.id, targetChannelId, ...idsToRemove]
        );
      }

    } catch (e) {
      logger.error("[Import Team CSV] Main Error:", e);
      return await interaction.editReply({content: `A critical error occurred processing the file: ${e.message}`});
    } finally {
      if (browser) await browser.close();
      await exitCycleTLSInstance();
    }

    const embed = new EmbedBuilder().setTitle(`Team Sync Complete for #${targetChannel.name}`).setColor("#5865F2");
    const field = (l) => l.length > 0 ? [...new Set(l)].join(", ").substring(0, 1020) : "None";
    embed.addFields(
      {name: `✅ Added (${[...new Set(added)].length})`, value: field(added)},
      {name: `🔄 Updated (${[...new Set(updated)].length})`, value: field(updated)},
      {name: `🗑️ Removed (${[...new Set(removed)].length})`, value: field(removed)},
      {name: `❌ Failed (${[...new Set(failed)].length})`, value: field(failed)}
    );
    await interaction.editReply({embeds: [embed]});
  },
  category: "Utility",
};