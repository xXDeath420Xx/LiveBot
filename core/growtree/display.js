/*
 * Grow a Tree — the message the game is played on: an embed with the rendered tree and a
 * 💧 button. Shared by `/arcade tree` and the button handlers so both always look the same.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { renderTreeAscii } from './renderer.js';
import { renderCanopy } from './render-canopy.js';
import { getTreeHeight, isGrowing, canBeWateredAt, getTreeAge, formatDurationLong } from './formulas.js';
import { accessibleAttachment } from '../../utils/accessible-attachment.js';

const GREEN = 0x3E8E41;

// Labels are lowercase and unadorned, matching the bot this replaces.
export function buildTreeComponents(growing) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tree_grow').setLabel('grow')
      .setStyle(growing ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(false), // still clickable — it explains why, rather than going dead
    new ButtonBuilder().setCustomId('tree_refresh').setLabel('refresh')
      .setStyle(ButtonStyle.Secondary),
  )];
}

/** A ready-to-send/edit message payload for the current state of a tree. */
export async function buildTreeMessage(tree, guild) {
  const now = Math.floor(Date.now() / 1000);
  const height = getTreeHeight(tree, now);
  const growing = isGrowing(tree, now);
  const readyAt = canBeWateredAt(tree);

  // Whole feet, and the height/waterer/readiness all in the description as one block — the shape
  // people already read at a glance. Rounded DOWN so the tree never claims height it has not
  // grown yet: mid-cooldown the height interpolates in tenths toward the next foot.
  const lines = [`**Your tree is ${Math.floor(height)}ft tall.**`];
  if (tree.lastWateredBy) lines.push(`Last watered by: <@${tree.lastWateredBy}>`);
  lines.push(growing ? `Ready to be watered <t:${readyAt}:R>` : '**Ready to be watered!**');

  // The tree's age is the sum of every watering interval it has already served, so it is derived
  // from the height rather than stored — a tree carried over at 190ft is correctly 45 minutes old.
  const embed = new EmbedBuilder()
    .setColor(GREEN)
    .setAuthor({ name: tree.name })
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${formatDurationLong(getTreeAge(tree.size))} spent growing this tree` });

  const payload = { embeds: [embed], components: buildTreeComponents(growing) };

  // Procedural canopy render — trunk sized by height, crowned by a full layered canopy on a sky.
  // No tile assets needed, so it always works; the ASCII trunk is only a last-ditch fallback if
  // rasterising ever throws.
  const png = await renderCanopy(tree).catch(() => null);
  if (png) {
    payload.files = [accessibleAttachment(png, {
      name: 'tree.png',
      description: `${tree.name}: a procedurally drawn tree ${Math.floor(height)} feet tall.`,
    })];
    embed.setImage('attachment://tree.png');
    return payload;
  }
  embed.setDescription(`${embed.data.description}\n${renderTreeAscii(tree.pieces)}`);
  return payload;
}
