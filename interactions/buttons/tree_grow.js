/*
 * Grow a Tree — the 💧 grow button and 🔄 refresh.
 *
 * customIds are static (`tree_grow` / `tree_refresh`), so the buttons keep working across
 * restarts and on messages posted long ago: the tree is resolved from the guild, never
 * from the message.
 */
import { MessageFlags } from 'discord.js';
import { waterTree, getTree, getPlayer } from '../../core/growtree/manager.js';
import { buildTreeMessage } from '../../core/growtree/display.js';
import { formatDuration } from '../../core/growtree/formulas.js';
import logger from '../../utils/logger.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

export async function handleTreeGrow(interaction) {
  try {
    const guildId = interaction.guildId;
    if (!guildId) return interaction.reply({ content: 'Trees only grow in servers.', ...EPHEMERAL });

    await interaction.deferUpdate().catch(() => {});
    const result = await waterTree(guildId, interaction.user.id);

    if (!result.ok) {
      if (result.reason === 'none') {
        return interaction.followUp({ content: 'There is no tree here. Plant one with `/tree plant`.', ...EPHEMERAL });
      }
      if (result.reason === 'self') {
        return interaction.followUp({
          content: '🌱 You watered it last — someone else has to take a turn before you can go again.',
          ...EPHEMERAL,
        });
      }
      const wait = Math.max(0, result.nextWaterAt - Math.floor(Date.now() / 1000));
      return interaction.followUp({
        content: `💧 It's still drinking. Ready <t:${result.nextWaterAt}:R> (${formatDuration(wait)}).`,
        ...EPHEMERAL,
      });
    }

    const payload = await buildTreeMessage(result.tree, interaction.guild);
    await interaction.editReply(payload).catch(() => {});

    const player = await getPlayer(interaction.user.id);
    if (result.levelsGained > 0) {
      await interaction.followUp({
        content: `🌳 **${interaction.user.username}** reached **level ${result.level}**!`,
      }).catch(() => {});
    } else if (player.notifyXp) {
      await interaction.followUp({ content: `+${result.gainedXp} XP`, ...EPHEMERAL }).catch(() => {});
    }
  } catch (err) {
    logger.error(`[GrowTree] grow button failed: ${err.message}`);
    await interaction.followUp({ content: 'Something went wrong watering the tree.', ...EPHEMERAL }).catch(() => {});
  }
}

export async function handleTreeRefresh(interaction) {
  try {
    await interaction.deferUpdate().catch(() => {});
    const tree = await getTree(interaction.guildId);
    if (!tree) return;
    const payload = await buildTreeMessage(tree, interaction.guild);
    await interaction.editReply(payload).catch(() => {});
  } catch (err) {
    logger.error(`[GrowTree] refresh failed: ${err.message}`);
  }
}
