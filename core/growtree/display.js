/*
 * Grow a Tree — the message the game is played on: an embed with the rendered tree and a
 * 💧 button. Shared by `/tree` and the button handlers so both always look the same.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } from 'discord.js';
import { renderTree, renderTreeAscii, artInstalled } from './renderer.js';
import { getTreeHeight, isGrowing, canBeWateredAt } from './formulas.js';

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

  const embed = new EmbedBuilder()
    .setColor(GREEN)
    .setAuthor({ name: tree.name })
    .setDescription(lines.join('\n'));

  const payload = { embeds: [embed], components: buildTreeComponents(growing) };

  if (artInstalled()) {
    const png = await renderTree(tree).catch(() => null);
    if (png) {
      payload.files = [new AttachmentBuilder(png, { name: 'tree.png' })];
      embed.setImage('attachment://tree.png');
      return payload;
    }
  }
  // No sprites generated — fall back to a drawn trunk so the game still plays.
  embed.setDescription(`${embed.data.description}\n${renderTreeAscii(tree.pieces)}`);
  return payload;
}
