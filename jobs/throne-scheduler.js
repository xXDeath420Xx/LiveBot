import cron from 'node-cron';
import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import Colors from '../utils/colors.js';
import { checkThroneNotifications, refreshAllCachedData, getCachedProfile, getCachedWishlist } from '../core/throne-manager.js';

let schedulerTask = null;
let birthdayTask = null;
let spotlightTask = null;
let cycleRunning = false;

/**
 * Start all Throne schedulers
 */
export function startThroneScheduler() {
    if (schedulerTask) {
        logger.warn('[Throne Scheduler] Already running');
        return;
    }

    // Main check — every 2 minutes
    schedulerTask = cron.schedule('*/2 * * * *', async () => {
        if (cycleRunning) return;
        cycleRunning = true;
        try {
            await refreshAllCachedData();
            await checkThroneNotifications();
        } catch (error) {
            logger.error('[Throne Scheduler] Error:', { error: error.message });
        } finally {
            cycleRunning = false;
        }
    });

    // Birthday check — daily at 9 AM
    birthdayTask = cron.schedule('0 9 * * *', async () => {
        try {
            await checkBirthdayReminders();
        } catch (error) {
            logger.error('[Throne Scheduler] Birthday check error:', { error: error.message });
        }
    });

    // Monthly spotlight — 1st of each month at 10 AM
    spotlightTask = cron.schedule('0 10 1 * *', async () => {
        try {
            await postMonthlySpotlights();
        } catch (error) {
            logger.error('[Throne Scheduler] Spotlight error:', { error: error.message });
        }
    });

    // Initial cache refresh after 30 seconds
    setTimeout(async () => {
        if (cycleRunning) return;
        cycleRunning = true;
        try {
            await refreshAllCachedData();
        } catch (error) {
            logger.error('[Throne Scheduler] Initial refresh error:', { error: error.message });
        } finally {
            cycleRunning = false;
        }
    }, 30000);

    logger.info('[Throne Scheduler] Started (main: 2min, birthday: daily 9AM, spotlight: 1st monthly 10AM)');
}

export function stopThroneScheduler() {
    if (schedulerTask) { schedulerTask.stop(); schedulerTask = null; }
    if (birthdayTask) { birthdayTask.stop(); birthdayTask = null; }
    if (spotlightTask) { spotlightTask.stop(); spotlightTask = null; }
    cycleRunning = false;
    logger.info('[Throne Scheduler] Stopped');
}

// ─── Birthday Reminders ──────────────────────────────────────────
async function checkBirthdayReminders() {
    // Get all guilds with birthday_reminder enabled
    const [guilds] = await pool.execute(
        'SELECT guild_id, birthday_channel_id, birthday_reminder_days FROM throne_guild_settings WHERE birthday_reminder = 1 AND birthday_channel_id IS NOT NULL'
    );
    if (guilds.length === 0) return;

    // Get all linked throne usernames
    const [links] = await pool.execute('SELECT DISTINCT throne_username FROM throne_user_links');
    if (links.length === 0) return;

    const today = new Date();

    for (const { throne_username } of links) {
        const profile = await getCachedProfile(throne_username);
        if (!profile || !profile.birthday) continue;

        // Parse birthday (format: "month/day")
        const [month, day] = profile.birthday.split('/').map(Number);
        if (!month || !day) continue;

        for (const guild of guilds) {
            const daysBefore = guild.birthday_reminder_days || 3;

            // Check if birthday is within X days
            const birthdayThisYear = new Date(today.getFullYear(), month - 1, day);
            if (birthdayThisYear < today) birthdayThisYear.setFullYear(today.getFullYear() + 1);

            const daysUntil = Math.ceil((birthdayThisYear - today) / 86400000);

            if (daysUntil === daysBefore) {
                // Check if already posted this reminder
                const [existing] = await pool.execute(
                    "SELECT id FROM throne_notification_log WHERE guild_id = ? AND throne_username = ? AND notification_type = 'birthday_reminder' AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY) LIMIT 1",
                    [guild.guild_id, throne_username]
                );
                if (existing.length > 0) continue;

                const channel = findChannel(guild.guild_id, guild.birthday_channel_id);
                if (!channel) continue;

                const embed = new EmbedBuilder()
                    .setColor(0xFF69B4) // Pink
                    .setTitle('🎂 Birthday Coming Up!')
                    .setDescription(`**${profile.displayName}**'s birthday is in **${daysUntil} day${daysUntil !== 1 ? 's' : ''}**!\nCheck out their wishlist and surprise them with a gift!`)
                    .setURL(profile.profileUrl)
                    .setTimestamp();

                if (profile.pictureUrl) embed.setThumbnail(profile.pictureUrl);

                const items = await getCachedWishlist(throne_username);
                if (items.length > 0) {
                    embed.addFields({ name: 'Wishlist Items', value: `${items.length} items available`, inline: true });
                    const cheapest = items.filter(i => i.isAvailable).reduce((min, i) => (i.priceRaw || Infinity) < (min.priceRaw || Infinity) ? i : min, items[0]);
                    if (cheapest) embed.addFields({ name: 'Starting From', value: cheapest.priceFormatted || 'N/A', inline: true });
                }

                await channel.send({ embeds: [embed] });
                await pool.execute(
                    "INSERT INTO throne_notification_log (guild_id, throne_username, notification_type, channel_id, details) VALUES (?, ?, 'birthday_reminder', ?, ?)",
                    [guild.guild_id, throne_username, guild.birthday_channel_id, JSON.stringify({ daysUntil })]
                );

                logger.info(`[Throne Scheduler] Posted birthday reminder for ${throne_username} in guild ${guild.guild_id}`);
            }
        }
    }
}

