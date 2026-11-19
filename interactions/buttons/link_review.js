/*
 * Ruling on a link the filter could not decide, or undoing one it got wrong.
 *
 *   ✅ Allow <domain>       — approve. The domain joins the guild allowlist, so this is asked once
 *                             and never again. This is how the allowlist builds itself out of real
 *                             traffic rather than having to be guessed up front.
 *   ↩️ Wrong — restore & allow — the removal was a mistake. Reposts the message AND allows the
 *                             domain, because a false positive means both the message and the
 *                             domain were fine.
 *   🚫 Block this domain    — confirm. Domain goes on the deny list; if the message is still up
 *                             (a review verdict) it is removed now.
 *
 * Restoration is a repost — Discord has no undelete — sent with mentions disabled so putting a
 * message back never re-pings anyone.
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { invalidate } from '../../core/link-filter.js';

const staffOf = m => m?.permissions?.has(PermissionFlagsBits.ModerateMembers)
  || m?.permissions?.has(PermissionFlagsBits.ManageMessages)
  || m?.permissions?.has(PermissionFlagsBits.Administrator);

async function repost(interaction, row) {
  const ch = interaction.guild.channels.cache.get(row.channel_id);
  if (!ch?.isTextBased?.()) return { ok: false, why: 'the original channel is gone' };

  const files = [];
  try {
    for (const a of JSON.parse(row.attachments || '[]')) files.push({ attachment: a.url, name: a.name });
  } catch { /* attachment metadata unusable — restore the text at least */ }

  const member = await interaction.guild.members.fetch(row.user_id).catch(() => null);
  const embed = new EmbedBuilder()
    .setAuthor({ name: member?.displayName || 'Restored message', iconURL: member?.displayAvatarURL?.() ?? undefined })
    .setDescription(row.content || '*(attachment only)*')
    .setFooter({ text: 'Restored — removed in error by the link filter' })
    .setTimestamp();

  const sent = await ch.send({ embeds: [embed], files, allowedMentions: { parse: [] } }).catch(() => null);
  return sent ? { ok: true } : { ok: false, why: 'the bot cannot post there' };
}

async function setDomain(guildId, domain, kind, userId, note) {
  await pool.execute(
    `INSERT INTO link_policy_domains (guild_id, domain, kind, note, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE kind = VALUES(kind), note = VALUES(note), created_by = VALUES(created_by)`,
    [guildId, domain, kind, note, userId]);
  invalidate(guildId);
}

/** Shared by the buttons and `/link-filter rule`, so both paths behave identically. */
export async function applyLinkDecision(interaction, id, action) {
  const [[row]] = await pool.execute(
    'SELECT * FROM link_policy_decisions WHERE id = ? AND guild_id = ?', [id, interaction.guild.id]);
  if (!row) return '❌ That link record no longer exists.';
  if (row.decision !== 'pending' && row.decision !== 'removed') {
    return `Already ruled on — **${row.decision}**${row.decided_by ? ` by <@${row.decided_by}>` : ''}.`;
  }

  // ── 🚫 confirm: deny the domain, remove the message if it is still up ─────
  if (action === 'deny') {
    await setDomain(interaction.guild.id, row.domain, 'deny', interaction.user.id, `blocked via #${id}`);
    let removed = false;
    if (!row.deleted && row.message_id) {
      const ch = interaction.guild.channels.cache.get(row.channel_id);
      if (ch?.isTextBased?.()) removed = await ch.messages.delete(row.message_id).then(() => true).catch(() => false);
      if (removed) {
        pool.execute('UPDATE link_policy_config SET deleted_count = deleted_count + 1 WHERE guild_id = ?',
          [interaction.guild.id]).catch(() => {});
      }
    }
    await pool.execute(
      `UPDATE link_policy_decisions SET decision = 'removed', deleted = ?, decided_by = ?, decided_at = NOW() WHERE id = ?`,
      [(row.deleted || removed) ? 1 : 0, interaction.user.id, id]);
    logger.info(`[LinkFilter] ${row.domain} denied in ${interaction.guild.id} by ${interaction.user.id}`, { category: 'automod' });
    return `🚫 **\`${row.domain}\`** is now blocked in this server${removed ? ' and the message was removed' : ''}.\n`
      + 'Reverse it with `/link-filter unrule domain:' + row.domain + '`.';
  }

  // ── ✅ / ↩️ approve: allow the domain, and put the message back if it was taken ──
  await setDomain(interaction.guild.id, row.domain, 'allow', interaction.user.id,
    row.deleted ? `false positive — removal #${id}` : `approved via #${id}`);

  let restored = null;
  if (row.deleted) {
    restored = await repost(interaction, row);
    pool.execute('UPDATE link_policy_config SET deleted_count = GREATEST(deleted_count - 1, 0) WHERE guild_id = ?',
      [interaction.guild.id]).catch(() => {});
  }

  await pool.execute(
    `UPDATE link_policy_decisions
     SET decision = ?, decided_by = ?, decided_at = NOW() WHERE id = ?`,
    [row.deleted ? 'false_positive' : 'approved', interaction.user.id, id]);

  logger.info(`[LinkFilter] ${row.domain} allowed in ${interaction.guild.id} by ${interaction.user.id}${row.deleted ? ' (restored)' : ''}`, { category: 'automod' });

  return (row.deleted
    ? (restored?.ok ? '↩️ Message restored. ' : `⚠️ Could not repost — ${restored?.why}. The domain was still allowed. `)
    : '✅ Message left up. ')
    + `**\`${row.domain}\`** is now on this server's allowlist and will never be flagged again.`;
}

export async function handleLinkReview(interaction) {
  const [prefix, idRaw] = interaction.customId.split(':');
  if (!staffOf(interaction.member)) {
    return interaction.reply({ content: '❌ You need moderator permissions to rule on this.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });

  const action = prefix === 'linkdeny' ? 'deny' : 'allow';
  const text = await applyLinkDecision(interaction, Number(idRaw), action);

  // Retitle the card so the channel history stops asking a question that has been answered.
  const original = interaction.message?.embeds?.[0];
  if (original) {
    const embed = EmbedBuilder.from(original)
      .setColor(action === 'deny' ? 0xED4245 : 0x57F287)
      .setTitle(action === 'deny' ? '🚫 Domain blocked' : '✅ Domain allowed')
      .setFooter({ text: `Decided by ${interaction.user.tag}` });
    await interaction.message.edit({ embeds: [embed], components: [] }).catch(() => {});
  }

  return interaction.editReply(text);
}

export default { handleLinkReview, applyLinkDecision };
