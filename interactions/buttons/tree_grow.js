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
import { maybeSpawn, setEncounterMessage } from '../../core/growtree/critters.js';
import { encounterMessage } from './tree_catch.js';
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

    // Something may land on the tree. Most waters produce nothing — that is what makes it an event.
    // It is posted as its OWN message, not an edit of the tree: the tree message is permanent and
    // people scroll back to it, and a race that lives inside it would be invisible to anyone who
    // arrives later.
    await spawnEncounter(interaction);
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

/**
 * Roll for a bug or a fruit, and post it if one turns up.
 *
 * Never allowed to break watering: a failed spawn is a missed encounter, not a failed water, and the
 * player already has their growth. Hence the catch — the tree message has already been edited by the
 * time we get here.
 */
async function spawnEncounter(interaction) {
  try {
    const spawn = await maybeSpawn(interaction.guildId, interaction.channelId);
    if (!spawn) return;

    const msg = await interaction.followUp({ ...encounterMessage(spawn), fetchReply: true });
    await setEncounterMessage(spawn.id, msg.id);
  } catch (err) {
    logger.warn(`[GrowTree] could not spawn an encounter: ${err.message}`);
  }
}
