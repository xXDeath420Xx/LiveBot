import cron from 'node-cron';
import logger from '../utils/logger.js';
import { runTick } from '../core/event-reminder-manager.js';

/*
 * Discord scheduled-event reminders, start announcements and recurring templates
 * (core/event-reminder-manager.js). Runs once per process, every minute; the manager resolves the
 * owning bot per guild via botManager, so custom-bot guilds are served by their own bot.
 *
 * All due work comes from persisted timestamps (scheduled_events_config, event_subscriptions,
 * recurring_events), so the first tick after a restart picks up anything that came due while the
 * process was down — within the reminder/announcement windows.
 */
let task = null;
let running = false;

async function tick(client) {
    if (running) return; // a slow DM batch must not overlap the next minute
    running = true;
    try {
        await runTick(client);
    } catch (err) {
        logger.error(`[EventReminders] tick failed: ${err.message}`, { stack: err.stack });
    } finally {
        running = false;
    }
}

export function startEventReminderScheduler(client) {
    if (task) return;
    task = cron.schedule('* * * * *', () => tick(client));
    // Catch up shortly after boot instead of waiting for the first full minute.
    setTimeout(() => tick(client), 45_000);
    logger.info('[EventReminders] Scheduler started (every minute)');
}

export function stopEventReminderScheduler() {
    if (task) {
        task.stop();
        task = null;
    }
}

export default { startEventReminderScheduler, stopEventReminderScheduler };
