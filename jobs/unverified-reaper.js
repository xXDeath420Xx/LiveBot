// The "still Unverified after N days" sweep (verify_config.unverified_kick_days) now runs inside the one
// member reaper, jobs/temp-access-reaper.js (daily, 03:00 UTC), with the logic in core/verification.js
// (sweepUnverifiedDays) and every kick through protectionHold. This file stays so index.js's start/stop
// calls keep working; it no longer schedules anything itself. The column it used to add at runtime is
// created by migrations/328_verify_prune.js.
import logger from '../utils/logger.js';
import { runUnverifiedSweep } from './temp-access-reaper.js';

/** Run the sweep now (kept for anything that called it by hand). */
export async function runReaperSweep() {
    return runUnverifiedSweep();
}

export function startUnverifiedReaper() {
    logger.info('[UnverifiedReaper] runs inside the temporary-access reaper now (daily 03:00 UTC)');
}

export function stopUnverifiedReaper() { /* the temporary-access reaper owns the schedule */ }
