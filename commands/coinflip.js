const {SlashCommandBuilder, EmbedBuilder} = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("coinflip")
    .setDescription("Flips a coin."),

  async execute(interaction) {
    const result = Math.random() < 0.5 ? "Heads" : "Tails";
    const imageUrl = result === "Heads"
      ? "https://i.imgur.com/vH3y3b9.png" // Example Heads image
      : "https://i.imgur.com/wixK1sI.png"; // Example Tails image

    const embed = new EmbedBuilder()
      .setColor(result === "Heads" ? "#E67E22" : "#3498DB")
      .setTitle("Coin Flip")
      .setDescription(`The coin landed on... **${result}**!`)
      .setThumbnail(imageUrl);

    await interaction.reply({embeds: [embed]});
  },
  category: "Fun",
};