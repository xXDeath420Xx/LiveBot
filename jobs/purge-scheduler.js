import cron from 'node-cron';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

let scheduledTask = null;
let client = null;

/**
 * Parse guild timezone offset from "UTC+5:30" / "UTC-7" format to milliseconds
 */
function parseTimezoneOffsetMs(tz) {
    if (!tz) return 0;
    const match = tz.match(/UTC([+-])(\d+)(?::(\d+))?/);
    if (!match) return 0;
    const sign = match[1] === '-' ? -1 : 1;
    const hours = parseInt(match[2], 10);
    const minutes = match[3] ? parseInt(match[3], 10) : 0;
    return sign * ((hours * 3600000) + (minutes * 60000));
}

/**
 * Get current local time for a guild as HH:MM string
 */
function getGuildLocalTime(offsetMs) {
    const now = new Date();
    const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
    const local = new Date(utcMs + offsetMs);
    const hh = local.getHours().toString().padStart(2, '0');
    const mm = local.getMinutes().toString().padStart(2, '0');
    return `${hh}:${mm}`;
}

/**
 * Execute a channel purge — bulk delete messages
 */
async function executePurge(guildId, channelId) {
    const botClient = global.botManager
        ? (global.botManager.getClientForGuild(guildId) || global.botManager.getDefaultClient())
        : client;

    if (!botClient) return 0;

    const channel = await botClient.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return 0;

    let totalDeleted = 0;
    const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);

    // Bulk delete loop (messages < 14 days, up to 500 per purge)
    for (let i = 0; i < 5; i++) {
        try {
            const messages = await channel.messages.fetch({ limit: 100 });
            if (messages.size === 0) break;

            // NEVER delete: pinned messages, or messages with embeds authored by our bot (info panels)
            const shouldPreserve = (m) => m.pinned || (m.author.bot && m.author.id === botClient.user?.id && m.embeds.length > 0 && m.components.length === 0);

            // Split into bulk-deletable (< 14 days) and old (>= 14 days)
            const bulkable = messages.filter(m => m.createdTimestamp > fourteenDaysAgo && !shouldPreserve(m));
            const old = messages.filter(m => m.createdTimestamp <= fourteenDaysAgo && !shouldPreserve(m));

            if (bulkable.size >= 2) {
                const deleted = await channel.bulkDelete(bulkable, true);
                totalDeleted += deleted.size;
            } else if (bulkable.size === 1) {
                await bulkable.first().delete().catch(() => {});
                totalDeleted += 1;
            }

            // Delete old messages individually (max 10 per cycle to respect rate limits)
            let oldDeleted = 0;
            for (const [, msg] of old) {
                if (oldDeleted >= 10) break;
                try {
                    await msg.delete();
                    totalDeleted++;
                    oldDeleted++;
                    await new Promise(r => setTimeout(r, 250)); // Rate limit safety
                } catch { break; }
            }

            // If we couldn't delete anything, stop
            if (bulkable.size === 0 && oldDeleted === 0) break;
        } catch (err) {
            logger.warn(`[PurgeScheduler] Error during purge loop: ${err.message}`, { guildId, channelId });
            break;
        }
    }

    return totalDeleted;
}

/**
 * Main purge check — runs every minute
 */
async function checkPurges() {
    try {
        // Fetch purge configs and resolve timezone separately to avoid collation issues
        const [rawConfigs] = await pool.execute('SELECT * FROM scheduled_purges WHERE enabled = 1');
        const configs = [];
        for (const cfg of rawConfigs) {
            let timezone = 'UTC';
            try {
                const [gs] = await pool.execute('SELECT timezone FROM guild_settings WHERE guild_id = ?', [cfg.guild_id]);
                if (gs.length && gs[0].timezone) timezone = gs[0].timezone;
                else {
                    const [gc] = await pool.execute('SELECT timezone FROM guild_config WHERE guild_id = ?', [cfg.guild_id]);
                    if (gc.length && gc[0].timezone) timezone = gc[0].timezone;
                }
            } catch {}
            configs.push({ ...cfg, timezone });
        }

        if (!configs.length) return;

        for (const config of configs) {
            try {
                const offsetMs = parseTimezoneOffsetMs(config.timezone);
                let shouldPurge = false;

                if (config.interval_hours) {
                    // Interval mode: check if enough time has passed since last purge
                    if (!config.last_purge_at) {
                        shouldPurge = true;
                    } else {
                        const elapsed = Date.now() - new Date(config.last_purge_at).getTime();
                        shouldPurge = elapsed >= config.interval_hours * 3600000;
                    }
                } else {
                    // Time-of-day mode: check if current local time matches purge_time
                    const localTime = getGuildLocalTime(offsetMs);
                    if (localTime === config.purge_time) {
                        // Prevent double-fire: must be >23 hours since last purge
                        if (!config.last_purge_at) {
                            shouldPurge = true;
                        } else {
                            const elapsed = Date.now() - new Date(config.last_purge_at).getTime();
                            shouldPurge = elapsed >= 23 * 3600000;
                        }
                    }
                }

                if (shouldPurge) {
                    logger.info(`[PurgeScheduler] Executing purge for channel ${config.channel_id} in guild ${config.guild_id} (time: ${config.purge_time}, tz: ${config.timezone})`, {
                        category: 'purge', guildId: config.guild_id, channelId: config.channel_id
                    });
                    const deleted = await executePurge(config.guild_id, config.channel_id);
                    await pool.execute(
                        'UPDATE scheduled_purges SET last_purge_at = NOW() WHERE id = ?',
                        [config.id]
                    );
                    logger.info(`[PurgeScheduler] Purged ${deleted} messages from channel ${config.channel_id} in guild ${config.guild_id}`, {
                        category: 'purge', guildId: config.guild_id, channelId: config.channel_id, deleted
                    });
                }
            } catch (err) {
                logger.error(`[PurgeScheduler] Error processing purge ${config.id} for guild ${config.guild_id} channel ${config.channel_id}: ${err.message}`, {
                    category: 'purge', configId: config.id, guildId: config.guild_id, channelId: config.channel_id
                });
            }
        }
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') {
            logger.error(`[PurgeScheduler] Error checking purges: ${err.message}`, { category: 'purge' });
        }
    }
}

export function startPurgeScheduler(botClient) {
    client = botClient;

    if (scheduledTask) {
        logger.warn('[PurgeScheduler] Already running');
        return;
    }

    scheduledTask = cron.schedule('* * * * *', checkPurges);
    scheduledTask.start();
    logger.info('[PurgeScheduler] Started (checks every minute)');
}

export function stopPurgeScheduler() {
    if (scheduledTask) {
        scheduledTask.stop();
        scheduledTask = null;
        logger.info('[PurgeScheduler] Stopped');
    }
}
