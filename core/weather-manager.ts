import axios, { AxiosResponse } from 'axios';
import db from '../utils/db';
import logger from '../utils/logger';
import { EmbedBuilder, Client, TextChannel } from 'discord.js';
import { RowDataPacket } from 'mysql2';

interface WeatherAlert {
    id: string;
    properties: {
        event: string;
        severity: string;
        headline: string;
        areaDesc: string;
        description: string;
        instruction: string | null;
        expires: string | null;
        uri: string | null;
        geocode?: {
            UGC?: string[];
        };
    };
}

interface WeatherGeoJSON {
    features: WeatherAlert[];
}

interface WeatherConfigRow extends RowDataPacket {
    guild_id: string;
    enabled: boolean;
    check_interval: number;
}

interface UserAlertZoneRow extends RowDataPacket {
    user_id: string;
}

interface UserLocationInfo {
    zoneId: string;
    countyId: string;
    city: string;
    state: string;
}

interface UserLocationRow extends RowDataPacket {
    zone_code: string;
    zone_name: string;
}

interface AlertColorMap {
    [key: string]: number;
}

class WeatherManager {
    private client: Client;
    private processedAlerts: Set<string>;
    private checkInterval: NodeJS.Timeout | null;
    private alertColors: AlertColorMap;

    constructor(client: Client) {
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
    }

    async start(intervalSeconds: number = 60): Promise<void> {
        if (this.checkInterval) {
            logger.warn('[WeatherManager] Weather checker already running');
            return;
        }

        logger.info(`[WeatherManager] Starting weather alert checker (interval: ${intervalSeconds}s)`);

        // Check immediately
        await this.checkAlerts();

        // Then check on interval
        this.checkInterval = setInterval(() => this.checkAlerts(), intervalSeconds * 1000);
    }

