/**
 * Timed moderation + moderation housekeeping.
 *
 * Every minute:  lift temporary bans and remove temporary roles whose time is up
 *                (core/timed-moderation-manager.js), and end raid lockdowns whose time is up
 *                (core/raid-lockdown.js — summary, invites back on, channels unlocked). Reads only
 *                due rows, so a restart simply picks up whatever came due while the bot was down —
 *                the first sweep runs shortly after boot, once the bot clients have their guild
 *                caches. A lockdown still running after a restart needs nothing: its row is the state.
 * Every hour:    expire sticky-role records past their guild's retention window
 *                (core/sticky-roles-manager.js), delete channels of closed modmail threads that
 *                a restart left behind and close threads whose channel was deleted by hand
 *                (core/modmail-manager.js), and drop lock records of deleted channels
 *                (core/lockdown-manager.js), and renew Discord's invite / DM pause for servers that
 *                keep it on (it can only be set 24 h ahead; renewed once under 12 h is left) or
 *                lift one we set that nothing wants any more (core/raid-lockdown.js).
 */
import cron from 'node-cron';
import logger from '../utils/logger.js';
import { processDueBans, processDueRoles } from '../core/timed-moderation-manager.js';
import { purgeExpired as purgeStickyRoles } from '../core/sticky-roles-manager.js';
import { sweepModmailChannels } from '../core/modmail-manager.js';
import { pruneStaleLockdowns } from '../core/lockdown-manager.js';
import { sweepExpiredLockdowns, renewIncidentActions } from '../core/raid-lockdown.js';

let minuteTask = null;
let hourlyTask = null;
let bootTimer = null;
let sweeping = false;
let housekeeping = false;
// Sweeps wait until a minute after start: before then a custom bot may still be logging in, and a
// guild it serves would look "unavailable" and burn one of the row's retry attempts.
let notBefore = 0;

export async function runTimedModerationSweep() {
    if (sweeping || Date.now() < notBefore) return;
    sweeping = true;
    try {
        const bans = await processDueBans().catch(err => {
            logger.error('[TimedModerationJob] Temporary-ban sweep failed', { error: err.message, stack: err.stack });
            return 0;
        });
        const roles = await processDueRoles().catch(err => {
            logger.error('[TimedModerationJob] Temporary-role sweep failed', { error: err.message, stack: err.stack });
            return 0;
        });
        const lockdowns = await sweepExpiredLockdowns().catch(err => {
            logger.error('[TimedModerationJob] Raid lockdown sweep failed', { error: err.message, stack: err.stack });
            return 0;
        });
        if (bans || roles || lockdowns) logger.info('[TimedModerationJob] Sweep done', { bansLifted: bans, rolesRemoved: roles, lockdownsEnded: lockdowns });
    } finally {
        sweeping = false;
    }
}

export async function runModerationHousekeeping() {
    if (housekeeping || Date.now() < notBefore) return;
    housekeeping = true;
    try {
        await purgeStickyRoles();
        await sweepModmailChannels().catch(err =>
            logger.error('[TimedModerationJob] Modmail channel sweep failed', { error: err.message, stack: err.stack }));
        await pruneStaleLockdowns().catch(err =>
            logger.error('[TimedModerationJob] Lockdown prune failed', { error: err.message }));
        await renewIncidentActions().catch(err =>
            logger.error('[TimedModerationJob] Incident-action renewal failed', { error: err.message }));
    } finally {
        housekeeping = false;
    }
}

export function startTimedModerationJob() {
    if (minuteTask) return;
    notBefore = Date.now() + 55_000;

    minuteTask = cron.schedule('* * * * *', () => {
        runTimedModerationSweep().catch(err => logger.error('[TimedModerationJob] sweep error', { error: err.message }));
    }, { timezone: 'UTC' });

    hourlyTask = cron.schedule('17 * * * *', () => {
        runModerationHousekeeping().catch(err => logger.error('[TimedModerationJob] housekeeping error', { error: err.message }));
    }, { timezone: 'UTC' });

    // Catch up on anything that came due while the bot was down, once custom bots are logged in.
    bootTimer = setTimeout(() => {
        runTimedModerationSweep()
            .then(() => runModerationHousekeeping())
            .catch(err => logger.error('[TimedModerationJob] boot catch-up failed', { error: err.message }));
    }, 60_000);
    bootTimer.unref?.();

    logger.info('[TimedModerationJob] started (every minute; housekeeping hourly at :17 UTC)');
}

export function stopTimedModerationJob() {
    if (minuteTask) { minuteTask.stop(); minuteTask = null; }
    if (hourlyTask) { hourlyTask.stop(); hourlyTask = null; }
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
}

export default { startTimedModerationJob, stopTimedModerationJob, runTimedModerationSweep, runModerationHousekeeping };
