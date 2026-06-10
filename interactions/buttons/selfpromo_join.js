/**
 * "Add me to self-promo" button (customId: selfpromo_join).
 *
 * The manual path for streamers presence-detection can't catch (Kick/Trovo have
 * no Discord connection; users who haven't linked Twitch). Level-gated. A button
 * click only needs ViewChannel, so it works in a view-only channel. On click:
 * check the member's level; if they qualify, open the paste-your-links modal.
 */
import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import logger from '../../utils/logger.js';
import { getJoinConfig } from '../../core/self-promo-join.js';

export async function handleSelfPromoJoin(interaction) {
  try {
    const cfg = await getJoinConfig(interaction.guildId);
    if (!cfg) {
      return interaction.reply({ content: 'Self-promo isn’t set up in this server yet.', ephemeral: true });
    }

    if (cfg.minLevel > 0) {
      const lm = interaction.client?.levelingManager;
      let level = 0;
      if (lm?.getUserRank) {
        const rank = await lm.getUserRank(interaction.guildId, interaction.user.id).catch(() => null);
        level = Number(rank?.level) || 0;
      }
      if (level < cfg.minLevel) {
        return interaction.reply({
          content: `🔒 You need **Level ${cfg.minLevel}** to add yourself to self-promo — you're **Level ${level}**. Keep chatting and hanging out in voice to level up!`,
          ephemeral: true,
        });
      }
    }

    const modal = new ModalBuilder().setCustomId('selfpromo_join_modal').setTitle('Add your stream(s)');
    const input = new TextInputBuilder()
      .setCustomId('links')
      .setLabel('Paste your channel link(s) — one per line')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('https://twitch.tv/you\nhttps://kick.com/you\nhttps://youtube.com/@you\nhttps://trovo.live/s/you')
      .setRequired(true)
      .setMaxLength(1000);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  } catch (err) {
    logger.error('[SelfPromoJoin] button error', { error: err.message });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong opening the form — try again in a moment.', ephemeral: true }).catch(() => {});
    }
  }
}

export default handleSelfPromoJoin;
