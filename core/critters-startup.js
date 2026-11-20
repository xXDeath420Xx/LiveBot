/*
 * Critters startup and shutdown, called from index.js once the client is ready.
 *
 * markLiveSince(): stamps critter_meta.live_since the first time the new module runs (INSERT IGNORE, so later
 * boots keep the first stamp). Migration 463's refresh mode reads it as the cut-over point. A missing table
 * (migration not run yet) is only a warning; it never blocks startup.
 * Then the three jobs (lottery draw, escrow sweeper, boss reaper) from core/critters/jobs.js start; each start is
 * idempotent.
 */
import { startCritterJobs, stopCritterJobs } from './critters/jobs.js';
import logger from '../utils/logger.js';

export async function markLiveSince(pool = null) {
    try {
        const db = pool || (await import('../utils/db.js')).default;
        await db.query("INSERT IGNORE INTO critter_meta (meta_key, meta_value) VALUES ('live_since', UTC_TIMESTAMP(6))");
        return true;
    } catch (err) {
        logger.warn('[critters] could not stamp live_since (has migration 463 run?)', { error: err.message });
        return false;
    }
}

export async function startCritters(client) {
    await markLiveSince();
    return startCritterJobs(client);
}

export function stopCritters() {
    stopCritterJobs();
}
