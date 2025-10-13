const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ChannelType} = require("discord.js");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Deletes a specified number of messages from a channel.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
    .addIntegerOption(option =>
      option.setName("amount")
        .setDescription("The number of messages to delete (1-100).")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    )
    .addUserOption(option =>
      option.setName("user")
        .setDescription("Only delete messages from this user.")
    ),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});

    const amount = interaction.options.getInteger("amount");
    const targetUser = interaction.options.getUser("user");
    const channel = interaction.channel;

    if (channel.type !== ChannelType.GuildText) {
      return interaction.editReply("This command can only be used in text channels.");
    }

    try {
      let messagesToDelete;
      const fetchedMessages = await channel.messages.fetch({limit: amount});

      if (targetUser) {
        messagesToDelete = fetchedMessages.filter(msg => msg.author.id === targetUser.id);
      } else {
        messagesToDelete = fetchedMessages;
      }

      if (messagesToDelete.size === 0) {
        return interaction.editReply("No messages found to delete with the specified criteria.");
      }

      const deleted = await channel.bulkDelete(messagesToDelete, true);

      const replyEmbed = new EmbedBuilder()
        .setColor("#57F287")
        .setDescription(`✅ Successfully deleted **${deleted.size}** message(s).`);

      await interaction.editReply({embeds: [replyEmbed]});

    } catch (error) {
      logger.error("[Purge Command Error]", error);
      await interaction.editReply("An error occurred. I may not have permission to delete messages, or the messages are older than 14 days.");
    }
  },
  category: "Utility",
};