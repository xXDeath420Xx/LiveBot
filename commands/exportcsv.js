const {SlashCommandBuilder, PermissionsBitField, AttachmentBuilder} = require("discord.js");
const db = require("../utils/db");
const Papa = require("papaparse");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("exportcsv")
    .setDescription("Exports all streamer subscriptions on this server to a CSV file.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});

    try {
      const [subscriptions] = await db.execute(
        `SELECT 
                    s.platform, 
                    s.username, 
                    s.discord_user_id, 
                    sub.custom_message,
                    sub.override_nickname,
                    sub.override_avatar_url,
                    sub.announcement_channel_id
                 FROM streamers s 
                 JOIN subscriptions sub ON s.streamer_id = sub.streamer_id 
                 WHERE sub.guild_id = ?
                 ORDER BY s.platform, s.username, sub.announcement_channel_id`,
        [interaction.guild.id]
      );

      if (subscriptions.length === 0) {
        return interaction.editReply("There are no streamer subscriptions to export from this server.");
      }

      const formattedData = subscriptions.map(sub => ({
        platform: sub.platform,
        username: sub.username,
        discord_user_id: sub.discord_user_id || "",
        custom_message: sub.custom_message || "",
        override_nickname: sub.override_nickname || "",
        override_avatar_url: sub.override_avatar_url || "",
        announcement_channel_id: sub.announcement_channel_id || ""
      }));


      const csv = Papa.unparse(formattedData);
      const attachment = new AttachmentBuilder(Buffer.from(csv), {name: `streamers_export_${interaction.guild.id}.csv`});

      await interaction.editReply({
        content: `Here is the export of ${subscriptions.length} streamer subscriptions.`,
        files: [attachment]
      });

    } catch (error) {
      logger.error("[Export CSV Error]", error);
      await interaction.editReply("An error occurred while exporting the streamer list.");
    }
  },
};