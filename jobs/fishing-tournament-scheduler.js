// Ends due fishing tournaments and announces the winner in the channel where
// the tournament was started. Runs every minute.
import cron from 'node-cron';
import logger from '../utils/logger.js';
import { EmbedBuilder } from 'discord.js';
import { endDueTournaments } from '../core/fishing-manager.js';

const COIN = '🪙';
const n = (x) => Number(x).toLocaleString();
let task = null;

async function tick(client) {
  let ended;
  try { ended = await endDueTournaments(); }
  catch (e) { logger.error(`[FishTourney] sweep failed: ${e.message}`); return; }
  if (!ended || !ended.length) return;

  for (const { tournament, standings, winner } of ended) {
    try {
      const channel = await client.channels.fetch(tournament.channel_id).catch(() => null);
      if (!channel || !channel.isTextBased?.()) continue;
      const medals = ['🥇', '🥈', '🥉'];
      const lines = standings.length
        ? standings.map((s, i) =>
            `${medals[i] || `**${i + 1}.**`} <@${s.userId}> — ${tournament.type === 'most' ? `${n(s.catches)} fish` : `${Number(s.score)} kg${s.bestMeta ? ` (${s.bestMeta.emoji} ${s.bestMeta.name})` : ''}`}`)
        : ['_No one entered this one._'];
      const embed = new EmbedBuilder().setColor(0xf59e0b).setTitle('🏁 Fishing Tournament — Results!')
        .setDescription(`**${tournament.type === 'most' ? 'Most fish caught' : 'Biggest single catch'}**\n\n${lines.join('\n')}`);
      if (winner && tournament.prize > 0) {
        embed.addFields({ name: '🏆 Winner', value: `<@${winner.userId}> takes the **${n(tournament.prize)}** ${COIN} prize!` });
      }
      await channel.send({ embeds: [embed] }).catch(() => {});
    } catch (e) {
      logger.error(`[FishTourney] announce failed for #${tournament.id}: ${e.message}`);
    }
  }
}

export function startFishingTournamentScheduler(client) {
  if (task) return task;
  task = cron.schedule('* * * * *', () => tick(client));
  logger.info('[FishTourney] Tournament scheduler started (every minute)');
  return task;
}
export function stopFishingTournamentScheduler() {
  if (task) { task.stop(); task = null; }
}
export default startFishingTournamentScheduler;
