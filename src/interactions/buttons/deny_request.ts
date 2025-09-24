const {EmbedBuilder, PermissionsBitField} = require("discord.js");

module.exports = {
  customId: /^deny_request_/,
  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({content: "You do not have permission to deny requests.", ephemeral: true});
    }
    const originalEmbed = interaction.message.embeds[0];
    const updatedEmbed = new EmbedBuilder(originalEmbed)
      .setColor("#ED4245")
      .setTitle("Request Denied")
      .setFooter({text: `Denied by ${interaction.user.tag}`});

    await interaction.update({embeds: [updatedEmbed], components: []});
    await interaction.followUp({content: "Request has been denied.", ephemeral: true});
  },
};