import cron from 'node-cron';
import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { getConfig } from '../core/feature-config.js';
import { themeColor } from '../core/guild-theme.js';

let scheduledTask = null;
let reminderTask = null;
let challengeTask = null;
let defaultClient = null;

function isOn(v) {
  return v === true || v === 1 || v === '1';
}

function clientFor(guildId) {
  const c = global.botManager?.getClientForGuild?.(guildId) || defaultClient;
  return c?.guilds?.cache?.has(guildId) ? c : null;
}

/**
 * Habit reminders (Self-Care page, "Send habit reminders by DM"): who to remind today.
 * A habit is due when it was done at least once in the last 7 days but not yet today, so a habit
 * someone stopped using a week ago stops producing DMs. Grouped per member per server, and only
 * for servers where Self-Care is on and reminder DMs are on.
 */
export async function collectHabitReminders() {
  const [rows] = await pool.execute(
    `SELECT h.guild_id, h.user_id, h.habit_name, h.streak
       FROM habits h
      WHERE EXISTS (SELECT 1 FROM habit_completions c
                     WHERE c.habit_id = h.id AND c.completed_date >= CURDATE() - INTERVAL 7 DAY)
        AND NOT EXISTS (SELECT 1 FROM habit_completions c
                         WHERE c.habit_id = h.id AND c.completed_date = CURDATE())
      ORDER BY h.guild_id, h.user_id, h.streak DESC, h.habit_name`
  );
  const byMember = new Map();
  const allowed = new Map();
  for (const r of rows) {
    if (!allowed.has(r.guild_id)) {
      const cfg = await getConfig('selfcare', r.guild_id);
      allowed.set(r.guild_id, isOn(cfg.enabled) && isOn(cfg.reminder_dm));
    }
    if (!allowed.get(r.guild_id)) continue;
    const key = `${r.guild_id}:${r.user_id}`;
    if (!byMember.has(key)) byMember.set(key, { guildId: r.guild_id, userId: r.user_id, habits: [] });
    byMember.get(key).habits.push({ name: r.habit_name, streak: Number(r.streak) || 0 });
  }
  return [...byMember.values()];
}

