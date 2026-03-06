import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { execute as handleAir } from './weather/air.js';
import { execute as handlePlant } from './weather/plant.js';
import logger from '../../utils/logger.js';

export default {
    category: 'info',
    data: new SlashCommandBuilder()
        .setName('weather')
        .setDescription('Weather, air quality & plant care information')

        // ── Weather Check Group ──
        .addSubcommandGroup(group =>
            group.setName('check')
                .setDescription('Weather information and alerts')
                .addSubcommand(sub =>
                    sub.setName('current')
                        .setDescription('Get current weather for a location')
                        .addStringOption(opt => opt.setName('location').setDescription('City name or ZIP code').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('setlocation')
                        .setDescription('Set your location for weather alerts')
                        .addStringOption(opt => opt.setName('zipcode').setDescription('Your 5-digit US ZIP code').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('location')
                        .setDescription('View your saved alert location'))
                .addSubcommand(sub =>
                    sub.setName('removelocation')
                        .setDescription('Remove your saved location'))
                .addSubcommand(sub =>
                    sub.setName('config')
                        .setDescription('Configure weather alerts for this server (Admin only)')
                        .addBooleanOption(opt => opt.setName('enabled').setDescription('Enable or disable weather alerts').setRequired(true))))

        // ── Air Quality Group ──
        .addSubcommandGroup(group =>
            group.setName('air')
                .setDescription('Air quality and environmental information')
                .addSubcommand(sub =>
                    sub.setName('quality')
                        .setDescription('Check air quality index for a location')
                        .addStringOption(opt => opt.setName('location').setDescription('City name or coordinates').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('forecast')
                        .setDescription('Get detailed weather forecast')
                        .addStringOption(opt => opt.setName('location').setDescription('City name').setRequired(true))))

        // ── Plant Care Group ──
        .addSubcommandGroup(group =>
            group.setName('plant')
                .setDescription('Plant identification and care information')
                .addSubcommand(sub =>
                    sub.setName('identify')
                        .setDescription('Identify a plant from description')
                        .addStringOption(opt => opt.setName('description').setDescription('Describe the plant (leaves, flowers, size, etc.)').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('care')
                        .setDescription('Get care instructions for common plants')
                        .addStringOption(opt => opt.setName('plantname').setDescription('Name of the plant').setRequired(true)
                            .addChoices(
                                { name: 'Snake Plant', value: 'snake' }, { name: 'Pothos', value: 'pothos' },
                                { name: 'Monstera', value: 'monstera' }, { name: 'Succulents', value: 'succulent' },
                                { name: 'Peace Lily', value: 'peacelily' }, { name: 'Spider Plant', value: 'spider' },
                                { name: 'Aloe Vera', value: 'aloe' }, { name: 'Fiddle Leaf Fig', value: 'fiddle' },
                                { name: 'ZZ Plant', value: 'zz' }, { name: 'Rubber Plant', value: 'rubber' })))
                .addSubcommand(sub =>
                    sub.setName('tips')
                        .setDescription('General plant care tips and common problems'))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        try {
            switch (group) {
                case 'check':
                    return await handleWeatherCheck(interaction, subcommand);
                case 'air':
                    return await handleAir(interaction);
                case 'plant':
                    return await handlePlant(interaction);
            }
        } catch (error) {
            logger.error('[Weather Command] Error:', { error: error.message, group, subcommand, stack: error.stack });

            const reply = { content: `Error: ${error.message}`, ephemeral: true };
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(reply);
            } else {
                await interaction.reply(reply);
            }
        }
    }
};

// ── Weather Check Handler (inlined from original weather.js) ──
async function handleWeatherCheck(interaction, subcommand) {
    const weatherManager = interaction.client.weatherManager;

    if (!weatherManager) {
        return interaction.reply({ content: 'Weather system is not available.', ephemeral: true });
    }

    if (subcommand === 'current') {
        const location = interaction.options.getString('location', true);
        await interaction.deferReply();

        const weather = await weatherManager.getCurrentWeather(location);

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle(`Weather for ${weather.locationName}`)
            .addFields(
                { name: 'Condition', value: weather.condition, inline: true },
                { name: 'Temperature', value: `${weather.tempF}°F / ${weather.tempC}°C`, inline: true },
                { name: 'Feels Like', value: `${weather.feelsLikeF}°F / ${weather.feelsLikeC}°C`, inline: true },
                { name: 'Wind Speed', value: `${weather.windSpeed} mph`, inline: true },
                { name: 'Humidity', value: `${weather.humidity}%`, inline: true },
                { name: 'Observation Time', value: `<t:${weather.observationTime}:f>`, inline: true }
            )
            .setFooter({ text: weather.iconUrl ? 'Weather data from wttr.in' : 'Weather data from Open-Meteo' })
            .setTimestamp();

        if (weather.iconUrl) {
            embed.setThumbnail(weather.iconUrl);
        }

        return interaction.editReply({ embeds: [embed] });

    } else if (subcommand === 'setlocation') {
        const zipcode = interaction.options.getString('zipcode', true);
        await interaction.deferReply({ ephemeral: true });

        const location = await weatherManager.setUserLocation(interaction.user.id, zipcode, interaction.guild.id);

        return interaction.editReply({
            content: `📍 Your alert zone is now **${location.zoneId} (${location.city}, ${location.state})**.\n\nYou'll be mentioned when weather alerts affect your area. Make sure weather alerts are enabled in this server with \`/weather check config\`.`
        });

    } else if (subcommand === 'location') {
        const location = await weatherManager.getUserLocation(interaction.user.id);

        if (!location) {
            return interaction.reply({
                content: '📍 You haven\'t set a location yet. Use `/weather check setlocation` to set one!',
                ephemeral: true
            });
        }

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle('📍 Your Weather Alert Location')
            .addFields(
                { name: 'City', value: location.city_name || 'Unknown', inline: true },
                { name: 'State', value: location.state || 'Unknown', inline: true },
                { name: 'Zone ID', value: location.zone_code || 'Unknown', inline: true },
                { name: 'County ID', value: location.county_id || 'N/A', inline: true }
            )
            .setFooter({ text: 'You\'ll be mentioned when alerts affect your area' });

        return interaction.reply({ embeds: [embed], ephemeral: true });

    } else if (subcommand === 'removelocation') {
        const removed = await weatherManager.removeUserLocation(interaction.user.id);

        return interaction.reply({
            content: removed ? '✅ Your location has been removed.' : '❌ You don\'t have a location set.',
            ephemeral: true
        });

    } else if (subcommand === 'config') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ You need Administrator permission to configure weather alerts.', ephemeral: true });
        }

        const enabled = interaction.options.getBoolean('enabled', true);
        await weatherManager.configureGuild(interaction.guild.id, enabled);

        return interaction.reply({
            content: `✅ Weather alerts ${enabled ? 'enabled' : 'disabled'} for this server.${enabled ? '\n\nAlerts will be posted in channels named `weather`, `alerts`, `emergency`, or `general`.' : ''}`,
            ephemeral: true
        });
    }
}
