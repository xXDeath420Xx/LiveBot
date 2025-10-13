const {SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");
const apiChecks = require("../utils/api_checks");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("addteam")
    .setDescription("Adds all members of a Twitch Team to the announcement list for a channel.")
    .addStringOption(option =>
      option.setName("team")
        .setDescription("The name of the Twitch Team (e.g., the \"reeferrealm\" in twitch.tv/team/reeferrealm).")
        .setRequired(true))
    .addChannelOption(option =>
      option.setName("channel")
        .setDescription("The channel where the team members will be announced.")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});

    const teamName = interaction.options.getString("team").toLowerCase();
    const channel = interaction.options.getChannel("channel");
    const guildId = interaction.guild.id;

    const added = [], updated = [], failed = [];

    try {
      const teamMembers = await apiChecks.getTwitchTeamMembers(teamName);
      if (!teamMembers) {
        return interaction.editReply({content: `❌ Could not find a Twitch Team named \\\`${teamName}\\\`. Please check the name and try again.`});
      }
      if (teamMembers.length === 0) {
        return interaction.editReply({content: `ℹ️ The Twitch Team \\\`${teamName}\\\` does not have any members.`});
      }

      for (const member of teamMembers) {
        try {
          await db.execute(
            `INSERT INTO streamers (platform, platform_user_id, username) VALUES ('twitch', ?, ?)
                         ON DUPLICATE KEY UPDATE username = VALUES(username)`,
            [member.user_id, member.user_login]
          );

          const [[streamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?", ["twitch", member.user_id]);

          const [subResult] = await db.execute(
            `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)
                         ON DUPLICATE KEY UPDATE streamer_id = VALUES(streamer_id)`,
            [guildId, streamer.streamer_id, channel.id]
          );

          if (subResult.affectedRows > 1) { // This indicates an UPDATE happened on duplicate key
            updated.push(member.user_login);
          } else {
            added.push(member.user_login);
          }

        } catch (dbError) {
          console.error(`Error processing team member ${member.user_login}:`, dbError);
          failed.push(`${member.user_login} (DB Error)`);
        }
      }

      const embed = new EmbedBuilder()
        .setTitle(`Twitch Team Import Report for \\"${teamName}\\"`)
        .setDescription(`All members have been added/updated for announcements in ${channel}.`)
        .setColor("#5865F2")
        .addFields(
          {name: `✅ Added (${added.length})`, value: added.length > 0 ? added.join(", ").substring(0, 1020) : "None"},
          {name: `🔄 Updated/Already Existed (${updated.length})`, value: updated.length > 0 ? updated.join(", ").substring(0, 1020) : "None"},
          {name: `❌ Failed (${failed.length})`, value: failed.length > 0 ? failed.join(", ") : "None"}
        )
        .setTimestamp();

      await interaction.editReply({embeds: [embed]});

    } catch (error) {
      console.error("AddTeam Command Error:", error);
      await interaction.editReply({content: "A critical error occurred while executing the command."});
    }
  },
  category: "Team Management",
};