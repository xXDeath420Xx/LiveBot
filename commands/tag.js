const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("tag")
    .setDescription("Shows a tag. Use subcommands to manage tags.")
    .addSubcommand(subcommand =>
      subcommand.setName("show")
        .setDescription("Shows a specific tag.")
        .addStringOption(option => option.setName("name").setDescription("The name of the tag to show.").setAutocomplete(true).setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand.setName("create")
        .setDescription("Creates a new tag.")
        .addStringOption(option => option.setName("name").setDescription("The name for the new tag.").setRequired(true))
        .addStringOption(option => option.setName("content").setDescription("The content of the tag.").setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand.setName("edit")
        .setDescription("Edits a tag you created.")
        .addStringOption(option => option.setName("name").setDescription("The name of the tag to edit.").setAutocomplete(true).setRequired(true))
        .addStringOption(option => option.setName("content").setDescription("The new content for the tag.").setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand.setName("delete")
        .setDescription("Deletes a tag you created.")
        .addStringOption(option => option.setName("name").setDescription("The name of the tag to delete.").setAutocomplete(true).setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand.setName("list")
        .setDescription("Lists all tags on the server.")
    )
    .addSubcommand(subcommand =>
      subcommand.setName("info")
        .setDescription("Shows info about a specific tag.")
        .addStringOption(option => option.setName("name").setDescription("The name of the tag.").setAutocomplete(true).setRequired(true))
    ),

  async autocomplete(interaction) {
    const focusedValue = interaction.options.getFocused();
    const [tags] = await db.execute("SELECT tag_name FROM tags WHERE guild_id = ? AND tag_name LIKE ? LIMIT 25", [interaction.guild.id, `${focusedValue}%`]);
    await interaction.respond(tags.map(tag => ({name: tag.tag_name, value: tag.tag_name})));
  },

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand(true); // Now always expect a subcommand
    let tagName;

    // Determine tagName based on subcommand
    if (subcommand === "list") {
      tagName = null; // No tag name for list subcommand
    } else {
      tagName = interaction.options.getString("name");
    }

    try {
      await interaction.deferReply({ephemeral: true});

      if (subcommand === "show") {
        const [[tag]] = await db.execute("SELECT tag_content FROM tags WHERE guild_id = ? AND tag_name = ?", [interaction.guild.id, tagName]);
        if (!tag) {
          return interaction.editReply({content: `Tag \`${tagName}\` not found.`, ephemeral: true});
        }
        return interaction.editReply(tag.tag_content);
      } else if (subcommand === "create") {
        const content = interaction.options.getString("content");
        await db.execute("INSERT INTO tags (guild_id, tag_name, tag_content, creator_id) VALUES (?, ?, ?, ?)", [interaction.guild.id, tagName, content, interaction.user.id]);
        await interaction.editReply(`✅ Tag \`${tagName}\` created successfully.`);
      } else if (subcommand === "edit") {
        const newContent = interaction.options.getString("content");
        const [result] = await db.execute("UPDATE tags SET tag_content = ? WHERE guild_id = ? AND tag_name = ? AND creator_id = ?", [newContent, interaction.guild.id, tagName, interaction.user.id]);
        if (result.affectedRows > 0) {
          await interaction.editReply(`✅ Tag \`${tagName}\` updated.`);
        } else {
          await interaction.editReply(`❌ Tag \`${tagName}\` not found, or you don't have permission to edit it.`);
        }
      } else if (subcommand === "delete") {
        const hasAdminPerms = interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild);
        let query = "DELETE FROM tags WHERE guild_id = ? AND tag_name = ? AND creator_id = ?";
        let params = [interaction.guild.id, tagName, interaction.user.id];

        if (hasAdminPerms) { // Admins can delete any tag
          query = "DELETE FROM tags WHERE guild_id = ? AND tag_name = ?";
          params = [interaction.guild.id, tagName];
        }

        const [result] = await db.execute(query, params);
        if (result.affectedRows > 0) {
          await interaction.editReply(`🗑️ Tag \`${tagName}\` deleted.`);
        } else {
          await interaction.editReply(`❌ Tag \`${tagName}\` not found, or you don't have permission to delete it.`);
        }
      } else if (subcommand === "list") {
        const [tags] = await db.execute("SELECT tag_name FROM tags WHERE guild_id = ? ORDER BY tag_name ASC", [interaction.guild.id]);
        if (tags.length === 0) {
          return interaction.editReply("This server has no tags.");
        }
        const tagList = tags.map(t => `\`${t.tag_name}\``).join(", ");
        const embed = new EmbedBuilder().setTitle(`Tags on ${interaction.guild.name}`).setDescription(tagList.substring(0, 4000));
        await interaction.editReply({embeds: [embed]});
      } else if (subcommand === "info") {
        const [[tag]] = await db.execute("SELECT creator_id, created_at FROM tags WHERE guild_id = ? AND tag_name = ?", [interaction.guild.id, tagName]);
        if (!tag) {
          return interaction.editReply(`Tag \`${tagName}\` not found.`);
        }
        const creator = await interaction.client.users.fetch(tag.creator_id);
        const embed = new EmbedBuilder().setTitle(`Info for tag: ${tagName}`)
          .addFields(
            {name: "Creator", value: `${creator.tag} (${creator.id})`},
            {name: "Created", value: `<t:${Math.floor(new Date(tag.created_at).getTime() / 1000)}:R>`}
          );
        await interaction.editReply({embeds: [embed]});
      }

    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") {
        await interaction.editReply(`A tag with the name \`${tagName}\` already exists.`);
      } else {
        console.error("[Tag Command Error]", error);
        await interaction.editReply('An error occurred while managing tags.');
      }
    }
  },
  category: "Utility",
};