// ─── Monthly Spotlight ───────────────────────────────────────────
async function postMonthlySpotlights() {
    const [guilds] = await pool.execute(
        'SELECT guild_id, spotlight_channel_id FROM throne_guild_settings WHERE monthly_spotlight = 1 AND spotlight_channel_id IS NOT NULL'
    );
    if (guilds.length === 0) return;

    // Get last month's gift data
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const monthName = lastMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    for (const guild of guilds) {
        const channel = findChannel(guild.guild_id, guild.spotlight_channel_id);
        if (!channel) continue;

        // Get tracked usernames for this guild
        const [tracked] = await pool.execute(
            'SELECT throne_username FROM throne_notifications WHERE guild_id = ?',
            [guild.guild_id]
        );
        if (tracked.length === 0) continue;

        // Count notifications from last month
        const [stats] = await pool.execute(
            `SELECT notification_type, COUNT(*) as cnt FROM throne_notification_log
             WHERE guild_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH)
             GROUP BY notification_type`,
            [guild.guild_id]
        );

        const statMap = {};
        for (const s of stats) statMap[s.notification_type] = s.cnt;

        const embed = new EmbedBuilder()
            .setColor(Colors.THRONE)
            .setTitle(`👑 Throne Monthly Spotlight — ${monthName}`)
            .setDescription(`Here's a recap of Throne activity for **${tracked.length}** tracked user${tracked.length !== 1 ? 's' : ''} this server.`)
            .setTimestamp();

        const fields = [];
        if (statMap.item_added) fields.push({ name: 'New Items', value: `${statMap.item_added}`, inline: true });
        if (statMap.gift_received) fields.push({ name: 'Gifts Received', value: `${statMap.gift_received}`, inline: true });
        if (statMap.contribution) fields.push({ name: 'Contributions', value: `${statMap.contribution}`, inline: true });
        if (statMap.milestone) fields.push({ name: 'Milestones', value: `${statMap.milestone}`, inline: true });

        if (fields.length > 0) {
            embed.addFields(fields);
        } else {
            embed.setDescription(embed.data.description + '\n\nNo throne activity recorded this month.');
        }

        await channel.send({ embeds: [embed] });
        logger.info(`[Throne Scheduler] Posted monthly spotlight in guild ${guild.guild_id}`);
    }
}

function findChannel(guildId, channelId) {
    if (global.botManager?.clients) {
        for (const [, botClient] of global.botManager.clients) {
            const guild = botClient.guilds.cache.get(guildId);
            if (guild) { const ch = guild.channels.cache.get(channelId); if (ch) return ch; }
        }
    }
    return null;
}
