import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { getFollowerCount } from '../utils/platforms/twitch.js';
import {
    getGuildTimezone,
    isIanaTimezone,
    parseLegacyOffset,
    getLocalDateParts
} from '../utils/guild-timezone.js';

/**
 * Stat Display Manager - Updates voice channel names with live server stats.
 * Discord rate-limits channel name changes to 2 per 10 minutes per channel,
 * so this should run on a 10-minute interval.
 */
class StatDisplayManager {
    constructor(client) {
        this.client = client;
        this._pendingRechecks = new Map();
        logger.info('[StatDisplayManager] Initialized');
    }

    /**
     * Get the current value for a stat type
     */
    async getStatValue(guild, statType, config) {
        switch (statType) {
            case 'members':
                return guild.memberCount;
            case 'humans':
                return guild.members.cache.filter(m => !m.user.bot).size;
            case 'bots':
                return guild.members.cache.filter(m => m.user.bot).size;
            case 'online':
                return guild.members.cache.filter(m =>
                    m.presence?.status && m.presence.status !== 'offline'
                ).size;
            case 'channels':
                return guild.channels.cache.filter(c => c.type !== 4).size; // exclude categories
            case 'roles':
                return guild.roles.cache.size - 1; // exclude @everyone
            case 'boosts':
                return guild.premiumSubscriptionCount || 0;
            case 'time':
                return await this.getGuildLocalTime(guild.id);
            case 'date':
                return await this.getGuildLocalDate(guild.id);
            case 'role': {
                const roleId = config?.role_id;
                if (!roleId) return 0;
                const role = guild.roles.cache.get(roleId);
                return role ? role.members.size : 0;
            }
            case 'twitch_followers': {
                const twitchUsername = config?.twitch_username;
                if (!twitchUsername) return 0;
                const count = await getFollowerCount(twitchUsername);
                return count !== null ? count.toLocaleString() : null;
            }
            default:
                return 0;
        }
    }

    /**
     * Get the guild's timezone setting from DB.
     * Returns an IANA timezone name (e.g. "America/New_York") or a UTC offset string.
     * Thin wrapper over the shared helper — kept as an instance method so callers
     * inside this class don't have to switch to `import` syntax.
     */
    async getGuildTimezone(guildId) {
        return getGuildTimezone(guildId);
    }

    /**
     * Check if a timezone string is a valid IANA timezone
     */
    isIanaTimezone(tz) {
        return isIanaTimezone(tz);
    }

    /**
     * Get UTC offset in milliseconds for a legacy UTC±N timezone string.
     */
    parseLegacyOffset(tz) {
        return parseLegacyOffset(tz);
    }

    /**
     * Get local Date object for a guild — DST-aware when using IANA timezone names.
     * The returned Date's local-getter values reflect the guild's wall clock; its
     * UTC fields are intentionally meaningless (instance is "naive-local").
     */
    async getLocalDate(guildId) {
        const tz = await getGuildTimezone(guildId);
        const now = new Date();
        const p = getLocalDateParts(now, tz);
        return new Date(p.year, p.month, p.day, p.hour, p.minute, p.second);
    }

    /**
     * Round minutes down to nearest 5 (e.g. 7:37 → 7:35, 7:42 → 7:40)
     */
    roundToFive(minutes) {
        return Math.floor(minutes / 5) * 5;
    }

