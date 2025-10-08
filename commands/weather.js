const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('weather')
        .setDescription('Checks the current weather for a specified location.')
        .addStringOption(option =>
            option.setName('location')
                .setDescription('The city to get the weather for (e.g., London, New York).')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply();
        const location = interaction.options.getString('location');

        try {
            // Using a free, public weather API (wttr.in)
            const response = await axios.get(`https://wttr.in/${encodeURIComponent(location)}?format=j1`);
            const weather = response.data.current_condition[0];
            const area = response.data.nearest_area[0];

            const locationName = `${area.areaName[0].value}, ${area.region[0].value}, ${area.country[0].value}`;

            const embed = new EmbedBuilder()
                .setColor('#3498DB')
                .setTitle(`Weather for ${locationName}`)
                .setThumbnail(`https://wttr.in/_(.png?format=v2)`) // A generic weather icon
                .addFields(
                    { name: 'Condition', value: weather.weatherDesc[0].value, inline: true },
                    { name: 'Temperature', value: `${weather.temp_F}°F / ${weather.temp_C}°C`, inline: true },
                    { name: 'Feels Like', value: `${weather.FeelsLikeF}°F / ${weather.FeelsLikeC}°C`, inline: true },
                    { name: 'Wind', value: `${weather.windspeedMiles} mph`, inline: true },
                    { name: 'Humidity', value: `${weather.humidity}%`, inline: true },
                    { name: 'Observation Time', value: weather.observation_time, inline: true }
                )
                .setFooter({ text: 'Weather data from wttr.in' });

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            logger.error('[Weather Command Error]', error);
            await interaction.editReply('Could not fetch weather information for that location. Please check the spelling and try again.');
        }
    },
};