const {SlashCommandBuilder, EmbedBuilder} = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("roll")
    .setDescription("Rolls a dice.")
    .addIntegerOption(option =>
      option.setName("sides")
        .setDescription("The number of sides on the dice (defaults to 6).")
        .setMinValue(2)
        .setMaxValue(100)
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const sides = interaction.options.getInteger("sides") || 6;
    const result = Math.floor(Math.random() * sides) + 1;

    const embed = new EmbedBuilder()
      .setColor("#2ECC71")
      .setTitle(`🎲 Dice Roll (1-${sides})`)
      .setDescription(`You rolled a **${result}**!`);

    await interaction.editReply({embeds: [embed]});
  },
};