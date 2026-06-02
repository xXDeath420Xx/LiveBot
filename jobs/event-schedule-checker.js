import cron from 'node-cron';
import logger from '../utils/logger.js';
import EventScheduleManager from '../core/event-schedule-manager.js';

let task = null;
let manager = null;

export function startEventScheduleChecker(client) {
  if (task) return; // singleton
  manager = new EventScheduleManager(client);
  task = cron.schedule('*/5 * * * *', async () => {
    try { await manager.processAll(); } catch (e) { logger.error(`[EventSchedule] cycle error: ${e.message}`); }
  });
  logger.info('[EventSchedule] Checker started (every 5 min)');
}

export function getEventScheduleManager() { return manager; }
export function stopEventScheduleChecker() { if (task) { task.stop(); task = null; } }
export default { startEventScheduleChecker, stopEventScheduleChecker, getEventScheduleManager };
