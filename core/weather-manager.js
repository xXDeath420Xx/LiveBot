import axios from 'axios';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder } from 'discord.js';

class WeatherManager {
    constructor(client) {
        this.client = client;
        this.processedAlerts = new Set();
        this.checkInterval = null;

        // Alert type to color mapping
        this.alertColors = {
            'Tornado Watch': 0xFFCC00,
            'Tornado Warning': 0xFF0000,
            'Severe Thunderstorm Watch': 0xFFAA00,
            'Severe Thunderstorm Warning': 0xFF6600,
            'Tropical Storm Watch': 0x00AAFF,
            'Tropical Storm Warning': 0x0077FF,
            'Hurricane Watch': 0xFF00AA,
            'Hurricane Warning': 0xAA0000,
            'Flash Flood Watch': 0x00FF00,
            'Flash Flood Warning': 0x00AA00,
            'Winter Storm Watch': 0xAACCFF,
            'Winter Storm Warning': 0x6699FF,
            'Blizzard Warning': 0x0000FF
        };

        logger.info('[WeatherManager] Weather manager initialized');
    }

    /**
     * Get current weather for a location using wttr.in with Open-Meteo fallback
     */
    async getCurrentWeather(location) {
        // Try wttr.in first
        try {
            const response = await axios.get(
                `https://wttr.in/${encodeURIComponent(location)}?format=j1`,
                { timeout: 8000 }
            );

            const weather = response.data.current_condition[0];
            const area = response.data.nearest_area[0];

            // Parse localObsDateTime to Unix timestamp for Discord
            const obsDateTime = weather.localObsDateTime; // Format: "2025-11-20 11:36 PM"
            const obsDate = new Date(obsDateTime);
            const obsTimestamp = Math.floor(obsDate.getTime() / 1000);

            return {
                locationName: `${area.areaName[0].value}, ${area.region[0].value}, ${area.country[0].value}`,
                condition: weather.weatherDesc[0].value,
                tempF: weather.temp_F,
                tempC: weather.temp_C,
                feelsLikeF: weather.FeelsLikeF,
                feelsLikeC: weather.FeelsLikeC,
                windSpeed: weather.windspeedMiles,
                humidity: weather.humidity,
                observationTime: obsTimestamp,
                iconUrl: `https://wttr.in/${encodeURIComponent(location)}.png?format=v2`
            };
        } catch (wttrError) {
            logger.warn(`[WeatherManager] wttr.in failed, trying Open-Meteo fallback: ${wttrError.message}`);

            // Fallback to Open-Meteo
            return await this.getCurrentWeatherOpenMeteo(location);
        }
    }

