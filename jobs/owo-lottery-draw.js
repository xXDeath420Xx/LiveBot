/*
 * OwO lottery: run every server's nightly draw (CC-BY-NC-SA derivative — see /LICENSE-OWO-NOTICE.md;
 * rules from upstream OwO Bot's gamble/lottery.js, Copyright (C) Christopher Thai).
 *
 * Draw times live in owo_lottery_round.draw_at, so this is restart-safe: every minute (and once
 * shortly after boot) it runs whatever is due, including draws that came due while the bot was
 * down. core/owo/lottery-service.js drawRound() locks the round and moves it to the next midnight
 * in the same transaction that pays the winner, so overlapping sweeps can't pay twice.
 *
 * Announcements go to the channel where someone last bought in (owo_lottery_round.announce_channel).
 * Only the winner is pinged.
 */
import cron from 'node-cron';
import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { findDueRounds, drawRound } from '../core/owo/lottery-service.js';
import { isEnabled } from '../core/owo/manager.js';

let task = null;
let bootTimer = null;
let running = false;

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

async function announce(client, guildId, result) {
  if (!result?.channelId) return;
  const found = findGuild(client, guildId);
  if (!found) return;
  const channel = found.guild.channels.cache.get(result.channelId)
    ?? await found.client.channels.fetch(result.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  if (result.rolledOver) {
    // Only worth saying when someone actually entered; an empty round rolls over silently.
    if (result.players !== 1) return;
    await channel.send({
      content: `🎰 Not enough players for tonight's OwO lottery — <@${result.soleEntrant}>'s entry rolls over to tomorrow's draw. Invite a friend: \`owo lottery <amount>\`.`,
      allowedMentions: { users: result.soleEntrant ? [result.soleEntrant] : [] },
    }).catch(err => logger.warn('[OwO lottery] rollover notice failed', { guildId, err: err.message }));
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xF0A500)
    .setTitle('🎰 OwO Lottery results')
    .setDescription(
      `<@${result.winnerId}> won the jackpot of **${result.pot.toLocaleString('en-US')}** 💵 `
      + `with a **${result.chance}%** chance!\n${result.players} players took the risk. `
      + 'A new round has started — `owo lottery <amount>` to enter.'
    )
    .setTimestamp(new Date());
  await channel.send({ content: `<@${result.winnerId}>`, embeds: [embed], allowedMentions: { users: [result.winnerId] } })
    .catch(err => logger.warn('[OwO lottery] winner announcement failed', { guildId, channelId: result.channelId, err: err.message }));
}

async function sweep(client) {
  if (running) return;
  running = true;
  try {
    const guildIds = await findDueRounds();
    for (const guildId of guildIds) {
      try {
        const result = await drawRound(guildId);
        if (!result) continue;
        if (!result.rolledOver) {
          logger.info('[OwO lottery] drawn', { guildId, winner: result.winnerId, pot: result.pot, players: result.players });
        }
        // A server that turned OwO off still gets its pot paid (nobody loses cowoncy), just quietly.
        if (await isEnabled(guildId)) await announce(client, guildId, result);
      } catch (e) {
        logger.error('[OwO lottery] draw failed', { guildId, err: e.message });
      }
    }
  } finally {
    running = false;
  }
}

export function startOwoLotteryDraw(client) {
  if (task) return task;
  task = cron.schedule('* * * * *', () => sweep(client).catch(err =>
    logger.error(`[OwO lottery] sweep failed: ${err.message}`)));
  // Catch up on any draw that came due while the bot was down, once the client has its guilds.
  bootTimer = setTimeout(() => sweep(client).catch(err =>
    logger.error(`[OwO lottery] boot sweep failed: ${err.message}`)), 20_000);
  logger.info('[OwO lottery] draw scheduler started');
  return task;
}

export function stopOwoLotteryDraw() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (task) { task.stop(); task = null; }
}
