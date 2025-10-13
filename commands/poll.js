const {SlashCommandBuilder, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

// Time string parser (e.g., "1m", "1h", "2d")
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

const numberEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

module.exports = {
  data: new SlashCommandBuilder()
    .setName("poll")
    .setDescription("Creates a poll for users to vote on.")
    .addStringOption(option => option.setName("question").setDescription("The poll question.").setRequired(true))
    .addStringOption(option => option.setName("duration").setDescription("How long the poll should last (e.g., 5m, 1h, 1d).").setRequired(true))
    .addStringOption(option => option.setName("choice1").setDescription("The first choice.").setRequired(true))
    .addStringOption(option => option.setName("choice2").setDescription("The second choice.").setRequired(true))
    .addStringOption(option => option.setName("choice3").setDescription("The third choice."))
    .addStringOption(option => option.setName("choice4").setDescription("The fourth choice."))
    .addStringOption(option => option.setName("choice5").setDescription("The fifth choice."))
    .addStringOption(option => option.setName("choice6").setDescription("The sixth choice."))
    .addStringOption(option => option.setName("choice7").setDescription("The seventh choice."))
    .addStringOption(option => option.setName("choice8").setDescription("The eighth choice."))
    .addStringOption(option => option.setName("choice9").setDescription("The ninth choice."))
    .addStringOption(option => option.setName("choice10").setDescription("The tenth choice.")),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const question = interaction.options.getString("question");
    const duration = interaction.options.getString("duration");
    const endsAt = parseTime(duration);

    if (!endsAt) {
      return interaction.editReply({content: "Invalid duration format. Use formats like `30m`, `2h`, `1d`."});
    }

    const choices = [];
    for (let i = 1; i <= 10; i++) {
      const choice = interaction.options.getString(`choice${i}`);
      if (choice) {
        choices.push(choice);
      }
    }

    if (choices.length < 2) {
      return interaction.editReply({content: "Please provide at least two choices for the poll."});
    }

    try {
      const embed = new EmbedBuilder()
        .setColor("#3498DB")
        .setAuthor({name: `${interaction.user.tag} started a poll`, iconURL: interaction.user.displayAvatarURL()})
        .setTitle(question)
        .setDescription(choices.map((c, i) => `${numberEmojis[i]} ${c}`).join("\n\n"))
        .addFields({name: "Ends", value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>`})
        .setTimestamp();

      const pollMessage = await interaction.channel.send({embeds: [embed]});
      await interaction.editReply({content: "Poll created!"});

      // Add reactions
      for (let i = 0; i < choices.length; i++) {
        await pollMessage.react(numberEmojis[i]);
      }

      // Save to database
      await db.execute(
        "INSERT INTO polls (guild_id, channel_id, message_id, question, options, ends_at) VALUES (?, ?, ?, ?, ?, ?)",
        [interaction.guild.id, interaction.channel.id, pollMessage.id, question, JSON.stringify(choices), endsAt]
      );
    } catch (error) {
      logger.error("[Poll Command Error]", error);
      await interaction.editReply({content: "An error occurred while creating the poll."});
    }
  },
};