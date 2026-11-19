/**
 * "Track a friend's stream" button + modal (customIds: selfpromo_friend[:<channelId>],
 * selfpromo_friend_modal[:<channelId>]).
 *
 * Sibling of selfpromo_join: same level gate and target channel, but the pasted
 * channels are tracked WITHOUT linking them to the clicker's Discord account —
 * see addFriendsFromText in core/self-promo-join.js.
 */
import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import logger from '../../utils/logger.js';
import { getJoinConfig, getJoinConfigForChannel, addFriendsFromText, summarize } from '../../core/self-promo-join.js';

const resolveConfig = (interaction, targetChannelId) => (targetChannelId
  ? getJoinConfigForChannel(interaction.guildId, targetChannelId)
  : getJoinConfig(interaction.guildId));

export async function handleSelfPromoFriend(interaction) {
  try {
    const targetChannelId = interaction.customId.split(':')[1] || null;
    const cfg = await resolveConfig(interaction, targetChannelId);
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
          content: `🔒 You need **Level ${cfg.minLevel}** to add streams — you're **Level ${level}**. Keep chatting and hanging out in voice to level up!`,
          ephemeral: true,
        });
      }
    }

    const modal = new ModalBuilder()
      .setCustomId(targetChannelId ? `selfpromo_friend_modal:${targetChannelId}` : 'selfpromo_friend_modal')
      .setTitle('Track a friend’s stream');
    const input = new TextInputBuilder()
      .setCustomId('links')
      .setLabel('Their channel link(s) — one per line')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('https://twitch.tv/yourfriend\nhttps://kick.com/yourfriend\nhttps://youtube.com/@yourfriend')
      .setRequired(true)
      .setMaxLength(1000);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  } catch (err) {
    logger.error('[SelfPromoFriend] button error', { error: err.message });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong opening the form — try again in a moment.', ephemeral: true }).catch(() => {});
    }
  }
}

export async function handleSelfPromoFriendModal(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const targetChannelId = interaction.customId.split(':')[1] || null;
    const cfg = await resolveConfig(interaction, targetChannelId);
    if (!cfg) return interaction.editReply('Self-promo isn’t set up in this server yet.');

    const text = interaction.fields.getTextInputValue('links');
    const results = await addFriendsFromText(interaction.guild, interaction.user.id, cfg.channelId, text);
    const added = results.filter(r => r.status === 'added');
    const note = added.length ? '\n\n-# These are tracked as a friend’s stream — not linked to your Discord account.' : '';
    await interaction.editReply(summarize(results) + note);

    if (added.length && cfg.channelId) {
      try {
        const ch = await interaction.client.channels.fetch(cfg.channelId).catch(() => null);
        if (ch?.isTextBased()) {
          const names = added.map(r => `**${r.username}** (${r.platform})`).join(', ');
          await ch.send({
            embeds: [{
              color: 0x9146FF,
              description: `🎉 <@${interaction.user.id}> added ${names} to the stream alerts — go give them a follow!`,
            }],
            allowedMentions: { parse: [] },
          });
        }
      } catch (e) {
        logger.warn('[SelfPromoFriend] announce failed', { error: e.message });
      }
    }
  } catch (err) {
    logger.error('[SelfPromoFriend] modal error', { error: err.message });
    if (interaction.deferred) await interaction.editReply('Something went wrong adding that stream — ping a mod.').catch(() => {});
  }
}

export default handleSelfPromoFriend;
