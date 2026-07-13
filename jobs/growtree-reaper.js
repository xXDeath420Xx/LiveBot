/*
 * A bug that nobody catches has to actually fly away.
 *
 * Without this, a missed encounter sits in the channel forever showing a live "Swing the net!"
 * button. People click it, are told they were too slow, and are quite reasonably annoyed — the
 * message said it was still there. The message has to stop lying.
 */
import cron from 'node-cron';
import logger from '../utils/logger.js';
import { reapExpired, markReaped } from '../core/growtree/critters.js';
import { missedMessage } from '../interactions/buttons/tree_catch.js';

let task = null;

async function sweep() {
  try {
    const rows = await reapExpired();
    if (!rows.length) return;

    for (const row of rows) {
      try {
        // Whichever bot actually serves this guild — with custom bots there is no single client, and
        // the default one is very often not even in the server.
        const client = global.botManager?.getClientForGuild(row.guild_id)
          ?? global.botManager?.getDefaultClient();
        if (!client) continue;

        const channel = await client.channels.fetch(row.channel_id).catch(() => null);
        const msg = channel ? await channel.messages.fetch(row.message_id).catch(() => null) : null;
        if (msg) await msg.edit(missedMessage(row)).catch(() => {});
      } catch (err) {
        logger.warn(`[GrowTree] could not close encounter ${row.id}: ${err.message}`);
      } finally {
        // Marked either way. A message we can no longer reach (deleted channel, purged message) must
        // not be retried every minute for the rest of time.
        await markReaped(row.id).catch(() => {});
      }
    }
    logger.info(`[GrowTree] closed ${rows.length} missed encounter(s)`);
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
