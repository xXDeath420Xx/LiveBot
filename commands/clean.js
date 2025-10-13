const {SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder} = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("clean")
    .setDescription("Advanced message cleaning with filters.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
    .addIntegerOption(option =>
      option.setName("amount")
        .setDescription("Number of messages to scan (up to 100).")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    )
    .addStringOption(option =>
      option.setName("filter")
        .setDescription("The type of message to clean.")
        .setRequired(true)
        .addChoices(
          {name: "All", value: "all"},
          {name: "User", value: "user"},
          {name: "Bots", value: "bots"},
          {name: "Contains Text", value: "text"},
          {name: "Has Link", value: "links"},
          {name: "Has Attachment", value: "files"}
        )
    )
    .addUserOption(option =>
      option.setName("user")
        .setDescription("The user whose messages to delete (required if filter is \"User\").")
    )
    .addStringOption(option =>
      option.setName("text")
        .setDescription("The text to search for (required if filter is \"Contains Text\").")
    ),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});

    const amount = interaction.options.getInteger("amount");
    const filter = interaction.options.getString("filter");
    const targetUser = interaction.options.getUser("user");
    const searchText = interaction.options.getString("text");
    const channel = interaction.channel;

    if (channel.type !== ChannelType.GuildText) {
      return interaction.editReply("This command can only be used in text channels.");
    }

    if (filter === "user" && !targetUser) {
      return interaction.editReply("You must specify a user when using the \"User\" filter.");
    }
    if (filter === "text" && !searchText) {
      return interaction.editReply("You must specify text to search for when using the \"Contains Text\" filter.");
    }

    try {
      const fetchedMessages = await channel.messages.fetch({limit: amount});
      let messagesToDelete;

      switch (filter) {
        case "all":
          messagesToDelete = fetchedMessages;
          break;
        case "user":
          messagesToDelete = fetchedMessages.filter(msg => msg.author.id === targetUser.id);
          break;
        case "bots":
          messagesToDelete = fetchedMessages.filter(msg => msg.author.bot);
          break;
        case "text":
          messagesToDelete = fetchedMessages.filter(msg => msg.content.toLowerCase().includes(searchText.toLowerCase()));
          break;
        case "links":
          messagesToDelete = fetchedMessages.filter(msg => /https?:\/\/[^\s]+/g.test(msg.content));
          break;
        case "files":
          messagesToDelete = fetchedMessages.filter(msg => msg.attachments.size > 0);
          break;
        default:
          messagesToDelete = fetchedMessages;
      }

      if (messagesToDelete.size === 0) {
        return interaction.editReply("No messages found matching the specified filter.");
      }

      const deleted = await channel.bulkDelete(messagesToDelete, true);

      const replyEmbed = new EmbedBuilder()
        .setColor("#57F287")
        .setDescription(`✅ Successfully cleaned **${deleted.size}** message(s) using the \`${filter}\` filter.`);

      await interaction.editReply({embeds: [replyEmbed]});

    } catch (error) {
      console.error("[Clean Command Error]", error);
      await interaction.editReply("An error occurred. I may not have permission to delete messages, or the messages are older than 14 days.");
    }
  },
};