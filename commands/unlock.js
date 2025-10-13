const {SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder} = require("discord.js");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlocks the current channel, allowing @everyone to send messages.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),

  async execute(interaction) {
    const channel = interaction.channel;

    if (channel.type !== ChannelType.GuildText) {
      return interaction.reply({content: "This command can only be used in text channels.", ephemeral: true});
    }

    try {
      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
        SendMessages: null, // Use null to revert to the category/default permissions
      });

      const embed = new EmbedBuilder()
        .setColor("#2ECC71")
        .setTitle("🔓 Channel Unlocked")
        .setDescription("This channel has been unlocked. You may now send messages.")
        .setTimestamp();

      await interaction.reply({embeds: [embed]});

    } catch (error) {
      logger.error("[Unlock Command Error]", error);
      await interaction.reply({content: "Failed to unlock the channel. Do I have the Manage Channels permission?", ephemeral: true});
    }
  },
  category: "Moderation",
};