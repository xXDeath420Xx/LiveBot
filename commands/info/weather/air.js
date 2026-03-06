import { EmbedBuilder } from 'discord.js';
import axios from 'axios';

export async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    try {
        switch (subcommand) {
            case 'quality':
                return await handleAirQuality(interaction);
            case 'forecast':
                return await handleForecast(interaction);
        }
    } catch (error) {
        console.error('[Air Command Error]', error);
        const method = interaction.deferred ? 'editReply' : 'reply';
        return interaction[method]({
            content: '❌ Failed to fetch environmental data. Please try again later.',
            ephemeral: true
        });
    }
}

async function handleAirQuality(interaction) {
    await interaction.deferReply();

    const location = interaction.options.getString('location');

    try {
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
        const geoResponse = await axios.get(geoUrl, { timeout: 10000 });

        if (!geoResponse.data.results || geoResponse.data.results.length === 0) {
            return interaction.editReply({
                content: `❌ Location "${location}" not found. Please try a different city name.`
            });
        }

        const place = geoResponse.data.results[0];
        const { latitude, longitude, name, country } = place;

        const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitude}&longitude=${longitude}&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,european_aqi,us_aqi&timezone=auto`;
        const aqResponse = await axios.get(aqUrl, { timeout: 10000 });

        const current = aqResponse.data.current;

        const euAqi = current.european_aqi || 0;
        const usAqi = current.us_aqi || 0;
        const aqi = usAqi > 0 ? usAqi : euAqi;

        const { status, color, emoji, description, recommendations } = getAQIInfo(aqi);

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`${emoji} Air Quality - ${name}, ${country}`)
            .setDescription(`**Status:** ${status} - ${description}`)
            .addFields(
                {
                    name: '📊 Air Quality Index',
                    value: `**US AQI:** ${usAqi || 'N/A'}\n**EU AQI:** ${euAqi || 'N/A'}`,
                    inline: true
                },
                {
                    name: '🌡️ Pollutants',
                    value: `**PM2.5:** ${current.pm2_5?.toFixed(1) || 'N/A'} μg/m³\n**PM10:** ${current.pm10?.toFixed(1) || 'N/A'} μg/m³`,
                    inline: true
                },
                {
                    name: '💨 Gases',
                    value: `**O₃:** ${current.ozone?.toFixed(1) || 'N/A'} μg/m³\n**NO₂:** ${current.nitrogen_dioxide?.toFixed(1) || 'N/A'} μg/m³\n**SO₂:** ${current.sulphur_dioxide?.toFixed(1) || 'N/A'} μg/m³\n**CO:** ${current.carbon_monoxide?.toFixed(0) || 'N/A'} μg/m³`,
                    inline: true
                },
                {
                    name: '💡 Health Recommendations',
                    value: recommendations,
                    inline: false
                }
            )
            .setFooter({ text: `Powered by Open-Meteo • Coordinates: ${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°` })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('[Air Quality Error]', error);
        return interaction.editReply({
            content: '❌ Failed to fetch air quality data. The service may be temporarily unavailable.'
        });
    }
}

function getAQIInfo(aqi) {
    if (aqi <= 50) {
        return {
            status: 'Good', color: '#00E400', emoji: '🟢',
            description: 'Air quality is satisfactory, and air pollution poses little or no risk.',
            recommendations: '• Great day for outdoor activities!\n• No health concerns\n• Enjoy the fresh air'
        };
    } else if (aqi <= 100) {
        return {
            status: 'Moderate', color: '#FFFF00', emoji: '🟡',
            description: 'Air quality is acceptable. However, unusually sensitive people may experience minor symptoms.',
            recommendations: '• Outdoor activities are generally safe\n• Sensitive individuals should monitor symptoms\n• Consider reducing prolonged exertion'
        };
    } else if (aqi <= 150) {
        return {
            status: 'Unhealthy for Sensitive Groups', color: '#FF7E00', emoji: '🟠',
            description: 'Members of sensitive groups may experience health effects. The general public is less likely to be affected.',
            recommendations: '• Sensitive groups should limit prolonged outdoor exertion\n• Children, elderly, and people with respiratory conditions take precautions\n• General public can continue normal activities'
        };
    } else if (aqi <= 200) {
        return {
            status: 'Unhealthy', color: '#FF0000', emoji: '🔴',
            description: 'Some members of the general public may experience health effects; sensitive groups may experience more serious effects.',
            recommendations: '• Everyone should limit prolonged outdoor exertion\n• Sensitive groups should avoid outdoor activities\n• Consider wearing a mask outdoors\n• Keep windows closed'
        };
    } else if (aqi <= 300) {
        return {
            status: 'Very Unhealthy', color: '#8F3F97', emoji: '🟣',
            description: 'Health alert: The risk of health effects is increased for everyone.',
            recommendations: '• Everyone should avoid prolonged outdoor exertion\n• Sensitive groups should remain indoors\n• Use air purifiers indoors\n• Wear N95 masks if going outside is necessary'
        };
    } else {
        return {
            status: 'Hazardous', color: '#7E0023', emoji: '🟤',
            description: 'Health warning of emergency conditions: everyone is more likely to be affected.',
            recommendations: '• Everyone should avoid all outdoor activities\n• Remain indoors with windows closed\n• Use air purifiers\n• Evacuate if possible\n• Seek medical attention if experiencing symptoms'
        };
    }
}

async function handleForecast(interaction) {
    await interaction.deferReply();

    const location = interaction.options.getString('location');

    try {
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
        const geoResponse = await axios.get(geoUrl, { timeout: 10000 });

        if (!geoResponse.data.results || geoResponse.data.results.length === 0) {
            return interaction.editReply({
                content: `❌ Location "${location}" not found. Please try a different city name.`
            });
        }

        const place = geoResponse.data.results[0];
        const { latitude, longitude, name, country, timezone } = place;

        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,weathercode,windspeed_10m_max&timezone=${encodeURIComponent(timezone)}&forecast_days=7`;
        const weatherResponse = await axios.get(weatherUrl, { timeout: 10000 });

        const daily = weatherResponse.data.daily;

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle(`🌤️ 7-Day Weather Forecast - ${name}, ${country}`)
            .setDescription('Detailed weather forecast for the next week')
            .setFooter({ text: 'Powered by Open-Meteo' })
            .setTimestamp();

        for (let i = 0; i < 7 && i < daily.time.length; i++) {
            const date = new Date(daily.time[i]);
            const dayName = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : date.toLocaleDateString('en-US', { weekday: 'short' });
            const weather = getWeatherEmoji(daily.weathercode[i]);

            const tempMax = daily.temperature_2m_max[i];
            const tempMin = daily.temperature_2m_min[i];
            const precip = daily.precipitation_sum[i];
            const precipProb = daily.precipitation_probability_max[i];
            const wind = daily.windspeed_10m_max[i];

            embed.addFields({
                name: `${weather} ${dayName} - ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
                value: `**High:** ${tempMax}°C (${toFahrenheit(tempMax)}°F)\n**Low:** ${tempMin}°C (${toFahrenheit(tempMin)}°F)\n**Precipitation:** ${precip}mm (${precipProb}% chance)\n**Wind:** ${wind} km/h`,
                inline: true
            });
        }

        return interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('[Weather Forecast Error]', error);
        return interaction.editReply({
            content: '❌ Failed to fetch weather forecast. The service may be temporarily unavailable.'
        });
    }
}

function getWeatherEmoji(code) {
    if (code === 0) return '☀️';
    if (code === 1 || code === 2) return '🌤️';
    if (code === 3) return '☁️';
    if (code >= 45 && code <= 48) return '🌫️';
    if (code >= 51 && code <= 55) return '🌦️';
    if (code >= 56 && code <= 57) return '🌧️';
    if (code >= 61 && code <= 65) return '🌧️';
    if (code >= 66 && code <= 67) return '🌨️';
    if (code >= 71 && code <= 77) return '❄️';
    if (code >= 80 && code <= 82) return '🌧️';
    if (code >= 85 && code <= 86) return '🌨️';
    if (code >= 95) return '⛈️';
    return '🌤️';
}

function toFahrenheit(celsius) {
    return Math.round(celsius * 9 / 5 + 32);
}
