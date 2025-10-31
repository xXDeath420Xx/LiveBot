import {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits,
    ChatInputCommandInteraction,
    GuildMember
} from 'discord.js';
import logger from '../utils/logger';

// Interfaces
interface WeatherLocation {
    zoneId?: string;
    zone_id?: string;
    city?: string;
    city_name?: string;
    state: string;
    county_id?: string;
}

interface WeatherManager {
    setUserLocation(userId: string, zipcode: string): Promise<WeatherLocation>;
    getUserLocation(userId: string): Promise<WeatherLocation | null>;
    removeUserLocation(userId: string): Promise<boolean>;
    configureGuild(guildId: string, enabled: boolean): Promise<void>;
}

interface ExtendedClient {
    weatherManager?: WeatherManager;
}

const data = new SlashCommandBuilder()
    .setName("weather")
    .setDescription("Weather alerts and notifications")
    .addSubcommand(sub => sub
        .setName("setlocation")
        .setDescription("Set your location for weather alerts")
        .addStringOption(opt => opt
            .setName("zipcode")
            .setDescription("Your 5-digit US ZIP code")
            .setRequired(true)
        )
    )
    .addSubcommand(sub => sub
        .setName("location")
        .setDescription("View your saved location")
    )
    .addSubcommand(sub => sub
        .setName("remove")
        .setDescription("Remove your location")
    )
    .addSubcommand(sub => sub
        .setName("config")
        .setDescription("Configure weather alerts (Admin only)")
        .addBooleanOption(opt => opt
            .setName("enabled")
            .setDescription("Enable weather alerts")
            .setRequired(true)
        )
    );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const client = interaction.client as ExtendedClient;
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
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown _error';
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

            const embed = new EmbedBuilder()
                .setColor("#3498DB")
                .setTitle("📍 Your Weather Alert Location")
                .addFields(
                    { name: "City", value: cityName, inline: true },
                    { name: "State", value: location.state, inline: true },
                    { name: "Zone ID", value: zoneId, inline: true },
                    { name: "County ID", value: location.county_id || 'N/A', inline: true }
                )
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
            } else {
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

            const member = interaction.member as GuildMember;
            if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
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

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown _error';
        logger.error(`[Weather Command] Error: ${errorMessage}`);

        const replyMethod = interaction.deferred ? 'editReply' : 'reply';
        await interaction[replyMethod]({
            content: `❌ An _error occurred: ${errorMessage}`,
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