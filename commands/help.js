const {SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle} = require("discord.js");
const fs = require("fs");
const path = require("path");
require("dotenv").config(); // Ensure dotenv is loaded
const logger = require("../utils/logger"); // Assuming logger is available

module.exports = {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Displays a list of available commands and their descriptions.")
    .addStringOption(option =>
      option.setName("command")
        .setDescription("Get detailed information about a specific command.")
        .setRequired(false)),

  async execute(interaction) {
    const commandName = interaction.options.getString("command");
    const commandsPath = path.join(__dirname); // Assumes commands are in the same directory
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith(".js"));

    const commands = commandFiles.map(file => {
      try {
        const command = require(`./${file}`);
        return command.data.toJSON();
      } catch (e) {
        logger.error(`[Help Command] Error loading command file ${file}:`, {error: e.stack});
        return null; // Return null for failed commands
      }
    }).filter(Boolean); // Filter out nulls

    const dashboardUrl = process.env.DASHBOARD_URL || "https://certifriedmultitool.com/";
    const supportServerInvite = process.env.SUPPORT_SERVER_INVITE || "https://discord.gg/mJfbDgWA7z";

    // If a specific command is requested
    if (commandName) {
      const command = commands.find(cmd => cmd.name === commandName.toLowerCase());
      if (!command) {
        return interaction.reply({content: "That command does not exist.", ephemeral: true});
      }

      const embed = new EmbedBuilder()
        .setColor("#7289da")
        .setTitle(`Command: /${command.name}`)
        .setDescription(command.description)
        .setTimestamp();

      if (command.options && command.options.length > 0) {
        const optionsField = command.options.map(opt => {
          return `\`${opt.name}\`: ${opt.description} ${opt.required ? "(Required)" : ""}`;
        }).join("\n");
        embed.addFields({name: "Options", value: optionsField});
      }

      return interaction.reply({embeds: [embed], ephemeral: true});
    }

    // If no specific command is requested, show the full list
    const categories = {
      "Core": ["help", "stats", "status", "ping", "global-reinit", "reinit", "reset-database"],
      "Configuration": ["setup", "config", "setchannel", "setliverole", "customize-bot", "customize-channel", "customize-streamer", "permissions"],
      "Streamer Management": ["addstreamer", "removestreamer", "editstreamer", "liststreamers", "massaddstreamer", "massremovestreamer", "importcsv", "exportcsv", "clearstreamers"],
      "Team Management": ["addteam", "removeteam", "subscribe-team", "unsubscribe-team", "importteamcsv"],
      "Moderation": ["ban", "kick", "mute", "unmute", "warn", "clear-infractions", "purge", "quarantine", "slowmode", "lock", "unlock"],
      "Fun": ["8ball", "cat", "coinflip", "meme", "roll", "reddit", "tiktok"],
      "Utilities": ["define", "find", "invites", "serverinfo", "userinfo", "weather", "schedule", "record", "scan", "tag", "temp-channel", "ticket", "welcome"],
      "Music": ["play", "pause", "resume", "stop", "queue", "nowplaying", "loop", "lyrics", "music-search"],
      "Feeds": ["youtube-feed", "twitter-feed", "trovo"],
      "Events": ["giveaway", "poll", "remind", "reaction-roles", "starboard"],
    };

    const embed = new EmbedBuilder()
      .setColor("#7289da")
      .setTitle("CertiFried Announcer Help")
      .setDescription("Here is a list of my primary commands. For a full list and easier management, please visit the web dashboard.")
      .setTimestamp();

    for (const category in categories) {
      const commandList = categories[category]
        .map(cmdName => {
          const cmd = commands.find(c => c.name === cmdName);
          return cmd ? `\`/${cmd.name}\` - ${cmd.description}` : "";
        })
        .filter(Boolean) // Remove any commands not found
        .join("\n");

      if (commandList) {
        embed.addFields({name: `🔹 ${category}`, value: commandList});
      }
    }

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setLabel("Dashboard")
          .setStyle(ButtonStyle.Link)
          .setURL(dashboardUrl)
          .setEmoji("🌐"),
        new ButtonBuilder()
          .setLabel("Support Server")
          .setStyle(ButtonStyle.Link)
          .setURL(supportServerInvite)
          .setEmoji("🤝")
      );

    await interaction.reply({embeds: [embed], components: [row]});
  },
  category: "Utility",
};