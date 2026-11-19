/*
 * `/protection joingate spammer-scan` — the Confirm / Cancel buttons under the scan result.
 * The member list lives in core/spammer-guard.js (rememberScan) for 15 minutes; only the person who
 * ran the scan can confirm it, and every member is re-checked before anything happens.
 */
import { EmbedBuilder } from 'discord.js';
import logger from '../../utils/logger.js';
import { getConfig } from '../../core/join-gate.js';
import { applyScan, peekScan, takeScan } from '../../core/spammer-guard.js';

const EPHEMERAL = { flags: 64 };
const DONE_LABEL = { kick: 'kicked', ban: 'banned', flag: 'flagged' };

/** `spamscan_ok:<token>` */
export async function handleSpammerScanConfirm(interaction) {
  const token = interaction.customId.split(':')[1];
  const entry = peekScan(token);
  if (!entry || entry.guildId !== interaction.guildId) {
    return interaction.update({ content: 'This scan has expired. Run `/protection joingate spammer-scan` again.', embeds: [], components: [] });
  }
  if (entry.actorId !== interaction.user.id) {
    return interaction.reply({ content: 'Only the person who ran this scan can confirm it.', ...EPHEMERAL });
  }
  takeScan(token);
  await interaction.update({ content: `Working through ${entry.userIds.length} member(s)…`, components: [] });

  try {
    const cfg = await getConfig(interaction.guildId);
    const out = await applyScan(interaction.guild, cfg, entry.userIds, interaction.user.id);
    const failedLines = out.failed.slice(0, 10).map(f => (f.id === '*' ? f.problem : `<@${f.id}> — ${f.problem}`));
    return interaction.editReply({
      content: '',
      embeds: [new EmbedBuilder()
        .setColor(out.failed.length ? 0xE67E22 : 0x2ECC71)
        .setTitle(`Spammer scan: ${out.done} ${DONE_LABEL[out.action] ?? 'actioned'}`)
        .setDescription([
          out.skipped ? `${out.skipped} skipped (gone, no longer flagged, allowlisted or staff).` : null,
          out.failed.length ? `**${out.failed.length} failed:**\n${failedLines.join('\n')}` : null,
        ].filter(Boolean).join('\n\n') || 'All done.')],
      components: [],
    });
  } catch (err) {
    logger.error(`[Spammer] scan apply failed in ${interaction.guildId}: ${err.message}`);
    return interaction.editReply({ content: `The scan stopped part-way: ${err.message}`, components: [] });
  }
}

/** `spamscan_no:<token>` */
export async function handleSpammerScanCancel(interaction) {
  const token = interaction.customId.split(':')[1];
  const entry = peekScan(token);
  if (entry && entry.actorId !== interaction.user.id) {
    return interaction.reply({ content: 'Only the person who ran this scan can cancel it.', ...EPHEMERAL });
  }
  takeScan(token);
  return interaction.update({ content: 'Cancelled — nobody was touched.', components: [] });
}
