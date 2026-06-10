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
  } catch (err) {
    logger.error('[SelfPromoJoin] modal error', { error: err.message });
    if (interaction.deferred) await interaction.editReply('Something went wrong adding your stream — ping a mod.').catch(() => {});
  }
}

export default handleSelfPromoJoinModal;
