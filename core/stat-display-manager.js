import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { logFeatureEvent } from './feature-log.js';
import { getFollowerCount } from '../utils/platforms/twitch.js';
import {
    getGuildTimezone,
    isIanaTimezone,
    parseLegacyOffset,
    getLocalDateParts
} from '../utils/guild-timezone.js';

// Stats computed from the member cache; only these justify a gateway member fetch (opcode 8).
const MEMBER_CACHE_STATS = new Set(['humans', 'bots', 'online', 'role']);

// Shared by every bot client's manager. Each client walks every stat guild it is in, so a guild
// with both the main bot and a custom bot was updated twice per cycle: two member fetches (which
// tripped Discord's opcode-8 rate limit) and racing renames against the 2-per-10-min budget.
const guildLastUpdated = new Map();
const GUILD_UPDATE_MIN_INTERVAL_MS = 4 * 60 * 1000;

/**
 * Make the member cache usable for member-derived stats. Returns false when it is incomplete and
 * could not be filled — the caller then leaves those channels alone rather than writing a count
 * taken from a partial cache.
 */
async function ensureMemberCache(guild) {
    if (guild.members.cache.size >= guild.memberCount) return true;
    try {
        await guild.members.fetch();
        return true;
    } catch (err) {
        logger.warn(`[StatDisplayManager] Member fetch deferred for ${guild.name} (${guild.id}): ${err.message}`);
        return false;
    }
}

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
    /**
     * A stat channel that is not in the cache. Discord answering 10003 Unknown Channel means it was deleted,
     * so its display row goes too; this used to warn on every cycle forever. Anything else (a cold cache,
     * missing access, an outage) is left for the next cycle.
     */
    async _handleMissingChannel(guild, row) {
        let fetchError = null;
        const channel = await guild.channels.fetch(row.channel_id).catch(error => { fetchError = error; return null; });
        if (channel) return; // only missing from the cache; fetched now, so the next cycle updates it
        if (fetchError?.code !== 10003) {
            logger.warn(`[StatDisplayManager] Channel ${row.channel_id} not found in ${guild.id}`, { code: fetchError?.code });
            return;
        }
        await pool.execute('DELETE FROM stat_display_channels WHERE guild_id = ? AND channel_id = ?', [guild.id, row.channel_id]);
        logger.info(`[StatDisplayManager] Removed the ${row.stat_type} display for deleted channel ${row.channel_id} in ${guild.id}`);
        void logFeatureEvent(() => guild, 'system.featureDisabled', () => ({
            title: '⛔ Feature Auto-Disabled',
            fields: [
                ['Feature', `Stat display (${row.stat_type})`], ['Template', row.template || '-'],
                ['Why', `Its channel (${row.channel_id}) was deleted`],
                ['Fix', 'Add it again from the server stats section of the dashboard if you still want it', false],
            ],
        }));
    }

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

                if (MEMBER_CACHE_STATS.has(row.stat_type) && !(await ensureMemberCache(freshGuild))) return;
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

            const last = guildLastUpdated.get(guild.id) || 0;
            if (Date.now() - last < GUILD_UPDATE_MIN_INTERVAL_MS) return; // another client already did it this cycle
            guildLastUpdated.set(guild.id, Date.now());

            logger.info(`[StatDisplayManager] Processing ${rows.length} stat channels for guild ${guild.name} (${guild.id})`);

            const needsMembers = rows.some(r => MEMBER_CACHE_STATS.has(r.stat_type));
            const membersReady = needsMembers ? await ensureMemberCache(guild) : true;

            let updated = 0;
            for (const row of rows) {
                try {
                    // Time + date rows are owned by updateClocks() (every 5min). Skipping them
                    // here prevents the overlap that trips Discord's 2-renames-per-10min cap.
                    if (row.stat_type === 'time' || row.stat_type === 'date') continue;
                    if (MEMBER_CACHE_STATS.has(row.stat_type) && !membersReady) continue; // retry next cycle
                    const channel = guild.channels.cache.get(row.channel_id);
                    if (!channel) {
                        await this._handleMissingChannel(guild, row);
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
                // Rate-limit (429 / RateLimitedError) is normal under contention but should still
                // be visible so operators can diagnose stalled clocks. Everything else except
                // Missing Permissions is logged as warn.
                if (err.code === 50013) {
                    // Missing Permissions — the channel exists but the bot can't rename it.
                    logger.warn(`[StatDisplayManager] Clock update needs Manage Channel for ${row.channel_id} in ${row.guild_id}`);
                } else if (err.status === 429 || err.code === 429 || /rate ?limit/i.test(err.message || '')) {
                    logger.warn(`[StatDisplayManager] Clock update rate-limited for ${row.channel_id} in ${row.guild_id} — will retry next cycle`);
                } else {
                    logger.warn(`[StatDisplayManager] Clock update failed for ${row.channel_id} in ${row.guild_id}: ${err.message}`);
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
