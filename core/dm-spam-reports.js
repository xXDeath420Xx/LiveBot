/*
 * DM-spam reports — crowdsourced closure of the DM-content blind spot.
 *
 * Discord does not expose DM content to bots, by design. The one ToS-clean path to see what
 * commission-spammers are sending to our server members is for the recipient to voluntarily share
 * a message they received. `/engage report-dm` collects that evidence; this module stores it, delivers it
 * to the server's review channel, and (when enough reports converge) auto-promotes the reported
 * user into the network-scoped blacklist that join-gate reads on every join.
 *
 * The auto-promotion rule is "N confirmed-or-pending reports from M distinct guilds within W hours",
 * all three tunable per-guild via join_gate_config.network_report_threshold /
 * network_report_window_hours. The reporting guild's config decides whether the report counts
 * (dm_report_enabled); the target guilds (which read the resulting blacklist) decide what action
 * to take on it (network_blacklist_action), so a lax reporter cannot force a strict guild to ban.
 */
import crypto from 'node:crypto';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getConfig as getJoinGateConfig } from './join-gate.js';
import { recordNetworkBan, getNetworkActivity } from './network-intel.js';

const MAX_FULL = 2000;
const MAX_PREVIEW = 500;

function hashContent(content) {
  if (!content) return null;
  const normalised = content.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalised).digest('hex');
}

/**
 * Create a new report. Returns the inserted row (or the duplicate it collided with). Fires the
 * blacklist check post-insert.
 *
 *  reporter        — the user running /report-dm
 *  reported        — the user whose DM is being reported
 *  guildId         — the guild the reporter was in when they filed
 *  content         — the DM text (optional; may be null if only a link is provided)
 *  attachments     — stringified JSON of attachment URLs (optional)
 *  client          — Discord client, used to deliver the embed to the review channel
 */
