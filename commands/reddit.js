const {SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");
const axios = require("axios");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("reddit")
    .setDescription("Manage Reddit feeds for the server.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName("add")
        .setDescription("Adds a new Reddit feed to a channel.")
        .addStringOption(option => option.setName("subreddit").setDescription("The name of the subreddit (e.g., announcements).").setRequired(true))
        .addChannelOption(option => option.setName("channel").setDescription("The channel to post updates in.").addChannelTypes(ChannelType.GuildText).setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("remove")
        .setDescription("Removes a Reddit feed.")
        .addStringOption(option => option.setName("subreddit").setDescription("The subreddit to remove.").setRequired(true).setAutocomplete(true))
        .addChannelOption(option => option.setName("channel").setDescription("The channel the feed is in.").addChannelTypes(ChannelType.GuildText).setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("list")
        .setDescription("Lists all active Reddit feeds on the server.")
    ),

  async autocomplete(interaction) {
    if (interaction.options.getSubcommand() === "remove") {
      const focusedValue = interaction.options.getFocused();
      try {
        const [feeds] = await db.execute("SELECT DISTINCT subreddit FROM reddit_feeds WHERE guild_id = ? AND subreddit LIKE ?", [interaction.guild.id, `${focusedValue}%`]);
        await interaction.respond(feeds.map(feed => ({name: feed.subreddit, value: feed.subreddit})));
      } catch (error) {
        logger.error("[Reddit Command Autocomplete Error]", error);
        await interaction.respond([]); // Respond with an empty array on error
      }
    }
  },

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    try {
      if (subcommand === "add") {
        const subreddit = interaction.options.getString("subreddit").toLowerCase();
        const channel = interaction.options.getChannel("channel");

        // Check if subreddit exists
        try {
          await axios.get(`https://www.reddit.com/r/${subreddit}/new.json?limit=1`);
        } catch (e) {
          logger.warn(`[Reddit Command] Subreddit r/${subreddit} not found or inaccessible: ${e.message}`);
          return interaction.editReply(`❌ The subreddit \`r/${subreddit}\` does not seem to exist or is private.`);
        }

        await db.execute("INSERT INTO reddit_feeds (guild_id, subreddit, channel_id) VALUES (?, ?, ?)", [guildId, subreddit, channel.id]);
        await interaction.editReply(`✅ Successfully created a feed for \`r/${subreddit}\` in ${channel}.`);
      } else if (subcommand === "remove") {
        const subreddit = interaction.options.getString("subreddit");
        const channel = interaction.options.getChannel("channel");
        const [result] = await db.execute("DELETE FROM reddit_feeds WHERE guild_id = ? AND subreddit = ? AND channel_id = ?", [guildId, subreddit, channel.id]);

        if (result.affectedRows > 0) {
          await interaction.editReply(`🗑️ Removed the feed for \`r/${subreddit}\` from ${channel}.`);
        } else {
          await interaction.editReply("❌ No feed found for that subreddit in that channel.");
        }
      } else if (subcommand === "list") {
        const [feeds] = await db.execute("SELECT subreddit, channel_id FROM reddit_feeds WHERE guild_id = ?", [guildId]);
        if (feeds.length === 0) {
          return interaction.editReply("There are no Reddit feeds configured on this server.");
        }
        const description = feeds.map(feed => `\`r/${feed.subreddit}\` -> <#${feed.channel_id}>`).join("\n");
        const embed = new EmbedBuilder()
          .setTitle("Active Reddit Feeds")
          .setColor("#FF4500")
          .setDescription(description);
        await interaction.editReply({embeds: [embed]});
      }
    } catch (error) {
      logger.error("[Reddit Command Error]", error);
      if (error.code === "ER_DUP_ENTRY") {
        await interaction.editReply("A feed for that subreddit in that channel already exists.");
      } else {
        await interaction.editReply("An error occurred while managing Reddit feeds.");
      }
    }
  },
  category: "Utility",
};