const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("massremovestreamer")
    .setDescription("Removes multiple streamers and purges their active announcements.")
    .addStringOption(o => o.setName("platform").setDescription("The platform to remove streamers from.").setRequired(true).addChoices(
      {name: "Twitch", value: "twitch"}, {name: "YouTube", value: "youtube"},
      {name: "Kick", value: "kick"}, {name: "TikTok", value: "tiktok"}, {name: "Trovo", value: "trovo"}
    ))
    .addStringOption(o => o.setName("usernames").setDescription("A comma-separated list of usernames.").setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const platform = interaction.options.getString("platform");
    const usernames = [...new Set(interaction.options.getString("usernames").split(",").map(name => name.trim().toLowerCase()).filter(Boolean))];
    const guildId = interaction.guild.id;

    if (usernames.length === 0) {
      return interaction.editReply("Please provide at least one username.");
    }

    const removed = [], failed = [];
    let purgedMessageCount = 0;

    try {
      const usernamePlaceholders = usernames.map(() => "?").join(", ");
      const [streamers] = await db.execute(
        `SELECT streamer_id, LOWER(username) as lower_username FROM streamers WHERE platform = ? AND LOWER(username) IN (${usernamePlaceholders})`,
        [platform, ...usernames]
      );

      const streamerMap = new Map(streamers.map(s => [s.lower_username, s.streamer_id]));

      const idsToRemove = [];
      for (const username of usernames) {
        if (streamerMap.has(username)) {
          idsToRemove.push(streamerMap.get(username));
          removed.push(username);
        } else {
          failed.push(`${username} (Not Found)`);
        }
      }

      if (idsToRemove.length > 0) {
        const idPlaceholders = idsToRemove.map(() => "?").join(", ");

        const [announcementsToPurge] = await db.execute(
          `SELECT message_id, channel_id FROM announcements WHERE guild_id = ? AND streamer_id IN (${idPlaceholders})`,
          [guildId, ...idsToRemove]
        );

        if (announcementsToPurge.length > 0) {
          const purgePromises = announcementsToPurge.map(ann => {
            return interaction.client.channels.fetch(ann.channel_id)
              .then(channel => channel?.messages.delete(ann.message_id))
              .catch(e => logger.warn(`[Mass Remove Streamer] Failed to delete message ${ann.message_id} in channel ${ann.channel_id}: ${e.message}`));
          });
          await Promise.allSettled(purgePromises);
          purgedMessageCount = announcementsToPurge.length;
        }

        await db.execute(
          `DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id IN (${idPlaceholders})`,
          [guildId, ...idsToRemove]
        );
      }

      const embed = new EmbedBuilder().setTitle("Mass Remove Report").setColor("#f04747");
      const field = (l) => {
        const content = l.length > 0 ? l.join(", ") : "None";
        return content.length > 1024 ? content.substring(0, 1020) + "..." : content;
      };

      embed.addFields(
        {name: `✅ Removed (${removed.length})`, value: field(removed)},
        {name: `❌ Failed (${failed.length})`, value: field(failed)},
        {name: `🗑️ Announcements Purged`, value: `${purgedMessageCount} message(s)`}
      );
      await interaction.editReply({embeds: [embed]});
    } catch (error) {
      logger.error("[Mass Remove Streamer Command Error]", error);
      await interaction.editReply("An error occurred while trying to remove streamers. Please try again later.");
    }
  },
};