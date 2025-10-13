const {SlashCommandBuilder} = require("@discordjs/builders");
const {PermissionsBitField} = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("panic")
    .setDescription("Toggles panic mode to lock down the server during a raid.")
    .addBooleanOption(option =>
      option.setName("enable")
        .setDescription("Enable or disable panic mode.")
        .setRequired(true)),
  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({content: "You do not have permission to use this command.", ephemeral: true});
    }

    const enable = interaction.options.getBoolean("enable");

    try {
      if (enable) {
        interaction.guild.channels.cache.forEach(channel => {
          if (channel.isTextBased()) {
            channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
              SendMessages: false,
              AddReactions: false
            });
          }
        });
        await interaction.reply({content: "Panic mode enabled. Server is now on lockdown.", ephemeral: true});
      } else {
        interaction.guild.channels.cache.forEach(channel => {
          if (channel.isTextBased()) {
            channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
              SendMessages: null,
              AddReactions: null
            });
          }
        });
        await interaction.reply({content: "Panic mode disabled. Server is now back to normal.", ephemeral: true});
      }
    } catch (error) {
      console.error(error);
      await interaction.reply({content: "An error occurred while trying to toggle panic mode.", ephemeral: true});
    }
  },
};