const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("embed")
    .setDescription("Post a pre-saved embed from the dashboard builder.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
    .addStringOption(option =>
      option.setName("name")
        .setDescription("The name of the saved embed to post.")
        .setRequired(true)
        .setAutocomplete(true))
    .addChannelOption(option =>
      option.setName("channel")
        .setDescription("The channel to post the embed in. Defaults to the current channel.")
        .setRequired(false)),

  async autocomplete(interaction) {
    const focusedValue = interaction.options.getFocused();
    try {
      const [embeds] = await db.execute("SELECT embed_name FROM saved_embeds WHERE guild_id = ? AND embed_name LIKE ? LIMIT 25", [interaction.guild.id, `${focusedValue}%`]);
      await interaction.respond(embeds.map(e => ({name: e.embed_name, value: e.embed_name})));
    } catch (error) {
      await interaction.respond([]);
    }
  },

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const embedName = interaction.options.getString("name");
    const channel = interaction.options.getChannel("channel") || interaction.channel;

    try {
      const [[savedEmbed]] = await db.execute("SELECT embed_json FROM saved_embeds WHERE guild_id = ? AND embed_name = ?", [interaction.guild.id, embedName]);

      if (!savedEmbed) {
        return interaction.editReply(`❌ An embed with the name \`${embedName}\` was not found.`);
      }

      const embedData = JSON.parse(savedEmbed.embed_json);
      const embed = new EmbedBuilder(embedData);

      await channel.send({embeds: [embed]});
      await interaction.editReply(`✅ Embed \`${embedName}\` has been posted in ${channel}.`);

    } catch (error) {
      if (error.code === "ER_NO_SUCH_TABLE") {
        await interaction.editReply("The database tables for this feature have not been created yet. Please ask the bot owner to update the schema.");
      } else {
        logger.error("[Embed Command Error]", error);
        await interaction.editReply("An error occurred while trying to post the embed. The embed JSON might be invalid.");
      }
    }
  },
  category: "Utility",
};