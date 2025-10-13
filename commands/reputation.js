const {SlashCommandBuilder, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

const REP_COOLDOWN_HOURS = 24;

module.exports = {
  data: new SlashCommandBuilder()
    .setName("rep")
    .setDescription("Manage reputation points.")
    .addSubcommand(subcommand =>
      subcommand
        .setName("give")
        .setDescription("Give a reputation point to a user.")
        .addUserOption(option => option.setName("user").setDescription("The user to give reputation to.").setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("check")
        .setDescription("Check a user's reputation score.")
        .addUserOption(option => option.setName("user").setDescription("The user to check (defaults to you)."))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("leaderboard")
        .setDescription("Shows the reputation leaderboard for the server.")
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    try {
      if (subcommand === "give") {
        const targetUser = interaction.options.getUser("user");
        const giverUser = interaction.user;

        if (targetUser.id === giverUser.id) {
          return interaction.editReply({content: "You can't give reputation to yourself.", ephemeral: true});
        }
        if (targetUser.bot) {
          return interaction.editReply({content: "You can't give reputation to a bot.", ephemeral: true});
        }

        const [[giverRep]] = await db.execute("SELECT last_rep_timestamp FROM reputation WHERE guild_id = ? AND user_id = ?", [guildId, giverUser.id]);

        if (giverRep && giverRep.last_rep_timestamp) {
          const cooldownEnd = new Date(giverRep.last_rep_timestamp).getTime() + (REP_COOLDOWN_HOURS * 60 * 60 * 1000);
          if (Date.now() < cooldownEnd) {
            return interaction.editReply({content: `You can give reputation again <t:${Math.floor(cooldownEnd / 1000)}:R>.`, ephemeral: true});
          }
        }

        // Add rep point to target
        await db.execute("INSERT INTO reputation (guild_id, user_id, rep_points) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE rep_points = rep_points + 1", [guildId, targetUser.id]);

        // Update giver's timestamp
        await db.execute("INSERT INTO reputation (guild_id, user_id, last_rep_timestamp) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE last_rep_timestamp = NOW()", [guildId, giverUser.id]);

        await interaction.editReply(`${giverUser.username} has given a reputation point to ${targetUser.username}!`);

      } else if (subcommand === "check") {
        const targetUser = interaction.options.getUser("user") || interaction.user;
        const [[rep]] = await db.execute("SELECT rep_points FROM reputation WHERE guild_id = ? AND user_id = ?", [guildId, targetUser.id]);
        const points = rep ? rep.rep_points : 0;

        const embed = new EmbedBuilder()
          .setColor("#F1C40F")
          .setAuthor({name: targetUser.username, iconURL: targetUser.displayAvatarURL()})
          .setDescription(`⭐ **${points}** reputation points.`);
        await interaction.editReply({embeds: [embed]});

      } else if (subcommand === "leaderboard") {
        const [leaderboard] = await db.execute("SELECT user_id, rep_points FROM reputation WHERE guild_id = ? AND rep_points > 0 ORDER BY rep_points DESC LIMIT 10", [guildId]);

        if (leaderboard.length === 0) {
          return interaction.editReply("No one has any reputation points yet!");
        }

        const description = leaderboard.map((entry, index) => {
          return `${index + 1}. <@${entry.user_id}> - **${entry.rep_points}** points`;
        }).join("\n");

        const embed = new EmbedBuilder()
          .setTitle(`⭐ Reputation Leaderboard`)
          .setColor("#F1C40F")
          .setDescription(description);
        await interaction.editReply({embeds: [embed]});
      }
    } catch (error) {
      logger.error("[Reputation Command Error]", error);
      await interaction.editReply({content: "An error occurred while handling reputation.", ephemeral: true});
    }
  },
  category: "Community",
};