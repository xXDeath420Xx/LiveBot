const {SlashCommandBuilder, ChannelType, PermissionsBitField, EmbedBuilder, MessageFlags} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("setchannel")
    .setDescription("Sets the channel for live stream announcements.")
    .addChannelOption(o => o.setName("channel").setDescription("The channel for notifications").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction) {
    const channel = interaction.options.getChannel("channel");
    const guildId = interaction.guild.id;

    await interaction.deferReply({flags: [MessageFlags.Ephemeral]});

    try {
      await db.execute(
        "INSERT INTO guilds (guild_id, announcement_channel_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id)",
        [guildId, channel.id]
      );

      const embed = new EmbedBuilder()
        .setColor("#00FF00")
        .setTitle("✅ Channel Set!")
        .setDescription(`Announcements will now be sent to ${channel}.`);
      await interaction.editReply({embeds: [embed]});

    } catch (e) {
      logger.error("[SetChannel Error]", e);
      await interaction.editReply({content: "An error occurred while setting the channel."});
    }
  },
  category: "Utility",
};