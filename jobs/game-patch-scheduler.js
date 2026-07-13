import cron from 'node-cron';
import logger from '../utils/logger.js';

let scheduledTask = null;
let initialPrimingScheduled = false;

/**
 * Yield every loaded bot client (main + custom) by reading global.botManager
 * fresh on each invocation — same pattern as stream-check-scheduler. Avoids
 * the init-order dependency that previously broke things when one custom
 * bot hung during command deployment and blocked Promise.allSettled.
 */
function* iterateAllBotClients() {
  if (!global.botManager || !global.botManager.clients) return;
  for (const [, botClient] of global.botManager.clients.entries()) {
    yield botClient;
  }
}

/**
 * Start the game-patch watcher scheduler.
 * Runs every 15 minutes; each client polls game_patch_watchers rows for
 * guilds it actually serves (the manager filters by guild membership).
 *
 * First poll for a freshly-created watcher row PRIMES last_seen_ids and
 * does not post — second poll onwards is when actual new patches fire.
 *
 * Idempotent — only the first call wires up cron; subsequent calls
 * (from custom-bot init loop) are no-ops.
 */
// eslint-disable-next-line no-unused-vars
export function startGamePatchScheduler(client) {
  if (scheduledTask) return;

  scheduledTask = cron.schedule('*/15 * * * *', async () => {
    try {
      for (const c of iterateAllBotClients()) {
        if (c.gamePatchWatcherManager) {
          await c.gamePatchWatcherManager.pollAll();
        }
      }
    } catch (error) {
      logger.error('[GamePatchScheduler] Poll cycle failed', { error: error.message, stack: error.stack });
    }
  });
  scheduledTask.start();
  logger.info('[GamePatchScheduler] Started (every 15 minutes)');

  if (!initialPrimingScheduled) {
    initialPrimingScheduled = true;
    // First poll merely PRIMES freshly-created watchers — no posting on initial run.
    setTimeout(async () => {
      const all = [...iterateAllBotClients()];
      logger.info(`[GamePatchScheduler] Initial priming pass across ${all.length} client(s)`);
      for (const c of all) {
        if (c.gamePatchWatcherManager) {
          await c.gamePatchWatcherManager.pollAll().catch(err => {
            logger.error('[GamePatchScheduler] Initial pass error', { error: err.message });
          });
        }
      }
    }, 60000);
  }
}

export function stopGamePatchScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  initialPrimingScheduled = false;
  logger.info('[GamePatchScheduler] Stopped');
}
