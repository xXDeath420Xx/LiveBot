/**
 * Fourthwall shop tracker scheduler.
 *
 * Polls every tracked public Fourthwall shop every N minutes, diffs the
 * product catalog against the persistent snapshot, and posts events to
 * subscribed channels.
 *
 * Default: every 10 minutes. Tunable via FOURTHWALL_TRACKER_CRON env var
 * (standard 5-field cron expression).
 *
 * On-startup behavior: we DON'T run an immediate scrape. The first cycle
 * fires on the next cron tick. This avoids hammering shops every time PM2
 * reloads.
 */

import cron from 'node-cron';
import logger from '../utils/logger.js';
import { runCycle } from '../core/fourthwall-shop-tracker.js';

const DEFAULT_CRON = '*/10 * * * *';

let task = null;
let running = false;

async function tick() {
    if (running) {
        logger.warn('[FW Tracker] previous cycle still running, skipping this tick');
        return;
    }
    running = true;
    const started = Date.now();
    try {
        const result = await runCycle();
        const dur = Date.now() - started;
        if (result.shopsScanned > 0) {
            logger.info('[FW Tracker] cycle complete', {
                shopsScanned: result.shopsScanned,
                eventsFired: result.eventsFired,
                durationMs: dur
            });
        }
    } catch (err) {
        logger.error('[FW Tracker] cycle threw', { err: err.message, stack: err.stack });
    } finally {
        running = false;
    }
}

export function startFourthwallTracker() {
    if (task) return;
    const expr = process.env.FOURTHWALL_TRACKER_CRON || DEFAULT_CRON;
    if (!cron.validate(expr)) {
        logger.error('[FW Tracker] invalid cron expression — falling back to default', {
            expr, fallback: DEFAULT_CRON
        });
    }
    const useExpr = cron.validate(expr) ? expr : DEFAULT_CRON;
    task = cron.schedule(useExpr, tick);
    logger.info('[FW Tracker] scheduled', { cron: useExpr });
}

export function stopFourthwallTracker() {
    if (task) { task.stop(); task = null; }
}
