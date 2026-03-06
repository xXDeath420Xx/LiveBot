import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { EmbedBuilder } from 'discord.js';

const REMINDER_TYPES = {
    water: { emoji: '', name: 'Water Your Plants', color: '#3498DB' },
    feed: { emoji: '', name: 'Feed Your Plants', color: '#27AE60' },
    check: { emoji: '', name: 'Check Your Plants', color: '#9B59B6' },
    defoliate: { emoji: '', name: 'Time to Defoliate', color: '#2ECC71' },
    train: { emoji: '', name: 'Training Time', color: '#E67E22' },
    flip: { emoji: '', name: 'Consider Flipping to Flower', color: '#FF69B4' },
    harvest: { emoji: '', name: 'Check Harvest Readiness', color: '#F1C40F' },
    custom: { emoji: '', name: 'Grow Reminder', color: '#95A5A6' }
};

/**
 * Check and process due grow reminders
 */
async function checkGrowReminders(client) {
    try {
        // Build guild filter for multi-bot support
        let guildFilter = '';
        const params = [];

        if (client.isDefaultBot) {
            guildFilter = `AND gr.guild_id NOT IN (SELECT gbm.guild_id FROM guild_bot_mapping gbm)`;
        } else if (client.botId) {
            guildFilter = `AND gr.guild_id IN (SELECT gbm.guild_id FROM guild_bot_mapping gbm WHERE gbm.bot_id = ?)`;
            params.push(client.botId);
        }

        const [reminders] = await pool.execute(
            `SELECT gr.*, gj.title as journal_title, gj.strain_name
             FROM grow_reminders gr
             LEFT JOIN grow_journals gj ON gr.journal_id = gj.id
             WHERE gr.is_active = TRUE AND gr.next_reminder <= NOW() ${guildFilter}`,
            params
        );

        if (reminders.length === 0) return;

        const botInfo = client.isDefaultBot ? 'default bot' : `custom bot ${client.botId}`;
        logger.info(`[GrowReminder] Processing ${reminders.length} due grow reminders for ${botInfo}`);

        for (const reminder of reminders) {
            try {
                const guildClient = global.botManager?.getClientForGuild(reminder.guild_id) || client;
                await sendGrowReminder(reminder, guildClient);

                // Update the reminder
                if (reminder.repeat_interval_hours && reminder.repeat_interval_hours > 0) {
                    // Schedule next occurrence
                    const nextReminder = new Date(Date.now() + reminder.repeat_interval_hours * 60 * 60 * 1000);
                    await pool.execute(
                        'UPDATE grow_reminders SET next_reminder = ?, last_sent = NOW() WHERE id = ?',
                        [nextReminder, reminder.id]
                    );
                    logger.info(`[GrowReminder] Scheduled next reminder ${reminder.id} for ${nextReminder.toISOString()}`);
                } else {
                    // Delete one-time reminder
                    await pool.execute('DELETE FROM grow_reminders WHERE id = ?', [reminder.id]);
                    logger.info(`[GrowReminder] Deleted one-time reminder ${reminder.id}`);
                }
            } catch (error) {
                logger.error(`[GrowReminder] Failed to process reminder ${reminder.id}: ${error.message}`);
            }
        }
    } catch (error) {
        logger.error(`[GrowReminder] Error checking grow reminders: ${error.message}`);
    }
}

/**
 * Send a grow reminder to the user
 */
async function sendGrowReminder(reminder, client) {
    try {
        const user = await client.users.fetch(reminder.user_id).catch(() => null);
        if (!user) {
            logger.warn(`[GrowReminder] Could not find user ${reminder.user_id}`);
            return;
        }

        const typeInfo = REMINDER_TYPES[reminder.reminder_type] || REMINDER_TYPES.custom;

        const embed = new EmbedBuilder()
            .setColor(typeInfo.color)
            .setTitle(`${typeInfo.emoji} ${typeInfo.name}`)
            .setTimestamp();

        if (reminder.custom_message) {
            embed.setDescription(reminder.custom_message);
        }

        if (reminder.journal_title) {
            embed.addFields({
                name: 'Linked Journal',
                value: `${reminder.journal_title}${reminder.strain_name ? ` (${reminder.strain_name})` : ''}`,
                inline: false
            });
        }

        if (reminder.repeat_interval_hours) {
            const repeatText = reminder.repeat_interval_hours === 24 ? 'daily' :
                              reminder.repeat_interval_hours === 168 ? 'weekly' :
                              `every ${reminder.repeat_interval_hours} hours`;
            embed.setFooter({ text: `Repeats ${repeatText} | Use /growreminder to manage` });
        } else {
            embed.setFooter({ text: 'One-time reminder | Use /growreminder to set more' });
        }

        if (reminder.use_dm) {
            await user.send({ embeds: [embed] });
            logger.info(`[GrowReminder] Sent DM reminder to user ${user.id}`);
        } else if (reminder.channel_id) {
            const channel = await client.channels.fetch(reminder.channel_id).catch(() => null);
            if (channel && channel.isTextBased()) {
                await channel.send({ content: `<@${reminder.user_id}>`, embeds: [embed] });
                logger.info(`[GrowReminder] Sent channel reminder to ${channel.id}`);
            } else {
                // Fallback to DM
                await user.send({ embeds: [embed] });
                logger.info(`[GrowReminder] Channel not found, sent DM to ${user.id}`);
            }
        } else {
            await user.send({ embeds: [embed] });
        }
    } catch (error) {
        logger.error(`[GrowReminder] Failed to send reminder: ${error.message}`);
    }
}

/**
 * Initialize the grow reminder scheduler
 */
export function initGrowReminderScheduler(client) {
    logger.info('[GrowReminder] Initializing grow reminder scheduler');

    // Check every 60 seconds
    const intervalMs = 60 * 1000;

    // Check immediately
    checkGrowReminders(client);

    // Then on interval
    setInterval(() => checkGrowReminders(client), intervalMs);

    // Also start for custom bots
    if (global.botManager?.clients) {
        for (const [botId, botClient] of global.botManager.clients.entries()) {
            if (botId === 'default') continue;
            setInterval(() => checkGrowReminders(botClient), intervalMs);
            logger.info(`[GrowReminder] Started scheduler for custom bot ${botId}`);
        }
    }

    logger.info('[GrowReminder] Grow reminder scheduler initialized');
}

export default initGrowReminderScheduler;
