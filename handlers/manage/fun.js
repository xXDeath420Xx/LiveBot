"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleCoinflip = handleCoinflip;
exports.handleMeme = handleMeme;
exports.handleRoll = handleRoll;
exports.handleCat = handleCat;
const discord_js_1 = require("discord.js");
const logger_1 = __importDefault(require("../../utils/logger"));
const axios = require("axios");
/**
 * Handles coin flip command
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleCoinflip(interaction) {
    const result = Math.random() < 0.5 ? "Heads" : "Tails";
    const imageUrl = result === "Heads"
        ? "https://i.imgur.com/vH3y3b9.png" // Example Heads image
        : "https://i.imgur.com/wixK1sI.png"; // Example Tails image
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(result === "Heads" ? "#E67E22" : "#3498DB")
        .setTitle("Coin Flip")
        .setDescription(`The coin landed on... **${result}**!`)
        .setThumbnail(imageUrl);
    await interaction.reply({ embeds: [embed] });
}
/**
 * Handles meme command (fetches from Reddit)
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleMeme(interaction) {
    await interaction.deferReply();
    try {
        // Fetching from a popular meme subreddit's JSON endpoint
        const response = await axios.get("https://www.reddit.com/r/memes/random/.json");
        const post = response.data[0].data.children[0].data;
        if (!post || post.over_18) {
            return interaction.editReply("Could not find a suitable meme, please try again.");
        }
        const embed = new discord_js_1.EmbedBuilder()
            .setColor("#FF4500") // Reddit Orange
            .setTitle(post.title)
            .setURL(`https://www.reddit.com${post.permalink}`)
            .setImage(post.url)
            .setFooter({ text: `👍 ${post.score} | 💬 ${post.num_comments} | Posted in r/${post.subreddit}` });
        await interaction.editReply({ embeds: [embed] });
    }
    catch (error) {
        logger_1.default.error("[Meme Command Error]", error);
        await interaction.editReply("Sorry, I couldn't fetch a meme right now. The meme-lords are resting.");
    }
}
/**
 * Handles dice roll command
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleRoll(interaction) {
    await interaction.deferReply();
    const sides = interaction.options.getInteger("sides") || 6;
    const result = Math.floor(Math.random() * sides) + 1;
    const embed = new discord_js_1.EmbedBuilder()
        .setColor("#2ECC71")
        .setTitle(`🎲 Dice Roll (1-${sides})`)
        .setDescription(`You rolled a **${result}**!`);
    await interaction.editReply({ embeds: [embed] });
}
/**
 * Handles cat picture command
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleCat(interaction) {
    await interaction.deferReply();
    try {
        const response = await axios.get('https://api.thecatapi.com/v1/images/search');
        const catImageUrl = response.data[0].url;
        const embed = new discord_js_1.EmbedBuilder()
            .setColor('Random')
            .setTitle('Meow!')
            .setImage(catImageUrl)
            .setFooter({ text: 'Powered by thecatapi.com' });
        await interaction.editReply({ embeds: [embed] });
    }
    catch (error) {
        logger_1.default.error('[Cat Command Error]', error);
        await interaction.editReply('Sorry, I couldn\'t fetch a cat picture right now.');
    }
}
module.exports = {
    handleCoinflip,
    handleMeme,
    handleRoll,
    handleCat,
};