    /**
     * Get current weather using Open-Meteo API (fallback)
     */
    async getCurrentWeatherOpenMeteo(location) {
        try {
            // Weather code to description mapping
            const weatherCodes = {
                0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
                45: 'Fog', 48: 'Depositing rime fog',
                51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
                61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
                71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
                77: 'Snow grains', 80: 'Slight rain showers', 81: 'Moderate rain showers',
                82: 'Violent rain showers', 85: 'Slight snow showers', 86: 'Heavy snow showers',
                95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail'
            };

            // First, get coordinates from location (ZIP code or city name)
            let lat, lon, locationName;

            // Check if location is a ZIP code
            if (/^\d{5}$/.test(location)) {
                // Use zippopotam.us for US ZIP codes
                const zipResponse = await axios.get(
                    `https://api.zippopotam.us/us/${location}`,
                    { timeout: 5000 }
                );
                const place = zipResponse.data.places[0];
                lat = parseFloat(place.latitude);
                lon = parseFloat(place.longitude);
                locationName = `${place['place name']}, ${place['state abbreviation']}, US`;
            } else {
                // Use Open-Meteo geocoding for city names
                const geoResponse = await axios.get(
                    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`,
                    { timeout: 5000 }
                );

                if (!geoResponse.data.results || geoResponse.data.results.length === 0) {
                    throw new Error('Location not found');
                }

                const result = geoResponse.data.results[0];
                lat = result.latitude;
                lon = result.longitude;
                locationName = `${result.name}, ${result.admin1 || ''}, ${result.country}`.replace(', ,', ',');
            }

            // Get weather data from Open-Meteo
            const weatherResponse = await axios.get(
                `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph`,
                { timeout: 8000 }
            );

            const current = weatherResponse.data.current;
            const weatherCode = current.weather_code;
            const condition = weatherCodes[weatherCode] || 'Unknown';

            // Convert Fahrenheit to Celsius
            const tempF = Math.round(current.temperature_2m);
            const tempC = Math.round((current.temperature_2m - 32) * 5 / 9);
            const feelsLikeF = Math.round(current.apparent_temperature);
            const feelsLikeC = Math.round((current.apparent_temperature - 32) * 5 / 9);

            return {
                locationName: locationName,
                condition: condition,
                tempF: tempF.toString(),
                tempC: tempC.toString(),
                feelsLikeF: feelsLikeF.toString(),
                feelsLikeC: feelsLikeC.toString(),
                windSpeed: Math.round(current.wind_speed_10m).toString(),
                humidity: current.relative_humidity_2m.toString(),
                observationTime: Math.floor(Date.now() / 1000),
                iconUrl: null // Open-Meteo doesn't provide icons
            };
        } catch (error) {
            logger.error(`[WeatherManager] Open-Meteo fallback failed: ${error.message}`);
            throw new Error('Could not fetch weather data for that location');
        }
    }

    /**
     * Set user location for weather alerts
     */
    async setUserLocation(userId, zipCode, guildId) {
        try {
            // Validate ZIP code format
            if (!/^[0-9]{5}$/.test(zipCode)) {
                throw new Error('Invalid ZIP code format. Use 5-digit US ZIP only.');
            }

            // Get lat/lon from ZIP code using zippopotam.us
            const zipInfo = await axios.get(
                `https://api.zippopotam.us/us/${zipCode}`,
                { timeout: 5000 }
            );

            const place = zipInfo.data.places[0];
            const latitude = place.latitude;
            const longitude = place.longitude;
            const city = place['place name'];
            const state = place['state abbreviation'];

            // Get NWS zone info
            const pointData = await axios.get(
                `https://api.weather.gov/points/${latitude},${longitude}`,
                {
                    headers: {
                        'User-Agent': 'CertiFriedUtility Discord Bot',
                        'Accept': 'application/geo+json'
                    },
                    timeout: 5000
                }
            );

            const zoneId = pointData.data.properties.forecastZone.split('/').pop();
            const countyId = pointData.data.properties.county.split('/').pop();

            // Save to database
            await pool.execute(
                `INSERT INTO user_alert_zones (user_id, guild_id, zone_code, city_name, state, county_id)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE zone_code = VALUES(zone_code), city_name = VALUES(city_name), state = VALUES(state), county_id = VALUES(county_id)`,
                [userId, guildId, zoneId, city, state, countyId]
            );

            logger.info(`[WeatherManager] Set location for user ${userId}: ${city}, ${state} (${zoneId})`);

            return { zoneId, countyId, city, state };
        } catch (error) {
            logger.error(`[WeatherManager] Error setting user location: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get user's saved location
     */
    async getUserLocation(userId) {
        try {
            const [rows] = await pool.execute(
                'SELECT zone_code, city_name, state, county_id FROM user_alert_zones WHERE user_id = ?',
                [userId]
            );

            return rows[0] || null;
        } catch (error) {
            logger.error(`[WeatherManager] Error getting user location: ${error.message}`);
            return null;
        }
    }

    /**
     * Remove user's location
     */
    async removeUserLocation(userId) {
        try {
            await pool.execute('DELETE FROM user_alert_zones WHERE user_id = ?', [userId]);
            logger.info(`[WeatherManager] Removed location for user ${userId}`);
            return true;
        } catch (error) {
            logger.error(`[WeatherManager] Error removing user location: ${error.message}`);
            return false;
        }
    }

    /**
     * Configure weather alerts for a guild
     */
    async configureGuild(guildId, enabled = true, checkInterval = 60) {
        try {
            await pool.execute(
                `INSERT INTO weather_config (guild_id, enabled, check_interval)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), check_interval = VALUES(check_interval)`,
                [guildId, enabled, checkInterval]
            );

            logger.info(`[WeatherManager] Configured weather for guild ${guildId}: enabled=${enabled}`);
            return true;
        } catch (error) {
            logger.error(`[WeatherManager] Error configuring guild: ${error.message}`);
            return false;
        }
    }

    /**
     * Start checking for weather alerts
     */
    async start(intervalSeconds = 300) {
        if (this.checkInterval) {
            logger.warn('[WeatherManager] Weather checker already running');
            return;
        }

        logger.info(`[WeatherManager] Starting weather alert checker (interval: ${intervalSeconds}s)`);

        // Check immediately
        await this.checkAlerts();

        // Then check on interval (default 5 minutes)
        this.checkInterval = setInterval(() => this.checkAlerts(), intervalSeconds * 1000);
    }

    /**
     * Stop checking for weather alerts
     */
    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
            logger.info('[WeatherManager] Stopped weather alert checker');
        }
    }

    /**
     * Check for active weather alerts from NWS
     */
    async checkAlerts() {
        try {
            const response = await axios.get('https://api.weather.gov/alerts/active', {
                headers: {
                    'User-Agent': 'CertiFriedUtility Discord Bot',
                    'Accept': 'application/geo+json'
                },
                timeout: 10000
            });

            const alerts = response.data.features || [];
            logger.info(`[WeatherManager] Fetched ${alerts.length} active alerts`);

            for (const alert of alerts) {
                await this.processAlert(alert);
            }

            // Clean old alerts from memory (keep last 1000)
            if (this.processedAlerts.size > 1000) {
                const alertsArray = Array.from(this.processedAlerts);
                this.processedAlerts = new Set(alertsArray.slice(-500));
            }
        } catch (error) {
            logger.error(`[WeatherManager] Error fetching weather alerts: ${error.message}`);
        }
    }

    /**
     * Process a single weather alert
     */
    async processAlert(alert) {
        try {
            const id = alert.id;
            const properties = alert.properties;
            const event = properties.event;
            const severity = properties.severity;
            const headline = properties.headline;
            const areaDesc = properties.areaDesc;
            const description = properties.description;
            const instruction = properties.instruction;
            const expires = properties.expires;
            const link = properties.uri || `https://api.weather.gov/alerts/${id}`;
            const ugcs = properties.geocode?.UGC || [];

            // Skip if already processed
            if (this.processedAlerts.has(id)) {
                return;
            }

            // Only process severe alerts
            if (!Object.keys(this.alertColors).includes(event)) {
                return;
            }

            this.processedAlerts.add(id);

            // Save to database
            await pool.execute(
                `INSERT INTO weather_alerts (alert_id, event, severity, headline, areas, description, instruction, expires_at, link)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE event = VALUES(event)`,
                [id, event, severity, headline, areaDesc, description, instruction, expires ? new Date(expires) : null, link]
            );

            // Find affected users
            const affectedUsers = await this.getUsersInZones(ugcs);

            // Send notifications
            await this.sendAlertNotifications(event, {
                id,
                severity,
                headline,
                areaDesc,
                description,
                instruction,
                expires,
                link
            }, affectedUsers);

            logger.info(`[WeatherManager] Processed alert: ${event} - ${headline}`);
        } catch (error) {
            logger.error(`[WeatherManager] Error processing alert: ${error.message}`);
        }
    }

    /**
     * Get users in affected zones
     */
    async getUsersInZones(ugcs) {
        if (!ugcs || ugcs.length === 0) {
            return [];
        }

        try {
            const placeholders = ugcs.map(() => '?').join(',');
            const [users] = await pool.execute(
                `SELECT DISTINCT user_id FROM user_alert_zones WHERE zone_code IN (${placeholders})`,
                [...ugcs]
            );

            return users.map(u => u.user_id);
        } catch (error) {
            logger.error(`[WeatherManager] Error getting users in zones: ${error.message}`);
            return [];
        }
    }

    /**
     * Send alert notifications to guilds
     */
    async sendAlertNotifications(eventType, alertData, affectedUsers) {
        try {
            // Get all guilds with weather enabled
            const [configs] = await pool.execute(
                'SELECT guild_id FROM weather_config WHERE enabled = TRUE'
            );

            for (const { guild_id } of configs) {
                const guild = await this.client.guilds.fetch(guild_id).catch(() => null);
                if (!guild) continue;

                // Find suitable channel
                const channel = guild.channels.cache.find(ch =>
                    ch.isTextBased() && (
                        ch.name.includes('weather') ||
                        ch.name.includes('alert') ||
                        ch.name.includes('emergency') ||
                        ch.name === 'general'
                    )
                );

                if (!channel) continue;

                // Filter affected users to this guild
                const guildAffectedUsers = affectedUsers.filter(userId => {
                    return guild.members.cache.has(userId);
                });

                const embed = new EmbedBuilder()
                    .setTitle(`⚠️ ${eventType}`)
                    .setDescription(alertData.headline || alertData.description?.slice(0, 1500) || 'No description')
                    .addFields(
                        { name: 'Areas Affected', value: alertData.areaDesc || 'Unknown' },
                        { name: 'Severity', value: alertData.severity || 'N/A', inline: true },
                        { name: 'Expires', value: alertData.expires ? `<t:${Math.floor(new Date(alertData.expires).getTime() / 1000)}:R>` : 'Unknown', inline: true }
                    )
                    .setColor(this.alertColors[eventType] || 0xFFAA00)
                    .setURL(alertData.link || 'https://www.weather.gov')
                    .setFooter({ text: 'National Weather Service' })
                    .setTimestamp();

                if (alertData.instruction) {
                    embed.addFields({ name: 'Instructions', value: alertData.instruction.slice(0, 1024) });
                }

                const mentions = guildAffectedUsers.length > 0
                    ? guildAffectedUsers.map(id => `<@${id}>`).join(' ')
                    : undefined;

                await channel.send({
                    content: mentions,
                    embeds: [embed]
                });
            }
        } catch (error) {
            logger.error(`[WeatherManager] Error sending alert notifications: ${error.message}`);
        }
    }
}

export default WeatherManager;
