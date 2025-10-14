const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");
const {endGiveaway} = require("../core/giveaway-manager");

const REP_COOLDOWN_HOURS = 24;

function parseTime(timeStr) {
  const match = timeStr.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    return null;
  }
  const value = parseInt(match[1]);
  const unit = match[2];
  let seconds = 0;
  switch (unit) {
    case "s":
      seconds = value;
      break;
    case "m":
      seconds = value * 60;
      break;
    case "h":
      seconds = value * 60 * 60;
      break;
    case "d":
      seconds = value * 24 * 60 * 60;
      break;
  }
  return new Date(Date.now() + seconds * 1000);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("fun")
    .setDescription("Provides a collection of fun commands.")
    .addSubcommandGroup(group =>
      group
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
    )
    .addSubcommandGroup(group =>
        group
            .setName("leaderboard")
            .setDescription("Displays different leaderboards.")
            .addSubcommand(subcommand =>
                subcommand
                    .setName("rep")
                    .setDescription("Shows the reputation leaderboard.")
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName("xp")
                    .setDescription("Displays the server's top members by XP.")
            )
    )
    .addSubcommandGroup(group =>
        group
            .setName("giveaway")
            .setDescription("Manage server giveaways.")
            .addSubcommand(subcommand =>
              subcommand
                .setName("start")
                .setDescription("Starts a new giveaway in the current channel.")
                .addStringOption(option => option.setName("duration").setDescription("Duration of the giveaway (e.g., 10m, 2h, 1d).").setRequired(true))
                .addIntegerOption(option => option.setName("winners").setDescription("The number of winners.").setRequired(true).setMinValue(1))
                .addStringOption(option => option.setName("prize").setDescription("What the winner(s) will receive.").setRequired(true))
            )
            .addSubcommand(subcommand =>
              subcommand
                .setName("reroll")
                .setDescription("Selects a new winner for a previous giveaway.")
                .addStringOption(option => option.setName("message-id").setDescription("The message ID of the giveaway to reroll.").setRequired(true))
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName("rank")
            .setDescription("Check a user's current rank and XP.")
            .addUserOption(option =>
                option.setName("user")
                    .setDescription("The user to check the rank of (defaults to you).")
            )
    ),
  async execute(interaction) {
    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (subcommandGroup === "rep") {
        await interaction.deferReply();
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
            }
        } catch (error) {
            logger.error("[Reputation Command Error]", error);
            await interaction.editReply({content: "An error occurred while handling reputation.", ephemeral: true});
        }
    } else if (subcommandGroup === "leaderboard") {
        await interaction.deferReply();
        if (subcommand === 'rep') {
            try {
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
            } catch (error) {
                logger.error("[Reputation Leaderboard Error]", error);
                await interaction.editReply({content: "An error occurred while fetching the reputation leaderboard.", ephemeral: true});
            }
        }
    } else if (subcommand === 'rank') {
        await interaction.deferReply();

        const targetUser = interaction.options.getUser("user") || interaction.user;

        try {
          const [[user]] = await db.execute("SELECT * FROM user_levels WHERE guild_id = ? AND user_id = ?", [guildId, targetUser.id]);

          if (!user) {
            return interaction.editReply(`${targetUser.tag} has not earned any XP yet.`);
          }

          const xpForNextLevel = 5 * (user.level ** 2) + 50 * user.level + 100;

          // Fetch rank by ordering users by XP
          const [allUsers] = await db.execute("SELECT user_id FROM user_levels WHERE guild_id = ? ORDER BY level DESC, xp DESC", [guildId]);
          const rank = allUsers.findIndex(u => u.user_id === targetUser.id) + 1;

          // Fetch next role reward
          const [[nextReward]] = await db.execute("SELECT level, role_id FROM role_rewards WHERE guild_id = ? AND level > ? ORDER BY level ASC LIMIT 1", [guildId, user.level]);

          const embed = new EmbedBuilder()
            .setColor("#5865F2")
            .setAuthor({name: targetUser.username, iconURL: targetUser.displayAvatarURL()})
            .setTitle(`Rank #${rank}`)
            .addFields(
              {name: "Level", value: `**${user.level}**`, inline: true},
              {name: "XP", value: `**${user.xp} / ${xpForNextLevel}**`, inline: true}
            );

          if (nextReward) {
            embed.addFields({name: "Next Role Reward", value: `<@&${nextReward.role_id}> at Level **${nextReward.level}**`});
          }

          await interaction.editReply({embeds: [embed]});
        } catch (error) {
          logger.error("[Rank Command Error]", error);
          await interaction.editReply({content: "An error occurred while fetching the rank information."});
        }
    }
  },
  category: "Fun",
};