    stop(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
            logger.info('[WeatherManager] Stopped weather alert checker');
        }
    }

    async checkAlerts(): Promise<void> {
        try {
            const response: AxiosResponse<WeatherGeoJSON> = await axios.get('https://api.weather.gov/alerts/active', {
                headers: {
                    'User-Agent': 'CertiFriedMultitool Discord Bot',
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

        } catch (error: any) {
            logger.error(`[WeatherManager] Error fetching weather alerts: ${error.message}`);
        }
    }

    async processAlert(alert: WeatherAlert): Promise<void> {
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

            // Skip if we've already processed this alert
            if (this.processedAlerts.has(id)) {
                return;
            }

            // Only process alerts we care about
            if (!Object.keys(this.alertColors).includes(event)) {
                return;
            }

            this.processedAlerts.add(id);

            // Save to database
            await db.execute(
                `INSERT INTO weather_alerts (alert_id, event, severity, headline, areas, description, instruction, expires_at, link, timestamp)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE event = VALUES(event)`,
                [id, event, severity, headline, areaDesc, description, instruction, expires ? new Date(expires) : null, link]
            );

            // Find users in affected zones
            const affectedUsers = await this.getUsersInZones(ugcs);

            // Send alerts to configured channels
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

        } catch (error: any) {
            logger.error(`[WeatherManager] Error processing alert: ${error.message}`);
        }
    }

    async getUsersInZones(ugcs: string[]): Promise<string[]> {
        if (!ugcs || ugcs.length === 0) {
            return [];
        }

        try {
            const placeholders = ugcs.map(() => '?').join(',');
            const [users] = await db.execute<UserAlertZoneRow[]>(
                `SELECT DISTINCT user_id FROM user_alert_zones WHERE zone_code IN (${placeholders})`,
                [...ugcs]
            );

            return users.map(u => u.user_id);
        } catch (error: any) {
            logger.error(`[WeatherManager] Error getting users in zones: ${error.message}`);
            return [];
        }
    }

    async sendAlertNotifications(eventType: string, alertData: any, affectedUsers: string[]): Promise<void> {
        try {
            // Get all guilds with weather enabled
            const [configs] = await db.execute<WeatherConfigRow[]>(
                'SELECT guild_id FROM weather_config WHERE enabled = TRUE'
            );

            for (const { guild_id } of configs) {
                const guild = await this.client.guilds.fetch(guild_id).catch(() => null);
                if (!guild) continue;

                // Find a suitable channel (look for #weather, #alerts, #general)
                const channel = guild.channels.cache.find(ch =>
                    ch.isTextBased() && (
                        ch.name.includes('weather') ||
                        ch.name.includes('alert') ||
                        ch.name.includes('emergency') ||
                        ch.name === 'general'
                    )
                ) as TextChannel | undefined;

                if (!channel) continue;

                // Filter affected users to only those in this guild
                const guildAffectedUsers = affectedUsers.filter(userId => {
                    const member = guild.members.cache.get(userId);
                    return member !== undefined;
                });

                const embed = new EmbedBuilder()
                    .setTitle(`⚠️ ${eventType}`)
                    .setDescription(alertData.headline || (alertData.description?.slice(0, 1500) ?? 'No description provided'))
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

        } catch (error: any) {
            logger.error(`[WeatherManager] Error sending alert notifications: ${error.message}`);
        }
    }

    async setUserLocation(userId: string, zipCode: string): Promise<UserLocationInfo> {
        try {
            // Validate ZIP code format
            if (!/^[0-9]{5}$/.test(zipCode)) {
                throw new Error('Invalid ZIP code format. Use 5-digit US ZIP only.');
            }

            // Get lat/lon from ZIP code
            const zipInfo = await axios.get(`https://api.zippopotam.us/us/${zipCode}`, { timeout: 5000 });
            const place = zipInfo.data.places[0];
            const latitude = place.latitude;
            const longitude = place.longitude;
            const city = place['place name'];
            const state = place['state abbreviation'];

            // Get NWS zone info
            const pointData = await axios.get(`https://api.weather.gov/points/${latitude},${longitude}`, {
                headers: {
                    'User-Agent': 'CertiFriedMultitool Discord Bot',
                    'Accept': 'application/geo+json'
                },
                timeout: 5000
            });

            const zoneId = pointData.data.properties.forecastZone.split('/').pop();
            const countyId = pointData.data.properties.county.split('/').pop();

            // Save to database
            await db.execute(
                `REPLACE INTO user_alert_zones (user_id, guild_id, zone_code, zone_name)
                 VALUES (?, ?, ?, ?)`,
                [userId, userId, zoneId, `${city}, ${state}`]
            );

            logger.info(`[WeatherManager] Set location for user ${userId}: ${city}, ${state} (${zoneId})`);

            return { zoneId, countyId, city, state };

        } catch (error: any) {
            logger.error(`[WeatherManager] Error setting user location: ${error.message}`);
            throw error;
        }
    }

    async getUserLocation(userId: string): Promise<UserLocationRow | null> {
        try {
            const [rows] = await db.execute<UserLocationRow[]>(
                'SELECT zone_code, zone_name FROM user_alert_zones WHERE user_id = ?',
                [userId]
            );

            return rows[0] || null;
        } catch (error: any) {
            logger.error(`[WeatherManager] Error getting user location: ${error.message}`);
            return null;
        }
    }

    async removeUserLocation(userId: string): Promise<boolean> {
        try {
            await db.execute('DELETE FROM user_alert_zones WHERE user_id = ?', [userId]);
            logger.info(`[WeatherManager] Removed location for user ${userId}`);
            return true;
        } catch (error: any) {
            logger.error(`[WeatherManager] Error removing user location: ${error.message}`);
            return false;
        }
    }

    async configureGuild(guildId: string, enabled: boolean = true, checkInterval: number = 60): Promise<boolean> {
        try {
            await db.execute(
                `INSERT INTO weather_config (guild_id, enabled, check_interval)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), check_interval = VALUES(check_interval)`,
                [guildId, enabled, checkInterval]
            );

            logger.info(`[WeatherManager] Configured weather for guild ${guildId}: enabled=${enabled}`);
            return true;
        } catch (error: any) {
            logger.error(`[WeatherManager] Error configuring guild: ${error.message}`);
            return false;
        }
    }
}

export default WeatherManager;
