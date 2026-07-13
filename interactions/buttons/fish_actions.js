// Button handlers for the fishing minigame: "Catch again", "Sell all", "Inventory".
import { EmbedBuilder } from 'discord.js';
import { renderCast, castButtons } from '../../commands/games/fish.js';
import { cast, getInventory, sell, RARITIES } from '../../core/fishing-manager.js';

const COIN = '🪙';
const n = (x) => Number(x).toLocaleString();

// Re-cast and edit the same message in place (snappy "catch again" loop).
export async function handleFishAgain(interaction) {
  const result = await cast(interaction.user.id, interaction.guildId);
  if (result.cooldown) {
    return interaction.reply({ content: `🌊 Still reeling — wait **${(result.remainingMs / 1000).toFixed(1)}s**.`, ephemeral: true });
  }
  await interaction.update({ embeds: [await renderCast(result)], components: [castButtons()] });
  return true;
}

export async function handleFishSellAll(interaction) {
  const r = await sell(interaction.user.id, 'all', interaction.guildId);
  if (!r.sold) return interaction.reply({ content: r.skippedLocked ? '🔒 Everything in your bucket is locked — nothing sold.' : '🪣 Nothing to sell.', ephemeral: true });
  let msg = `💰 Sold **${n(r.sold)}** fish for **${n(r.coins)}** ${COIN} — balance **${n(r.balance)}** ${COIN}`;
  if (r.quest?.justRewarded) msg += `\n🎯 Quest complete: **+${n(r.quest.justRewarded)}** ${COIN}`;
  return interaction.reply({ content: msg, ephemeral: true });
}

export async function handleFishInv(interaction) {
  const inv = await getInventory(interaction.user.id);
  if (!inv.length) return interaction.reply({ content: '🎒 Your bucket is empty.', ephemeral: true });
  const total = inv.reduce((s, i) => s + i.totalValue, 0);
  const lines = inv.slice(0, 25).map(i => {
    const rr = RARITIES[i.rarity] || RARITIES.common;
    return `${i.emoji} ${rr.emoji} **${i.shiny ? '✨ ' : ''}${i.name}** ×${i.quantity} — \`${n(i.totalValue)}\` ${COIN}`;
  });
  const embed = new EmbedBuilder().setColor(0x3b82f6).setTitle('🎒 Your bucket')
    .setDescription(lines.join('\n')).setFooter({ text: `Total sell value: ${n(total)} ${COIN}` });
  return interaction.reply({ embeds: [embed], ephemeral: true });
}
