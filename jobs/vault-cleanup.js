/*
 * Vault housekeeping.
 *
 * Two passes, because they have very different costs and very different urgency.
 *
 * Every minute (shallow): delete files whose expiry has passed. Retention is settable in
 *   minutes, so "delete this in 5 minutes" has to mean roughly that; an hourly pass would turn
 *   it into "some time within the hour". Two indexed queries, and usually zero rows.
 *
 * Hourly (deep): also reap .part files from uploads nobody finished (a 5 GB upload abandoned at
 *   90% is 4.5 GB of nothing) and .bin files on disk with no database row, left by a crash
 *   between rename() and INSERT. Both need a directory scan, neither is time-critical.
 *
 * Note that expiry is enforced at request time as well - a file past its date will not download
 * even in the seconds before the sweeper reaches it. This job reclaims the disk; it is not the
 * thing standing between an expired file and the person asking for it.
 */
import cron from 'node-cron';
import logger from '../utils/logger.js';
import { sweep, ensureStorage, ensureOwnerMember } from '../core/vault-manager.js';

let fastTask = null;
let deepTask = null;

async function run(deep) {
  try {
    const r = await sweep({ deep });
    if (r.files || r.uploads || r.orphans) {
      logger.info(`[Vault] swept ${r.files} expired file(s), ${r.uploads} stale upload(s), ${r.orphans} orphan(s)`);
    }
  } catch (err) {
    logger.error(`[Vault] sweep failed: ${err.message}`);
  }
}

export function startVaultCleanup() {
  if (fastTask) return fastTask;
  ensureStorage().catch(err => logger.error(`[Vault] storage dir: ${err.message}`));
  // Self-heal: if the owner's row is gone, put it back. isMember() already treats the owner as
  // a member regardless, so this is about the list telling the truth, not about access.
  ensureOwnerMember().catch(err => logger.error(`[Vault] owner row check: ${err.message}`));

  fastTask = cron.schedule('* * * * *', () => run(false));
  deepTask = cron.schedule('23 * * * *', () => run(true));
  logger.info('[Vault] cleanup scheduler started (expiry every minute, deep sweep hourly)');
  return fastTask;
}

export function stopVaultCleanup() {
  if (fastTask) { fastTask.stop(); fastTask = null; }
  if (deepTask) { deepTask.stop(); deepTask = null; }
}
