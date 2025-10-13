const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder} = require("discord.js");
const {logInfraction} = require("../core/moderation-manager");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Bans a user from the server.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers)
    .addUserOption(option =>
      option.setName("user")
        .setDescription("The user to ban.")
        .setRequired(true))
    .addStringOption(option =>
      option.setName("reason")
        .setDescription("The reason for the ban.")
        .setRequired(true)),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});

    const targetUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (member && !member.bannable) {
      return interaction.editReply("I cannot ban this user. They may have a higher role than me or I lack permissions.");
    }
    if (member && member.id === interaction.user.id) {
      return interaction.editReply("You cannot ban yourself.");
    }

    try {
      // Attempt to DM the user first
      const dmEmbed = new EmbedBuilder()
        .setColor("#E74C3C")
        .setTitle(`You have been banned from ${interaction.guild.name}`)
        .addFields({name: "Reason", value: reason}, {name: "Moderator", value: interaction.user.tag})
        .setTimestamp();
      await targetUser.send({embeds: [dmEmbed]}).catch((e) => logger.warn(`Could not DM user ${targetUser.tag}: ${e.message}`));

      // Ban the user
      await interaction.guild.members.ban(targetUser, {reason});

      // Log the infraction
      await logInfraction(interaction, targetUser, "Ban", reason);

      const replyEmbed = new EmbedBuilder()
        .setColor("#57F287")
        .setDescription(`✅ Successfully banned ${targetUser.tag}.`);

      await interaction.editReply({embeds: [replyEmbed]});

    } catch (error) {
      logger.error("[Ban Command Error]", error);
      await interaction.editReply("An unexpected error occurred while trying to ban this user.");
    }
  },
  category: "Utility",
};