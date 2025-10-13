const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("history")
    .setDescription("Checks a user's moderation history.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
    .addUserOption(option =>
      option.setName("user")
        .setDescription("The user to check.")
        .setRequired(true)),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});

    const targetUser = interaction.options.getUser("user");

    const [infractions] = await db.execute(
      "SELECT id, moderator_id, type, reason, created_at FROM infractions WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 10",
      [interaction.guild.id, targetUser.id]
    );

    if (infractions.length === 0) {
      return interaction.editReply(`${targetUser.tag} has a clean record.`);
    }

    const embed = new EmbedBuilder()
      .setColor("#5865F2")
      .setAuthor({name: `Moderation History for ${targetUser.tag}`, iconURL: targetUser.displayAvatarURL()})
      .setDescription(infractions.map(inf =>
        `**Case #${inf.id} | ${inf.type}** - <t:${Math.floor(new Date(inf.created_at).getTime() / 1000)}:R>\n` +
        `**Moderator:** <@${inf.moderator_id}>\n` +
        `**Reason:** ${inf.reason}`
      ).join("\n\n"));

    await interaction.editReply({embeds: [embed]});
  },
  category: "Utility",
};