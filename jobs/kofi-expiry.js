/*
 * Ko-fi: strip supporter roles once their window lapses.
 *
 * Ko-fi never tells us a membership was cancelled — it simply stops sending renewals. So
 * entitlement is a sliding expiry that each payment extends, and this job reaps whatever
 * has fallen behind. Idempotent: a role already gone is a no-op.
 */
import cron from 'node-cron';
import logger from '../utils/logger.js';
import { expireLapsed } from '../core/kofi-manager.js';

let task = null;

export function startKofiExpiry(client) {
  if (task) return task;
  // Hourly, not daily: a 31-day window should not hinge on when the process restarted.
  task = cron.schedule('17 * * * *', async () => {
    try {
      await expireLapsed(client);
    } catch (err) {
      logger.error(`[Kofi] expiry sweep failed: ${err.message}`);
    }
  });
  logger.info('[Kofi] expiry sweeper started');
  return task;
}

export function stopKofiExpiry() {
  if (task) { task.stop(); task = null; }
}
