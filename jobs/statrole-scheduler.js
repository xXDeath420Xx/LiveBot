import cron from 'node-cron';
import logger from '../utils/logger.js';
import { sweepAllGuilds } from '../core/statrole-manager.js';

/*
 * Stat roles sweep (core/statrole-manager.js): every 15 minutes, for each guild with rules in
 * statrole_configs, grant roles members have earned (and take back bot-granted roles where a rule
 * opts into removal). Event hooks handle the common case instantly; this catches everything they
 * cannot see — earned while the bot was down, invites, account age, rules just added.
 */
let task = null;
let running = false;

async function run(client) {
    if (running) return;
    running = true;
    try {
        await sweepAllGuilds(client);
    } catch (err) {
        logger.error(`[StatRoles] Sweep run failed: ${err.message}`, { stack: err.stack });
    } finally {
        running = false;
    }
}

export function startStatRoleScheduler(client) {
    if (task) return;
    task = cron.schedule('*/15 * * * *', () => run(client));
    setTimeout(() => run(client), 2 * 60_000); // after boot, once guild caches are warm
    logger.info('[StatRoles] Scheduler started (every 15 min)');
}

export function stopStatRoleScheduler() {
    if (task) {
        task.stop();
        task = null;
    }
}

export default { startStatRoleScheduler, stopStatRoleScheduler };
