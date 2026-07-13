/*
 * Cat Bot buttons.
 *
 *   cbg:<game>:<action>   minigame tables (blackjack, pig, tic-tac-toe)
 *   cbq:claim             claim every completed quest
 *   cbq:season            claim every unclaimed season level
 *
 * The quest ids are static and resolve from the guild + clicker, so they keep working on
 * old messages. The game ids need a live in-memory table; once it has expired the buttons
 * politely say so rather than paying out twice.
 */
import { MessageFlags } from 'discord.js';
import logger from '../../utils/logger.js';
import { handleCatGameButton } from '../../core/catbot/game-runner.js';
import { getBoard, claim, claimSeason, getSeason } from '../../core/catbot/battlepass.js';
import { getPack } from '../../core/catbot/packs.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

export { handleCatGameButton };

export async function handleCatQuestButton(interaction) {
  try {
    const [, action] = interaction.customId.split(':');
    const guildId = interaction.guildId;
    if (!guildId) return interaction.reply({ content: 'Quests only run in servers.', ...EPHEMERAL });

    if (action === 'season') return claimSeasonRewards(interaction, guildId);
    return claimQuests(interaction, guildId);
  } catch (err) {
    logger.error(`[CatBot] quest button failed: ${err.message}`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong claiming that.', ...EPHEMERAL }).catch(() => {});
    }
  }
}

async function claimQuests(interaction, guildId) {
  const userId = interaction.user.id;
  const board = await getBoard(guildId, userId);
  const ready = board.filter(q => q.complete && !q.claimed);
  if (!ready.length) {
    return interaction.reply({ content: 'Nothing to claim yet — finish a quest first.', ...EPHEMERAL });
  }

  await interaction.deferReply(EPHEMERAL);
  let coins = 0, xp = 0;
  const names = [];
  let season = await getSeason(guildId, userId);
  for (const q of ready) {
    // claim() is guarded on `claimed = 0`, so a double click pays once.
    const res = await claim(guildId, userId, q.id);
    if (!res.ok) continue;
    coins += res.quest.coins;
    xp += res.quest.xp;
    season = res.season;
    names.push(res.quest.name);
  }
  if (!names.length) return interaction.editReply('Someone already claimed those.');

  return interaction.editReply(
    `🎯 Claimed **${names.join('**, **')}**\n` +
    `🪙 +**${coins.toLocaleString()}** Cat Coins · ⭐ +**${xp}** season XP\n` +
    `You are season level **${season.level}** (${season.xp}/100).` +
    (season.levelsGained ? '\n🎁 New season rewards are waiting — hit **Claim rewards**.' : ''));
}

async function claimSeasonRewards(interaction, guildId) {
  const res = await claimSeason(guildId, interaction.user.id);
  if (!res.ok) return interaction.reply({ content: 'No season rewards waiting. Level up first.', ...EPHEMERAL });

  const packs = res.packs.map(id => `${getPack(id)?.emoji ?? '📦'} **${getPack(id)?.name ?? id}**`);
  return interaction.reply({
    content: `🎁 Season rewards through level **${res.upTo}**:\n` +
      `🪙 +**${res.coins.toLocaleString()}** Cat Coins` +
      (packs.length ? `\n📦 ${packs.join(' · ')}` : ''),
    ...EPHEMERAL,
  });
}
