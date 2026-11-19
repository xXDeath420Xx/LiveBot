/*
 * OwO friendly-battle bets: return stakes that were left in escrow (CC-BY-NC-SA derivative — see
 * /LICENSE-OWO-NOTICE.md).
 *
 * A bet is debited into owo_user_battle when a challenge is made / accepted and paid out when the
 * battle settles (core/owo/battle-pvp.js). If the process restarts in between, or a settlement
 * fails, the row keeps its escrow and an expires_at. Every minute (and once shortly after boot)
 * this refunds every expired escrow and, where it can still find the challenge message, edits it
 * so nobody keeps waiting on a dead challenge. Idempotent: each row is re-checked under lock.
 */
import cron from 'node-cron';
import logger from '../utils/logger.js';
import { sweepExpiredChallenges } from '../core/owo/battle-pvp.js';

let task = null;
let bootTimer = null;
let running = false;

function findChannel(client, guildId, channelId) {
  const clients = [client];
  if (global.botManager?.clients) for (const [, c] of global.botManager.clients) clients.push(c);
  for (const c of clients) {
    const guild = c?.guilds?.cache?.get(guildId);
    if (guild) return { guild, client: c };
  }
  return null;
}

async function sweep(client) {
  if (running) return;
  running = true;
  try {
    const refunded = await sweepExpiredChallenges();
    for (const r of refunded) {
      const total = Object.values(r.refunded).reduce((s, n) => s + n, 0);
      logger.info('[OwO battle] expired challenge refunded', { guildId: r.guildId, sender: r.sender, receiver: r.receiver, total });
      if (!r.messageId || !r.channel || r.channel === '0') continue;
      const found = findChannel(client, r.guildId, r.channel);
      if (!found) continue;
      const channel = found.guild.channels.cache.get(r.channel)
        ?? await found.client.channels.fetch(r.channel).catch(() => null);
      const msg = await channel?.messages?.fetch(r.messageId).catch(() => null);
      if (msg?.editable) {
        await msg.edit({
          content: `⌛ This battle challenge expired.${total ? ' Any bet was returned.' : ''}`,
          components: [],
          allowedMentions: { parse: [] },
        }).catch(err => logger.debug?.(`[OwO battle] could not edit expired challenge: ${err.message}`));
      }
    }
  } catch (e) {
    logger.error('[OwO battle] escrow sweep failed', { err: e.message });
  } finally {
    running = false;
  }
}

export function startOwoBattleEscrowSweeper(client) {
  if (task) return task;
  task = cron.schedule('* * * * *', () => sweep(client));
  bootTimer = setTimeout(() => sweep(client), 25_000);
  logger.info('[OwO battle] escrow sweeper started');
  return task;
}

export function stopOwoBattleEscrowSweeper() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (task) { task.stop(); task = null; }
}
