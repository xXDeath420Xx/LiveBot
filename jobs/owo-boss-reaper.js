/*
 * OwO guild boss: retire bosses whose timer ran out.
 *
 * A boss lingers for BOSS_LIFETIME_MS. If nobody finishes it in that window it "runs away". This
 * sweep flips those bosses to `fled` and, where it can still find the announcement, edits it to the
 * fled state so the message stops inviting fights. Idempotent — a boss already resolved is skipped.
 */
import cron from 'node-cron';
import logger from '../utils/logger.js';
import { findExpiredBosses, expireBoss, getActiveBoss } from '../core/owo/guildboss-service.js';
import { renderBoss } from '../core/owo/guildboss-text.js';

let task = null;

/** Resolve a guild across the main client and any custom-bot clients. */
function findGuild(client, guildId) {
  let guild = client?.guilds?.cache?.get(guildId);
  if (!guild && global.botManager?.clients) {
    for (const [, c] of global.botManager.clients) {
      guild = c.guilds.cache.get(guildId);
      if (guild) return { guild, client: c };
    }
  }
  return guild ? { guild, client } : null;
}

async function sweep(client) {
  const guildIds = await findExpiredBosses();
  for (const guildId of guildIds) {
    // Capture the message location BEFORE we flip it inactive (getActiveBoss returns null after).
    const active = await getActiveBoss(guildId).catch(() => null);
    const boss = await expireBoss(guildId);
    if (!boss) continue;

    if (!active?.messageId || !active.channelId) continue;
    const found = findGuild(client, guildId);
    if (!found) continue;
    const channel = found.guild.channels.cache.get(active.channelId)
      ?? await found.client.channels.fetch(active.channelId).catch(() => null);
    const msg = await channel?.messages?.fetch(active.messageId).catch(() => null);
    if (msg) await msg.edit(await renderBoss(active, 'fled')).catch(() => {});
  }
  if (guildIds.length) logger.info(`[OwO boss] ${guildIds.length} boss(es) fled`);
}

export function startOwoBossReaper(client) {
  if (task) return task;
  // Every 2 minutes: bosses live ~an hour, and a couple minutes of slack on "ran away" is fine.
  task = cron.schedule('*/2 * * * *', () => sweep(client).catch(err =>
    logger.error(`[OwO boss] reaper failed: ${err.message}`)));
  logger.info('[OwO boss] reaper started');
  return task;
}

export function stopOwoBossReaper() {
  if (task) { task.stop(); task = null; }
}
