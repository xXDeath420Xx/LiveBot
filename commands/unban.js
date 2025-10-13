const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder} = require("discord.js");
const {logInfraction} = require("../core/moderation-manager");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Revokes a ban for a user.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers)
    .addStringOption(option =>
      option.setName("user-id")
        .setDescription("The ID of the user to unban.")
        .setRequired(true))
    .addStringOption(option =>
      option.setName("reason")
        .setDescription("The reason for the unban.")
        .setRequired(true)),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});

    const targetUserId = interaction.options.getString("user-id");
    const reason = interaction.options.getString("reason");

    try {
      // Fetch the user to get their tag for logging purposes
      const targetUser = await interaction.client.users.fetch(targetUserId);

      // Unban the user
      await interaction.guild.members.unban(targetUser, reason);

      // Log the action
      await logInfraction(interaction, targetUser, "Unban", reason);

      const replyEmbed = new EmbedBuilder()
        .setColor("#57F287")
        .setDescription(`✅ Successfully unbanned ${targetUser.tag}.`);

      await interaction.editReply({embeds: [replyEmbed]});

    } catch (error) {
      logger.error("[Unban Command Error]", error);
      if (error.code === 10026) { // Unknown Ban
        await interaction.editReply("Could not find a ban for that user ID.");
      } else {
        await interaction.editReply("An error occurred. I may be missing Ban Members permission or the User ID is invalid.");
      }
    }
  },
  category: "Utility",
};