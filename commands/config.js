const {SlashCommandBuilder, ChannelType, PermissionsBitField, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");
const {getAvatarUploadChannel} = require("../utils/channel-helpers.js");
const {logAuditEvent} = require("../utils/audit-log.js");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configures all features for the bot on this server.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addSubcommandGroup(group =>
      group
        .setName("music")
        .setDescription("Configure the music system.")
        .addSubcommand(subcommand =>
          subcommand
            .setName("dj-role")
            .setDescription("Sets the DJ role. Users with this role can manage the music queue.")
            .addRoleOption(option => option.setName("role").setDescription("The role to set as the DJ role.").setRequired(true))
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName("customize")
        .setDescription("Customize the appearance of the bot and its messages.")
        .addSubcommand(subcommand =>
          subcommand
            .setName("streamer")
            .setDescription("Sets a custom name, avatar, or message for a specific streamer's announcements.")
            .addStringOption(option => option.setName("platform").setDescription("The platform of the streamer.").setRequired(true).addChoices({name: "Twitch", value: "twitch"}, {name: "Kick", value: "kick"}, {name: "YouTube", value: "youtube"}))
            .addStringOption(option => option.setName("username").setDescription("The username of the streamer.").setRequired(true).setAutocomplete(true))
        )
    ),

  async autocomplete(interaction) {
    const focusedOption = interaction.options.getFocused(true);
    if (interaction.options.getSubcommand() === "streamer" && focusedOption.name === "username") {
      const focusedValue = focusedOption.value;
      try {
        const [streamers] = await db.execute(
          `SELECT DISTINCT s.username
           FROM streamers s
                    JOIN subscriptions sub ON s.streamer_id = sub.streamer_id
           WHERE sub.guild_id = ?
             AND s.username LIKE ?
           LIMIT 25`,
          [interaction.guild.id, `${focusedValue}%`]
        );
        await interaction.respond(streamers.map(s => ({name: s.username, value: s.username})));
      } catch (error) {
        logger.error("[Config Command Autocomplete Error]", error);
        await interaction.respond([]);
      }
    }
  },

  async execute(interaction) {
    const subcommandGroup = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();

    if (subcommandGroup === "music") {
      if (subcommand === "dj-role") {
        const role = interaction.options.getRole("role");
        const guildId = interaction.guild.id;

        try {
          await db.execute("INSERT INTO music_config (guild_id, dj_role_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE dj_role_id = ?", [guildId, role.id, role.id]);
          await interaction.reply({content: `✅ The DJ role has been set to <@&${role.id}>.`, ephemeral: true});
        } catch (error) {
          logger.error("[Config DJ Role Error]", error);
          await interaction.reply({content: "❌ An error occurred while setting the DJ role.", ephemeral: true});
        }
      }
    }
    // ... other execute logic
  },
};