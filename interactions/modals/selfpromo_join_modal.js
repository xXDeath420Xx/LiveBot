/**
 * Self-promo "add me" modal submit (customId prefix: selfpromo_join_modal).
 * Parses pasted links, adds the member's channel(s) to the self-promo list, and
 * syncs their other linked platforms. Replies ephemerally with a summary.
 */
import logger from '../../utils/logger.js';
import { getJoinConfig, joinFromText, summarize } from '../../core/self-promo-join.js';

export async function handleSelfPromoJoinModal(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const cfg = await getJoinConfig(interaction.guildId);
    if (!cfg) return interaction.editReply('Self-promo isn’t set up in this server yet.');

    const text = interaction.fields.getTextInputValue('links');
    const member = interaction.member;
    const results = await joinFromText(interaction.guild, member, cfg.channelId, text);
    await interaction.editReply(summarize(results));

    // Announce successful sign-ups publicly in the configured live channel so the
    // community knows there's a new streamer to follow.
    const added = results.filter(r => r.status === 'added');
    if (added.length && cfg.channelId) {
      try {
        const ch = await interaction.client.channels.fetch(cfg.channelId).catch(() => null);
        if (ch?.isTextBased()) {
          const platforms = [...new Set(added.map(r => r.platform))];
          await ch.send({
            embeds: [{
              color: 0x9146FF,
              description: `🎉 <@${interaction.user.id}> just joined the streamers — catch them on ${platforms.map(p => `**${p}**`).join(', ')} and give them a follow!`,
            }],
          });
        }
      } catch (e) {
        logger.warn('[SelfPromoJoin] signup announce failed', { error: e.message });
      }
    }
  } catch (err) {
    logger.error('[SelfPromoJoin] modal error', { error: err.message });
    if (interaction.deferred) await interaction.editReply('Something went wrong adding your stream — ping a mod.').catch(() => {});
  }
}

export default handleSelfPromoJoinModal;
