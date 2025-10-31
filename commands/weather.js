"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const logger_1 = __importDefault(require("../utils/logger"));
const data = new discord_js_1.SlashCommandBuilder()
    .setName("weather")
    .setDescription("Weather alerts and notifications")
    .addSubcommand(sub => sub
    .setName("setlocation")
    .setDescription("Set your location for weather alerts")
    .addStringOption(opt => opt
    .setName("zipcode")
    .setDescription("Your 5-digit US ZIP code")
    .setRequired(true)))
    .addSubcommand(sub => sub
    .setName("location")
    .setDescription("View your saved location"))
    .addSubcommand(sub => sub
    .setName("remove")
    .setDescription("Remove your location"))
    .addSubcommand(sub => sub
    .setName("config")
    .setDescription("Configure weather alerts (Admin only)")
    .addBooleanOption(opt => opt
    .setName("enabled")
    .setDescription("Enable weather alerts")
    .setRequired(true)));
async function execute(interaction) {
    const client = interaction.client;
    const weatherManager = client.weatherManager;
    if (!weatherManager) {
        await interaction.reply({ content: "❌ Weather system is not available.", ephemeral: true });
        return;
    }
    const subcommand = interaction.options.getSubcommand();
    try {
        if (subcommand === "setlocation") {
            const zipcode = interaction.options.getString("zipcode", true);
            await interaction.deferReply({ ephemeral: true });
            try {
                const location = await weatherManager.setUserLocation(interaction.user.id, zipcode);
                // Handle both possible property names
                const zoneId = location.zoneId || location.zone_id;
                const city = location.city || location.city_name;
                await interaction.editReply({
                    content: `📍 Your alert zone is now **${zoneId} (${city}, ${location.state})**.\nYou'll be notified when weather alerts affect your area.`
                });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                await interaction.editReply({
                    content: `❌ ${errorMessage}\nPlease check your ZIP code and try again.`
                });
            }
        }
        else if (subcommand === "location") {
            const location = await weatherManager.getUserLocation(interaction.user.id);
            if (!location) {
                await interaction.reply({
                    content: "📍 You haven't set a location yet. Use `/weather setlocation` to set one!",
                    ephemeral: true
                });
                return;
            }
            // Handle both possible property names
            const cityName = location.city_name || location.city || 'Unknown';
            const zoneId = location.zone_id || location.zoneId || 'Unknown';
            const embed = new discord_js_1.EmbedBuilder()
                .setColor("#3498DB")
                .setTitle("📍 Your Weather Alert Location")
                .addFields({ name: "City", value: cityName, inline: true }, { name: "State", value: location.state, inline: true }, { name: "Zone ID", value: zoneId, inline: true }, { name: "County ID", value: location.county_id || 'N/A', inline: true })
                .setFooter({ text: "You'll be notified when alerts affect your area" });
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
        else if (subcommand === "remove") {
            const removed = await weatherManager.removeUserLocation(interaction.user.id);
            if (removed) {
                await interaction.reply({
                    content: "✅ Your location has been removed.",
                    ephemeral: true
                });
            }
            else {
                await interaction.reply({
                    content: "❌ You don't have a location set.",
                    ephemeral: true
                });
            }
        }
        else if (subcommand === "config") {
            if (!interaction.guild || !interaction.member) {
                await interaction.reply({
                    content: "❌ This command can only be used in a server.",
                    ephemeral: true
                });
                return;
            }
            const member = interaction.member;
            if (!member.permissions.has(discord_js_1.PermissionFlagsBits.Administrator)) {
                await interaction.reply({
                    content: "❌ You need Administrator permission to configure weather alerts.",
                    ephemeral: true
                });
                return;
            }
            const enabled = interaction.options.getBoolean("enabled", true);
            await weatherManager.configureGuild(interaction.guild.id, enabled);
            await interaction.reply({
                content: `✅ Weather alerts ${enabled ? 'enabled' : 'disabled'} for this server.`,
                ephemeral: true
            });
        }
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger_1.default.error(`[Weather Command] Error: ${errorMessage}`);
        const replyMethod = interaction.deferred ? 'editReply' : 'reply';
        await interaction[replyMethod]({
            content: `❌ An error occurred: ${errorMessage}`,
            ephemeral: true
        });
    }
}
// Export using CommonJS pattern
module.exports = {
    data,
    execute,
    category: 'utility'
};