export async function createReport({ reporter, reported, guildId, content, attachments, client }) {
  if (!reporter?.id || !reported?.id || !guildId) {
    return { ok: false, reason: 'missing_fields' };
  }
  if (reporter.id === reported.id) {
    return { ok: false, reason: 'self_report' };
  }
  if (reported.bot) {
    return { ok: false, reason: 'bot_target' };
  }

  const trimmedContent = (content || '').slice(0, MAX_FULL) || null;
  const preview = trimmedContent ? trimmedContent.slice(0, MAX_PREVIEW) : null;
  const contentHash = hashContent(trimmedContent);

  // Resolve how long after the reported user joined this guild. Small values ("joined 90 seconds
  // ago, DM arrived immediately") are the single strongest "they're here to DM, not chat" signal.
  let joinDelta = null;
  try {
    const [[j]] = await pool.query(
      `SELECT TIMESTAMPDIFF(SECOND, joined_at, NOW()) AS d
         FROM member_join_history
        WHERE guild_id = ? AND user_id = ?
        ORDER BY joined_at DESC LIMIT 1`,
      [guildId, reported.id]
    );
    if (j && Number.isFinite(j.d) && j.d >= 0) joinDelta = j.d;
  } catch { /* best effort */ }

  let reportId = null;
  try {
    const [res] = await pool.query(
      `INSERT INTO dm_spam_reports
         (reported_user_id, reporter_user_id, guild_id, content_hash, content_preview,
          content_full, attachments, verdict, join_delta_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [reported.id, reporter.id, guildId, contentHash, preview, trimmedContent,
       attachments || null, joinDelta]
    );
    reportId = res.insertId;
  } catch (e) {
    logger.error(`[DmSpamReports] insert failed: ${e.message}`);
    return { ok: false, reason: 'db_error' };
  }

  // Bump the dm_reports_count summary on network_member_activity so join-gate can read one row
  // instead of running a COUNT every join.
  try {
    await pool.query(
      `INSERT INTO network_member_activity (user_id, dm_reports_count, first_seen_at, last_seen_at)
       VALUES (?, 1, NOW(), NOW())
       ON DUPLICATE KEY UPDATE dm_reports_count = dm_reports_count + 1, last_seen_at = NOW()`,
      [reported.id]
    );
  } catch { /* best effort */ }

  // Deliver the embed to the configured review channel (fire-and-forget).
  deliverReport({ reportId, reporter, reported, guildId, preview, joinDelta, client })
    .catch((e) => logger.warn(`[DmSpamReports] deliver failed: ${e.message}`));

  // Check whether this report tips the user over the auto-blacklist threshold.
  const blacklistResult = await evaluateForBlacklist(reported.id);

  return { ok: true, reportId, blacklist: blacklistResult };
}

/**
 * Set a report's verdict. Called from the review buttons (confirm/reject). Confirmed reports stay
 * in the auto-blacklist tally; rejected reports are discounted.
 */
export async function setVerdict(reportId, verdict, reviewerUserId) {
  if (!['confirmed', 'rejected', 'duplicate'].includes(verdict)) {
    return { ok: false, reason: 'bad_verdict' };
  }
  try {
    await pool.query(
      `UPDATE dm_spam_reports
          SET verdict = ?, reviewed_by = ?, reviewed_at = NOW()
        WHERE id = ?`,
      [verdict, reviewerUserId, reportId]
    );
    // After a confirmed verdict, re-run the blacklist check — the confirmed count may now
    // meet threshold even if pending counts previously fell short.
    const [[row]] = await pool.query(
      `SELECT reported_user_id FROM dm_spam_reports WHERE id = ?`, [reportId]);
    if (row?.reported_user_id && verdict === 'confirmed') {
      await evaluateForBlacklist(row.reported_user_id);
    }
    return { ok: true };
  } catch (e) {
    logger.error(`[DmSpamReports] setVerdict failed: ${e.message}`);
    return { ok: false, reason: 'db_error' };
  }
}

/**
 * The core promotion rule.
 *
 * A user is network-blacklisted when, within the longest configured window across all opted-in
 * guilds, there are at least THRESHOLD distinct-guild reports whose verdict is confirmed or still
 * pending. The threshold is read from join_gate_config of each guild that filed a report, and we
 * use the MINIMUM across those — the strictest guild's floor rules.
 *
 * Rejected / duplicate reports are excluded. Also any guild that has filed multiple reports from
 * the SAME reporter counts once per guild, not per report (sybil-resistance against one angry
 * member filing ten reports from one account).
 */
export async function evaluateForBlacklist(reportedUserId) {
  if (!reportedUserId) return { tripped: false };

  // Find the strictest configured threshold + widest window among guilds that have reported this
  // user. If no guild has configured one, default (3 reports / 72h) applies.
  let threshold = 3;
  let windowHours = 72;
  try {
    const [cfgs] = await pool.query(
      `SELECT jgc.network_report_threshold, jgc.network_report_window_hours
         FROM join_gate_config jgc
         WHERE jgc.guild_id IN (
           SELECT DISTINCT guild_id FROM dm_spam_reports WHERE reported_user_id = ?
         )`,
      [reportedUserId]
    );
    if (cfgs.length) {
      threshold = Math.min(...cfgs.map(c => c.network_report_threshold || 3));
      windowHours = Math.max(...cfgs.map(c => c.network_report_window_hours || 72));
    }
  } catch { /* best effort — defaults apply */ }

  // Count distinct guilds that reported this user in the window with non-rejected verdict.
  let distinctGuilds = 0;
  let evidenceReportIds = [];
  try {
    const [rows] = await pool.query(
      `SELECT guild_id, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
         FROM dm_spam_reports
        WHERE reported_user_id = ?
          AND verdict IN ('pending', 'confirmed')
          AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        GROUP BY guild_id`,
      [reportedUserId, windowHours]
    );
    distinctGuilds = rows.length;
    evidenceReportIds = rows.flatMap(r => (r.ids || '').split(',').map(Number).filter(Boolean));
  } catch (e) {
    logger.error(`[DmSpamReports] threshold query failed: ${e.message}`);
    return { tripped: false };
  }

  if (distinctGuilds < threshold) return { tripped: false, distinctGuilds, threshold, windowHours };

  // Already blacklisted? Just update evidence; don't create duplicate.
  let existing = null;
  try {
    const [[row]] = await pool.query(
      `SELECT id, evidence_count FROM blacklisted_users
         WHERE scope = 'network' AND platform = 'discord' AND platform_user_id = ? LIMIT 1`,
      [reportedUserId]
    );
    existing = row || null;
  } catch { /* fall through, we'll INSERT */ }

  const evidenceJson = JSON.stringify({
    report_ids: evidenceReportIds,
    distinct_guilds: distinctGuilds,
    threshold_met: threshold,
    window_hours: windowHours,
    computed_at: new Date().toISOString(),
  });

  try {
    if (existing) {
      await pool.query(
        `UPDATE blacklisted_users
            SET evidence_count = ?, evidence_json = ?, blacklisted_at = COALESCE(blacklisted_at, NOW())
          WHERE id = ?`,
        [evidenceReportIds.length, evidenceJson, existing.id]
      );
    } else {
      await pool.query(
        `INSERT INTO blacklisted_users
           (platform, platform_user_id, discord_user_id, blacklisted_by, blacklisted_at,
            guild_id, reason, scope, source, evidence_count, evidence_json)
         VALUES ('discord', ?, ?, 'SYSTEM:NETWORK_INTEL', NOW(),
                 '0', ?, 'network', 'network_intel', ?, ?)`,
        [reportedUserId, reportedUserId,
         `Auto-blacklist: ${distinctGuilds} DM-spam reports from ${distinctGuilds} guilds in ${windowHours}h`,
         evidenceReportIds.length, evidenceJson]
      );
    }
    // Mark contributing reports as having contributed to a blacklist.
    if (evidenceReportIds.length) {
      await pool.query(
        `UPDATE dm_spam_reports SET contributed_to_blacklist = 1
           WHERE id IN (${evidenceReportIds.map(() => '?').join(',')})`,
        evidenceReportIds
      );
    }
    logger.info(`[DmSpamReports] auto-blacklisted ${reportedUserId}: ${distinctGuilds} guild(s), ${evidenceReportIds.length} report(s)`);
    return { tripped: true, distinctGuilds, threshold, windowHours, reportIds: evidenceReportIds };
  } catch (e) {
    logger.error(`[DmSpamReports] blacklist write failed: ${e.message}`);
    return { tripped: false, reason: 'db_error' };
  }
}

async function deliverReport({ reportId, reporter, reported, guildId, preview, joinDelta, client }) {
  const cfg = await getJoinGateConfig(guildId);
  if (!cfg?.dm_report_enabled) return;
  const channelId = cfg?.dm_report_channel_id || cfg?.log_channel_id;
  if (!channelId || !client) return;
  const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.send) return;

  const activity = await getNetworkActivity(reported.id);
  const deltaStr = joinDelta == null
    ? '—'
    : joinDelta < 60 ? `${joinDelta}s`
    : joinDelta < 3600 ? `${Math.round(joinDelta / 60)}m`
    : joinDelta < 86400 ? `${Math.round(joinDelta / 3600)}h`
    : `${Math.round(joinDelta / 86400)}d`;

  const embed = new EmbedBuilder()
    .setTitle('DM-spam report')
    .setColor(0xC13E3E)
    .setDescription(preview ? `> ${preview.slice(0, 400)}` : '*(no text supplied)*')
    .addFields(
      { name: 'Reported user', value: `<@${reported.id}>\n\`${reported.id}\``, inline: true },
      { name: 'Reporter', value: `<@${reporter.id}>`, inline: true },
      { name: 'Join → DM', value: deltaStr, inline: true },
      { name: 'Network stats',
        value: activity
          ? `Guilds joined: **${activity.guilds_joined}** · currently in **${activity.guilds_currently_in}** · banned from **${activity.guilds_banned_from}** · reports **${activity.dm_reports_count}**`
          : 'No prior cross-guild activity on file.',
        inline: false },
    )
    .setFooter({ text: `Report #${reportId}` })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dmsr:confirm:${reportId}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`dmsr:reject:${reportId}`).setLabel('False positive').setStyle(ButtonStyle.Secondary),
  );

  await channel.send({ embeds: [embed], components: [row] }).catch(() => {});
}

export async function handleReviewButton(interaction) {
  const [prefix, action, idStr] = (interaction.customId || '').split(':');
  if (prefix !== 'dmsr') return false;
  const reportId = Number(idStr);
  if (!Number.isFinite(reportId)) return true;
  const verdict = action === 'confirm' ? 'confirmed' : action === 'reject' ? 'rejected' : null;
  if (!verdict) return true;

  const res = await setVerdict(reportId, verdict, interaction.user.id);
  const msg = res.ok
    ? (verdict === 'confirmed' ? 'Report confirmed. Counted toward network blacklist.' : 'Report marked false positive.')
    : 'Could not update report.';
  await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
  // Disable the buttons so no-one re-votes.
  try {
    const disabled = ActionRowBuilder.from(interaction.message.components[0]);
    disabled.components.forEach(c => c.setDisabled(true));
    await interaction.message.edit({ components: [disabled] });
  } catch { /* best effort */ }
  return true;
}