/** Send today's habit reminder DMs. Runs at 20:00 UTC, four hours before habits roll over. */
export async function sendHabitReminders() {
  const due = await collectHabitReminders();
  if (!due.length) return 0;
  const resetAt = new Date();
  resetAt.setUTCHours(24, 0, 0, 0);
  let sent = 0;
  for (const { guildId, userId, habits } of due) {
    const client = clientFor(guildId);
    if (!client) continue;
    try {
      const user = await client.users.fetch(userId).catch(() => null);
      if (!user) continue;
      const guildName = client.guilds.cache.get(guildId)?.name || 'your server';
      const list = habits.slice(0, 15).map(h => `- **${h.name}**${h.streak > 0 ? ` (${h.streak}-day streak)` : ''}`).join('\n');
      const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'primary'))
        .setTitle('Habit check-in')
        .setDescription(`You haven't marked ${habits.length === 1 ? 'this habit' : 'these habits'} done today in **${guildName}**:\n${list}\n\nThe day ends <t:${Math.floor(resetAt.getTime() / 1000)}:R>. Use \`/selfcare habit complete\` there to keep your streak.`)
        .setFooter({ text: `Sent because reminders are on for Self-Care in ${guildName}.`.slice(0, 2048) });
      await user.send({ embeds: [embed] });
      sent++;
    } catch (error) {
      // Closed DMs are the usual reason; nothing to do about it.
      logger.debug(`[HabitTrackerScheduler] Could not DM habit reminder to ${userId}: ${error.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  logger.info(`[HabitTrackerScheduler] Sent ${sent} habit reminder DM(s)`);
  return sent;
}

/** Yesterday's daily-challenge results for a server: { members, completed, top: [{ user_id, done }] }. */
export async function challengeSummary(guildId) {
  const [[totals]] = await pool.execute(
    `SELECT COUNT(DISTINCT user_id) AS members, COUNT(*) AS completed
       FROM user_daily_challenges
      WHERE guild_id = ? AND assigned_date = CURDATE() - INTERVAL 1 DAY AND completed = 1`,
    [guildId]
  );
  const [top] = await pool.execute(
    `SELECT user_id, COUNT(*) AS done
       FROM user_daily_challenges
      WHERE guild_id = ? AND assigned_date = CURDATE() - INTERVAL 1 DAY AND completed = 1
      GROUP BY user_id
      ORDER BY done DESC, MIN(completed_at) ASC
      LIMIT 5`,
    [guildId]
  );
  return { members: Number(totals?.members) || 0, completed: Number(totals?.completed) || 0, top };
}

/** The post for the Self-Care page's "Daily challenge channel". */
export function dailyChallengeEmbed(guildId, summary) {
  const embed = new EmbedBuilder()
    .setColor(themeColor(guildId, 'primary'))
    .setTitle('New daily challenges')
    .setDescription('Everyone has three fresh challenges for today. See yours with `/selfcare challenges view` and collect rewards with `/selfcare challenges claim`.')
    .setTimestamp();
  if (summary.completed > 0) {
    const lines = summary.top.map((r, i) => `${i + 1}. <@${r.user_id}> - ${r.done} done`).join('\n');
    embed.addFields({
      name: 'Yesterday',
      value: `${summary.members} ${summary.members === 1 ? 'member' : 'members'} finished ${summary.completed} ${summary.completed === 1 ? 'challenge' : 'challenges'}.\n${lines}`.slice(0, 1024),
    });
  } else {
    embed.addFields({ name: 'Yesterday', value: 'Nobody finished a challenge. Today is a good day to start.' });
  }
  return embed;
}

/** Post the new day's challenge notice in every server that set a daily challenge channel. */
export async function postDailyChallenges() {
  const [rows] = await pool.execute(
    `SELECT guild_id FROM guild_feature_config
      WHERE feature_key = 'selfcare'
        AND JSON_UNQUOTE(JSON_EXTRACT(config, '$.daily_challenge_channel_id')) REGEXP '^[0-9]{17,20}$'`
  );
  let posted = 0;
  for (const { guild_id: guildId } of rows) {
    try {
      const cfg = await getConfig('selfcare', guildId);
      if (!isOn(cfg.enabled)) continue;
      const client = clientFor(guildId);
      if (!client) continue;
      const channelId = String(cfg.daily_challenge_channel_id);
      const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased?.() || channel.guildId !== guildId) continue;
      const embed = dailyChallengeEmbed(guildId, await challengeSummary(guildId));
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      posted++;
    } catch (error) {
      logger.warn(`[HabitTrackerScheduler] Daily challenge post failed for ${guildId}: ${error.message}`);
    }
  }
  if (posted) logger.info(`[HabitTrackerScheduler] Posted daily challenges in ${posted} server(s)`);
  return posted;
}

/**
 * Start the habit tracker scheduler
 * Checks for broken streaks and resets them daily
 * @param {Client} client - Discord client instance
 */
export function startHabitTrackerScheduler(client) {
  if (scheduledTask) {
    logger.info('[HabitTrackerScheduler] Scheduler already running');
    return;
  }
  defaultClient = client;

  // Self-Care page settings. Both run on the server clock (UTC), the same day habits and
  // daily challenges use.
  reminderTask = cron.schedule('0 20 * * *', () => {
    sendHabitReminders().catch(error => logger.error('[HabitTrackerScheduler] Habit reminders failed', { error: error.message }));
  });
  challengeTask = cron.schedule('1 0 * * *', () => {
    postDailyChallenges().catch(error => logger.error('[HabitTrackerScheduler] Daily challenge posts failed', { error: error.message }));
  });

  // Run daily at midnight to check for broken streaks
  scheduledTask = cron.schedule('0 0 * * *', async () => {
    logger.info('[HabitTrackerScheduler] Checking for broken habit streaks');

    try {
      // Get all habits that have a current streak
      const [habits] = await pool.execute(
        'SELECT * FROM habits WHERE streak > 0'
      );

      if (habits.length === 0) {
        logger.debug('[HabitTrackerScheduler] No active habit streaks found');
        return;
      }

      logger.info(`[HabitTrackerScheduler] Checking ${habits.length} habit(s) with active streaks`);

      let brokenStreaks = 0;

      for (const habit of habits) {
        try {
          // Check if habit was completed yesterday
          const [[completion]] = await pool.execute(
            `SELECT * FROM habit_completions
             WHERE habit_id = ? AND completed_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)`,
            [habit.id]
          );

          // If habit was NOT completed yesterday, the streak is broken
          if (!completion) {
            await pool.execute(
              'UPDATE habits SET streak = 0 WHERE id = ?',
              [habit.id]
            );

            brokenStreaks++;

            logger.debug(`[HabitTrackerScheduler] Streak broken for habit ${habit.id} (${habit.habit_name})`);
          }
        } catch (error) {
          logger.error(`[HabitTrackerScheduler] Error checking habit ${habit.id}`, {
            error: error.message,
            stack: error.stack
          });
        }
      }

      logger.info(`[HabitTrackerScheduler] Completed habit check - ${brokenStreaks} streak(s) broken`);
    } catch (error) {
      logger.error('[HabitTrackerScheduler] Error checking habits', {
        error: error.message,
        stack: error.stack
      });
    }
  });

  logger.info('[HabitTrackerScheduler] Scheduler started (runs daily at midnight)');
  scheduledTask.start();
}

/**
 * Stop the habit tracker scheduler
 */
export function stopHabitTrackerScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info('[HabitTrackerScheduler] Scheduler stopped');
  }
  reminderTask?.stop();
  challengeTask?.stop();
  reminderTask = challengeTask = null;
}