    /**
     * Get the guild's local time — e.g. "7:35pm"
     * Minutes always end in 0 or 5. DST-aware when using IANA timezone names.
     */
    async getGuildLocalTime(guildId) {
        const tz = await this.getGuildTimezone(guildId);

        if (this.isIanaTimezone(tz)) {
            const now = new Date();
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
            }).formatToParts(now);
            const hour = parts.find(p => p.type === 'hour')?.value || '12';
            const min = this.roundToFive(parseInt(parts.find(p => p.type === 'minute')?.value || '0'));
            const period = (parts.find(p => p.type === 'dayPeriod')?.value || 'am').toLowerCase();
            return `${hour}:${String(min).padStart(2, '0')}${period}`;
        }

        // Legacy fallback
        const local = await this.getLocalDate(guildId);
        let hours = local.getHours();
        const minutes = this.roundToFive(local.getMinutes());
        const ampm = hours >= 12 ? 'pm' : 'am';
        hours = hours % 12 || 12;
        return `${hours}:${String(minutes).padStart(2, '0')}${ampm}`;
    }

    /**
     * Get the guild's local date — e.g. "Sunday, Mar 22nd"
     */
    async getGuildLocalDate(guildId) {
        const local = await this.getLocalDate(guildId);
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const dayName = days[local.getDay()];
        const month = months[local.getMonth()];
        const date = local.getDate();
        const ordinal = date === 1 || date === 21 || date === 31 ? 'st'
            : date === 2 || date === 22 ? 'nd'
            : date === 3 || date === 23 ? 'rd' : 'th';
        return `${dayName}, ${month} ${date}${ordinal}`;
    }

    /**
     * Check if a stat value of 0/null is suspicious and warrants a recheck
     */
    _shouldRecheck(statType, value) {
        if (value === 0 && ['members', 'humans', 'channels', 'bots', 'online', 'roles'].includes(statType)) return true;
        if (value === null && statType === 'twitch_followers') return true;
        return false;
    }

    /**
     * Schedule a single delayed recheck for a stat channel that returned a suspicious 0/null.
     * Waits 60s, re-fetches members, and retries. Accepts the value on second attempt even if still 0.
     */
    _scheduleRecheck(guild, row, config) {
        const channelId = row.channel_id;

        if (this._pendingRechecks.has(channelId)) {
            logger.debug(`[StatDisplayManager] Recheck already pending for channel ${channelId}, skipping`);
            return;
        }

        this._pendingRechecks.set(channelId, true);
        logger.warn(`[StatDisplayManager] Suspicious 0/null for "${row.stat_type}" in ${guild.name} (${guild.id}), rechecking in 60s`);

        setTimeout(async () => {
            try {
                const freshGuild = this.client.guilds.cache.get(guild.id);
                if (!freshGuild) return;

                const channel = freshGuild.channels.cache.get(channelId);
                if (!channel) return;

                await freshGuild.members.fetch();
                const value = await this.getStatValue(freshGuild, row.stat_type, config);

                if (value === 0 || value === null) {
                    logger.warn(`[StatDisplayManager] Recheck for "${row.stat_type}" still returned ${value} in ${freshGuild.name}, accepting`);
                } else {
                    logger.info(`[StatDisplayManager] Recheck for "${row.stat_type}" recovered: ${value} in ${freshGuild.name}`);
                }

                const newName = row.template.replace('{value}', value ?? 0);
                if (channel.name !== newName) {
                    await channel.setName(newName);
                    logger.info(`[StatDisplayManager] Recheck updated ${row.stat_type} → "${newName}" in ${freshGuild.name}`);
                }
            } catch (err) {
                logger.error(`[StatDisplayManager] Recheck failed for channel ${channelId}`, {
                    error: err.message, guildId: guild.id, statType: row.stat_type
                });
            } finally {
                this._pendingRechecks.delete(channelId);
            }
        }, 60_000);
    }

    /**
     * Update all stat display channels for a guild
     */
    async updateGuild(guild) {
        try {
            const [rows] = await pool.execute(
                'SELECT channel_id, stat_type, template, config FROM stat_display_channels WHERE guild_id = ?',
                [guild.id]
            );

            if (!rows.length) return;

            logger.info(`[StatDisplayManager] Processing ${rows.length} stat channels for guild ${guild.name} (${guild.id})`);

            // Fetch members to get accurate counts
            await guild.members.fetch();

            let updated = 0;
            for (const row of rows) {
                try {
                    const channel = guild.channels.cache.get(row.channel_id);
                    if (!channel) {
                        logger.warn(`[StatDisplayManager] Channel ${row.channel_id} not found in ${guild.id}`);
                        continue;
                    }

                    const config = row.config ? (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) : null;
                    const value = await this.getStatValue(guild, row.stat_type, config);

                    // Skip writing suspicious 0/null and schedule a recheck instead
                    if (this._shouldRecheck(row.stat_type, value)) {
                        this._scheduleRecheck(guild, row, config);
                        continue;
                    }

                    const newName = row.template.replace('{value}', value);

                    // Only rename if the name actually changed
                    if (channel.name !== newName) {
                        await channel.setName(newName);
                        updated++;
                        logger.info(`[StatDisplayManager] Updated ${row.stat_type} → "${newName}" in ${guild.name}`);
                    }
                } catch (err) {
                    logger.error(`[StatDisplayManager] Error updating channel ${row.channel_id}`, {
                        error: err.message,
                        guildId: guild.id,
                        statType: row.stat_type
                    });
                }
            }

            if (updated > 0) {
                logger.info(`[StatDisplayManager] Updated ${updated} stat channels in ${guild.name}`);
            }
        } catch (error) {
            logger.error(`[StatDisplayManager] Error updating guild ${guild.id}`, {
                error: error.message
            });
        }
    }

    /**
     * Update ONLY time/date channels across all guilds (fast cycle — every 5 min)
     */
    async updateClocks() {
        const [rows] = await pool.execute(
            "SELECT guild_id, channel_id, stat_type, template FROM stat_display_channels WHERE stat_type IN ('time', 'date')"
        );

        if (!rows.length) return;

        for (const row of rows) {
            try {
                const guild = this.client.guilds.cache.get(row.guild_id);
                if (!guild) continue;

                const channel = guild.channels.cache.get(row.channel_id);
                if (!channel) continue;

                const value = await this.getStatValue(guild, row.stat_type);
                const newName = row.template.replace('{value}', value);

                if (channel.name !== newName) {
                    await channel.setName(newName);
                    logger.debug(`[StatDisplayManager] Clock updated: "${newName}" in ${guild.name}`);
                }
            } catch (err) {
                // Silently handle rate limits — Discord will queue the next successful one
                if (err.code !== 50013) { // Not "Missing Permissions"
                    logger.debug(`[StatDisplayManager] Clock update failed for ${row.channel_id}: ${err.message}`);
                }
            }
        }
    }

    /**
     * Update all stat display channels across all guilds
     */
    async updateAll() {
        const [guilds] = await pool.execute(
            'SELECT DISTINCT guild_id FROM stat_display_channels'
        );

        for (const { guild_id } of guilds) {
            const guild = this.client.guilds.cache.get(guild_id);
            if (guild) {
                await this.updateGuild(guild);
            }
        }
    }
}

export default StatDisplayManager;
