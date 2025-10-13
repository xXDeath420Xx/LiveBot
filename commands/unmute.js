const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder} = require("discord.js");
const {logInfraction} = require("../core/moderation-manager");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Removes a timeout from a user.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
    .addUserOption(option =>
      option.setName("user")
        .setDescription("The user to unmute.")
        .setRequired(true))
    .addStringOption(option =>
      option.setName("reason")
        .setDescription("The reason for the unban.")
        .setRequired(true)),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});

    const targetUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
      return interaction.editReply("Could not find that user in the server.");
    }
    if (!member.communicationDisabledUntilTimestamp) {
      return interaction.editReply("This user is not currently muted.");
    }

    try {
      // Remove the timeout
      await member.timeout(null, reason);

      // Log the action as a new type of "infraction" for record-keeping
      await logInfraction(interaction, targetUser, "Unmute", reason);

      // Attempt to DM the user
      try {
        const dmEmbed = new EmbedBuilder()
          .setColor("#2ECC71")
          .setTitle(`You have been unmuted in ${interaction.guild.name}`)
          .addFields({name: "Reason", value: reason}, {name: "Moderator", value: interaction.user.tag})
          .setTimestamp();
        await targetUser.send({embeds: [dmEmbed]});
      } catch (dmError) {
        logger.warn(`[Unmute Command] Could not DM user ${targetUser.tag}: ${dmError.message}`);
      }

      const replyEmbed = new EmbedBuilder()
        .setColor("#57F287")
        .setDescription(`✅ Successfully unmuted ${targetUser.tag}.`);

      await interaction.editReply({embeds: [replyEmbed]});

    } catch (error) {
      logger.error("[Unmute Command Error]", error);
      await interaction.editReply("An unexpected error occurred. I may be missing permissions to remove timeouts.");
    }
  },
  category: "Music",
};