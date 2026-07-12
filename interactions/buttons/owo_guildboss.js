/*
 * OwO guild boss buttons — guildboss_fight | guildboss_leaderboard | guildboss_inspect.
 *
 * Static ids: the boss is resolved from the guild, so the buttons keep working on the original
 * announcement no matter how old it is. Fight updates that announcement in place (fresh HP bar +
 * board) and tells the clicker privately what they dealt; the other two reply privately only.
 */
import { MessageFlags } from 'discord.js';
import logger from '../../utils/logger.js';
import {
  fightBoss, getActiveBoss, getLeaderboard, getBossStats, FIGHT_COOLDOWN_MS,
} from '../../core/owo/guildboss-service.js';
import { renderBoss } from '../../core/owo/guildboss-text.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

export async function handleGuildBossButton(interaction) {
  try {
    if (!interaction.guildId) return interaction.reply({ content: 'Guild bosses only appear in servers.', ...EPHEMERAL });
    const action = interaction.customId.split('_')[1]; // fight | leaderboard | inspect

    if (action === 'fight') return doFight(interaction);
    if (action === 'leaderboard') return doLeaderboard(interaction);
    return doInspect(interaction);
  } catch (err) {
    logger.error(`[OwO boss] button failed: ${err.message}`, { stack: err.stack });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong with the guild boss.', ...EPHEMERAL }).catch(() => {});
    }
  }
}

async function doFight(interaction) {
  const guildId = interaction.guildId;
  const result = await fightBoss(guildId, interaction.user.id);

  if (!result.ok) {
    const msg = {
      'no-boss': 'There is no guild boss right now.',
      'defeated': 'Your team was already wiped by this boss — sit this one out.',
      'no-team': "You have no battle team. Build one with `owo team add <animal>` first.",
      'cooldown': `You're catching your breath — try again in ${Math.ceil((result.retryMs ?? FIGHT_COOLDOWN_MS) / 1000)}s.`,
    }[result.reason] ?? 'You cannot fight the boss right now.';
    return interaction.reply({ content: msg, ...EPHEMERAL });
  }

  // Re-render the announcement in place. If the boss died, show the defeated state; otherwise pull
  // the fresh HP so the bar reflects this hit.
  const state = result.killed ? 'defeated' : 'active';
  const boss = result.killed ? result.boss : (await getActiveBoss(guildId)) ?? result.boss;
  await interaction.update(await renderBoss({ ...boss, guildId }, state)).catch(async (e) => {
    // If the message can't be edited (deleted/perms), still acknowledge the fight.
    logger.warn(`[OwO boss] could not update announcement: ${e.message}`);
    await interaction.deferUpdate().catch(() => {});
  });

  const parts = [`⚔️ You dealt **${result.damage.toLocaleString()}** damage!`,
    `Your total on this boss: **${result.yourTotal.toLocaleString()}**.`];
  if (result.defeated) parts.push('💀 The boss wiped your team — you cannot fight it again.');
  if (result.killed) {
    const you = result.rewards?.payouts?.find(p => p.userId === interaction.user.id);
    parts.push(`\n💥 **The boss is defeated!**${you ? ` You earned **${you.amount.toLocaleString()}** 💵${you.top ? ' (top damage bonus!)' : ''}.` : ''}`);
  }
  await interaction.followUp({ content: parts.join(' '), ...EPHEMERAL }).catch(() => {});
}

async function doLeaderboard(interaction) {
  const board = await getLeaderboard(interaction.guildId, 10);
  const stats = await getBossStats(interaction.guildId);
  if (!board.length) return interaction.reply({ content: 'No damage dealt to the boss yet.', ...EPHEMERAL });
  const lines = board.map(e => `**${e.rank}.** \`${e.damage.toLocaleString()}\` <@${e.userId}>${e.defeated ? ' 💀' : ''}`);
  lines.push(`\n⚔️ ${stats.fighters} fighter${stats.fighters === 1 ? '' : 's'} · 💀 ${stats.defeated} defeated · ${stats.totalDamage.toLocaleString()} total`);
  return interaction.reply({ content: `**Top Damage Dealt**\n${lines.join('\n')}`, ...EPHEMERAL });
}

async function doInspect(interaction) {
  const boss = await getActiveBoss(interaction.guildId);
  if (!boss) return interaction.reply({ content: 'There is no guild boss right now.', ...EPHEMERAL });
  const pct = Math.round((boss.hp / boss.maxHp) * 100);
  return interaction.reply({
    content: `${boss.emoji} **Lv. ${boss.level} ${boss.animal}** (${boss.rank})\n` +
      `HP: **${boss.hp.toLocaleString()} / ${boss.maxHp.toLocaleString()}** (${pct}%)\n` +
      `Attack: **${boss.wp}**\nRuns away <t:${Math.floor(new Date(boss.expiresAt).getTime() / 1000)}:R>`,
    ...EPHEMERAL,
  });
}
