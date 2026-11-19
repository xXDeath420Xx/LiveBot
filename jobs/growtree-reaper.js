/*
 * The tree channel keeps itself clean.
 *
 * An encounter is a transient event: it appears, someone races for it, and it goes away again. The
 * tree message is the only thing meant to survive, so nothing an encounter posts is allowed to
 * outlive it — not a missed bug, and not the "caught it!" result.
 *
 * Two things get swept:
 *   1. Encounters nobody caught. The message is deleted outright — previously it was edited to say
 *      the bug flew away, which stopped the button lying but still left a message behind forever.
 *   2. Encounters that WERE resolved but whose message is somehow still there. A claim deletes its
 *      own message after a short linger, but that linger is an in-process timer; a restart mid-linger
 *      would strand the message permanently. This is the backstop that guarantees it goes.
 */
import cron from 'node-cron';
import logger from '../utils/logger.js';
import { reapExpired, markReaped, staleEncounterMessages, clearEncounterMessage } from '../core/growtree/critters.js';

let task = null;

/** Delete an encounter's message, whichever bot actually serves that guild. */
async function removeMessage(row) {
  // With custom bots there is no single client, and the default one is very often not in the server.
  const client = global.botManager?.getClientForGuild(row.guild_id)
    ?? global.botManager?.getDefaultClient();
  if (!client) return;

  const channel = await client.channels.fetch(row.channel_id).catch(() => null);
  const msg = channel ? await channel.messages.fetch(row.message_id).catch(() => null) : null;
  if (msg) await msg.delete().catch(() => {});
}

async function sweep() {
  try {
    const missed = await reapExpired();
    for (const row of missed) {
      try {
        await removeMessage(row);
      } catch (err) {
        logger.warn(`[GrowTree] could not close encounter ${row.id}: ${err.message}`);
      } finally {
        // Marked either way. A message we can no longer reach (deleted channel, purged message) must
        // not be retried every minute for the rest of time.
        await markReaped(row.id).catch(() => {});
        await clearEncounterMessage(row.id).catch(() => {});
      }
    }

    // Restart-orphaned results — the claim landed but its delete timer never fired.
    const stale = await staleEncounterMessages();
    for (const row of stale) {
      try {
        await removeMessage(row);
      } catch (err) {
        logger.warn(`[GrowTree] could not clear stale encounter ${row.id}: ${err.message}`);
      } finally {
        await clearEncounterMessage(row.id).catch(() => {});
      }
    }

    const n = missed.length + stale.length;
    if (n) logger.info(`[GrowTree] cleared ${n} encounter message(s) (${missed.length} missed, ${stale.length} orphaned)`);
  } catch (err) {
    logger.error(`[GrowTree] reaper failed: ${err.message}`);
  }
}

export function startGrowTreeReaper() {
  if (task) return task;
  task = cron.schedule('* * * * *', sweep);   // every minute; encounters last 20-25s
  logger.info('[GrowTree] encounter reaper started');
  return task;
}

export function stopGrowTreeReaper() {
  if (task) { task.stop(); task = null; }
}

export default { startGrowTreeReaper, stopGrowTreeReaper };
