/*
 * Undoing a commission-filter removal.
 *
 * Two buttons on every removal log entry, because "you got this wrong" has two different meanings
 * and conflating them either under- or over-corrects:
 *
 *   ↩️ False positive — restore
 *      This MESSAGE was fine. Puts it back in its channel, and records a content exemption so the
 *      identical post can never be removed again. Also reverses the poster's adaptive history, so a
 *      wrong call cannot make them easier to catch next time.
 *
 *   🚫 Stop matching this
 *      The TRIGGER is wrong for this server — this phrase, this pattern rule, or this soft-sell
 *      signal combination. Switches it off guild-wide. Broader, and deliberately a separate,
 *      explicit choice rather than a side effect of restoring one message.
 *
 * Restoration is a repost, not an un-delete — Discord has no undelete. Sent through a webhook
 * wearing the original author's name and avatar where the bot can manage webhooks, so the channel
 * reads the way it did before the filter interrupted it, and as an attributed embed otherwise.
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { contentKey, triggerKeysOf, invalidate } from '../../core/commission-spam-filter.js';

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
  const name = member?.displayName || member?.user?.username || 'Restored message';

  if (ch.permissionsFor(interaction.guild.members.me)?.has(PermissionFlagsBits.ManageWebhooks)) {
    try {
      const hooks = await ch.fetchWebhooks();
      const hook = hooks.find(h => h.owner?.id === interaction.client.user.id)
        || await ch.createWebhook({ name: 'Message restore' });
      await hook.send({
        content: row.content || undefined,
        files,
        username: name,
        avatarURL: member?.displayAvatarURL?.() ?? undefined,
        allowedMentions: { parse: [] },   // a restore must not re-ping anyone
      });
      return { ok: true, how: 'reposted as the original author' };
    } catch (err) {
      logger.debug(`[CommissionFilter] webhook restore failed, falling back: ${err.message}`, { category: 'automod' });
    }
  }

  const embed = new EmbedBuilder()
    .setAuthor({ name, iconURL: member?.displayAvatarURL?.() ?? undefined })
    .setDescription(row.content || '*(attachment only)*')
    .setFooter({ text: 'Restored — removed in error by the commission filter' })
    .setTimestamp();
  const sent = await ch.send({ embeds: [embed], files, allowedMentions: { parse: [] } }).catch(() => null);
  return sent ? { ok: true, how: 'reposted as an attributed embed' } : { ok: false, why: 'the bot cannot post there' };
}

/**
 * The undo itself, shared by the log-embed buttons and `/commission-filter undo`.
 *
 * Most guilds have no log channel configured, so the buttons alone would leave them with removals
 * they can see in `/commission-filter removals` and no way to reverse — which is the opposite of
 * the point. The command path exists so the undo never depends on the log embed being posted.
 *
 * @param {'restore'|'disable-trigger'} mode
 * @returns {Promise<string>} the reply text
 */
export async function applyFalsePositive(interaction, id, mode) {
  const [[row]] = await pool.execute(
    'SELECT * FROM commission_spam_decisions WHERE id = ? AND guild_id = ?', [id, interaction.guild.id]);
  if (!row) return '❌ That removal record no longer exists.';

  const action = mode === 'disable-trigger' ? 'commoff' : 'commfp';
  return runUndo(interaction, row, id, action);
}

export async function handleCommissionFalsePositive(interaction) {
  const [action, idRaw] = interaction.customId.split(':');
  const id = Number(idRaw);

  if (!staffOf(interaction.member)) {
    return interaction.reply({ content: '❌ You need moderator permissions to undo a removal.', ephemeral: true });
  }

  const [[row]] = await pool.execute(
    'SELECT * FROM commission_spam_decisions WHERE id = ? AND guild_id = ?', [id, interaction.guild.id]);
  if (!row) return interaction.reply({ content: '❌ That removal record no longer exists.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  const text = await runUndo(interaction, row, id, action);
  return interaction.editReply(text);
}

async function runUndo(interaction, row, id, action) {
  // ── 🚫 turn the trigger off guild-wide ────────────────────────────────────
  if (action === 'commoff') {
    const key = triggerKeysOf({ via: row.via, matched: row.matched, rule: row.rule, signals: (row.signals || '').split(',').filter(Boolean) })[0];
    if (!key) return '❌ Could not work out what to switch off for this removal.';

    await pool.execute(
      `INSERT INTO commission_spam_exemptions (guild_id, kind, value, note, created_by)
       VALUES (?, 'trigger', ?, ?, ?)
       ON DUPLICATE KEY UPDATE note = VALUES(note), created_by = VALUES(created_by)`,
      [interaction.guild.id, key, `via ${row.via} — removal #${id}`, interaction.user.id]);
    invalidate(interaction.guild.id);

    logger.info(`[CommissionFilter] trigger "${key}" disabled in ${interaction.guild.id} by ${interaction.user.id}`, { category: 'automod' });
    return `🚫 **\`${key}\`** will no longer trigger the filter in this server.\n`
      + 'Existing removals are untouched. Reverse it with `/commission-filter unexempt`.';
  }

  // ── ↩️ restore this message and never catch it again ──────────────────────
  if (row.verdict === 'false_positive') {
    return `Already restored${row.restored_by ? ` by <@${row.restored_by}>` : ''}.`;
  }

  const restored = await repost(interaction, row);

  const key = contentKey(row.content);
  if (key) {
    await pool.execute(
      `INSERT INTO commission_spam_exemptions (guild_id, kind, value, note, created_by)
       VALUES (?, 'content', ?, ?, ?)
       ON DUPLICATE KEY UPDATE note = VALUES(note), created_by = VALUES(created_by)`,
      [interaction.guild.id, key, `false positive — removal #${id}`, interaction.user.id]);
  }

  // 'false_positive' is not 'confirmed', so adaptiveBoostFor() stops counting this against the
  // poster. A wrong call must not quietly lower the bar for them later.
  await pool.execute(
    `UPDATE commission_spam_decisions
     SET verdict = 'false_positive', restored_at = NOW(), restored_by = ?, decided_by = ?, decided_at = NOW()
     WHERE id = ?`, [interaction.user.id, interaction.user.id, id]);

  if (row.deleted) {
    pool.execute(
      'UPDATE commission_spam_config SET deleted_count = GREATEST(deleted_count - 1, 0) WHERE guild_id = ?',
      [interaction.guild.id]).catch(() => {});
  }
  invalidate(interaction.guild.id);

  logger.info(`[CommissionFilter] removal #${id} marked false positive by ${interaction.user.id} in ${interaction.guild.id} (${restored.ok ? restored.how : 'restore failed: ' + restored.why})`, { category: 'automod' });

  // Retitle the log entry so the channel history stops asserting something untrue.
  if (row.log_message_id) {
    const logCh = interaction.guild.channels.cache.get(row.log_channel_id_resolved) || interaction.channel;
    const msg = await logCh.messages.fetch(row.log_message_id).catch(() => null);
    if (msg) {
      const embed = EmbedBuilder.from(msg.embeds[0])
        .setColor(0x57F287)
        .setTitle('↩️ Removed in error — restored')
        .setFooter({ text: `Restored by ${interaction.user.tag} — this message will not be removed again` });
      await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
    }
  }

  return (restored.ok ? `↩️ Restored (${restored.how}).` : `⚠️ Could not repost — ${restored.why}. The exemption was still saved.`)
    + '\nThis exact message will never be removed by the filter again, and the poster\'s record is cleared.'
    + '\nIf the **rule itself** is wrong for this server, use `/commission-filter undo mode:stop-matching` too.';
}

export default { handleCommissionFalsePositive };
