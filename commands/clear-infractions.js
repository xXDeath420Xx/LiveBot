const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");
const {logInfraction} = require("../core/moderation-manager");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("clear-infractions")
    .setDescription("Clears a user's moderation history.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addUserOption(option =>
      option.setName("user")
        .setDescription("The user whose history you want to clear.")
        .setRequired(true))
    .addStringOption(option =>
      option.setName("reason")
        .setDescription("The reason for clearing the history.")
        .setRequired(true)),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});

    const targetUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");

    try {
      const [result] = await db.execute(
        "DELETE FROM infractions WHERE guild_id = ? AND user_id = ?",
        [interaction.guild.id, targetUser.id]
      );

      if (result.affectedRows > 0) {
        // Log this action for accountability
        await logInfraction(interaction, targetUser, "ClearInfractions", reason);

        const replyEmbed = new EmbedBuilder()
          .setColor("#57F287")
          .setDescription(`✅ Successfully cleared all ${result.affectedRows} infractions for ${targetUser.tag}.`);

        await interaction.editReply({embeds: [replyEmbed]});
      } else {
        await interaction.editReply(`${targetUser.tag} has no infractions to clear.`);
      }

    } catch (error) {
      logger.error("[Clear Infractions Command Error]", error);
      await interaction.editReply("An error occurred while trying to clear this user's history.");
    }
  },
};