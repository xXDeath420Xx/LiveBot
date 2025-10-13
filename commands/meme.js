const {SlashCommandBuilder, EmbedBuilder} = require("discord.js");
const axios = require("axios");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("meme")
    .setDescription("Sends a random meme from Reddit."),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      // Fetching from a popular meme subreddit's JSON endpoint
      const response = await axios.get("https://www.reddit.com/r/memes/random/.json");
      const post = response.data[0].data.children[0].data;

      if (!post || post.over_18) {
        return interaction.editReply("Could not find a suitable meme, please try again.");
      }

      const embed = new EmbedBuilder()
        .setColor("#FF4500") // Reddit Orange
        .setTitle(post.title)
        .setURL(`https://www.reddit.com${post.permalink}`)
        .setImage(post.url)
        .setFooter({text: `👍 ${post.score} | 💬 ${post.num_comments} | Posted in r/${post.subreddit}`});

      await interaction.editReply({embeds: [embed]});

    } catch (error) {
      console.error("[Meme Command Error]", error);
      await interaction.editReply("Sorry, I couldn't fetch a meme right now. The meme-lords are resting.");
    }
  },
  category: "Fun",
};