/*
 * Moderator decision on a borderline commission ad.
 *
 * The soft-sell tier infers intent from several weak signals rather than matching a quoted
 * solicitation, so anything below the delete threshold is posted here instead of being acted on.
 * Whichever way the moderator rules, the answer is stored — 'confirmed' verdicts are what
 * adaptiveBoostFor() reads, so a poster the staff have already called an advertiser needs less
 * corroboration next time. 'allowed' deliberately records nothing that lowers the bar; clearing
 * someone must never make them easier to catch later.
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

export async function handleCommissionReview(interaction) {
  const [action, idRaw] = interaction.customId.split(':');
  const decisionId = Number(idRaw);
  const confirm = action === 'commrev_del';

  const perms = interaction.member?.permissions;
  const isStaff = perms?.has(PermissionFlagsBits.ModerateMembers)
    || perms?.has(PermissionFlagsBits.ManageMessages)
    || perms?.has(PermissionFlagsBits.Administrator);
  if (!isStaff) {
    return interaction.reply({ content: '❌ You need moderator permissions to rule on this.', ephemeral: true });
  }

  const [[row]] = await pool.execute(
    'SELECT * FROM commission_spam_decisions WHERE id = ? AND guild_id = ?',
    [decisionId, interaction.guild.id]);
  if (!row) {
    return interaction.reply({ content: '❌ That review record no longer exists.', ephemeral: true });
  }
  if (row.verdict !== 'pending') {
    return interaction.reply({
      content: `Already ruled on — **${row.verdict}**${row.decided_by ? ` by <@${row.decided_by}>` : ''}.`,
      ephemeral: true,
    });
  }

  await interaction.deferUpdate();

  let removed = false;
  if (confirm) {
    const ch = interaction.guild.channels.cache.get(row.channel_id);
    if (ch?.isTextBased?.() && row.message_id) {
      removed = await ch.messages.delete(row.message_id).then(() => true).catch(() => false);
    }
    if (removed) {
      pool.execute(
        'UPDATE commission_spam_config SET deleted_count = deleted_count + 1, soft_sell_deleted_count = soft_sell_deleted_count + 1, last_hit_at = NOW() WHERE guild_id = ?',
        [interaction.guild.id]).catch(() => {});
    }
  }

  await pool.execute(
    `UPDATE commission_spam_decisions
     SET verdict = ?, decided_by = ?, decided_at = NOW() WHERE id = ?`,
    [confirm ? 'confirmed' : 'allowed', interaction.user.id, decisionId]);

  logger.info(`[CommissionFilter] review #${decisionId} ${confirm ? 'confirmed' : 'allowed'} by ${interaction.user.id} in ${interaction.guild.id}${confirm && !removed ? ' (message already gone)' : ''}`, { category: 'automod' });

  const original = interaction.message.embeds[0];
  const embed = EmbedBuilder.from(original)
    .setColor(confirm ? 0xED4245 : 0x57F287)
    .setTitle(confirm ? '🗑️ Commission ad removed (reviewed)' : '✅ Allowed — not an ad')
    .setFooter({
      text: confirm
        ? `Confirmed by ${interaction.user.tag}${removed ? '' : ' — message was already deleted'}`
        : `Cleared by ${interaction.user.tag} — this poster is not penalised for it`,
    });

  await interaction.editReply({ embeds: [embed], components: [] });
}

export default { handleCommissionReview };
