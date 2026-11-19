import { Events, AuditLogEvent, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import pool from '../utils/db.js';
import { themeColor } from '../core/guild-theme.js';
import { recordEntry } from '../utils/audit-log-correlator.js';

// Audit log action IDs added by Discord in 2026 that discord.js hasn't exported
// as named enum members. Picked up directly from the gateway payload.
const VOICE_CHANNEL_STATUS_UPDATE = 192;
const VOICE_CHANNEL_STATUS_DELETE = 193;

export default {
  name: Events.GuildAuditLogEntryCreate,
  async execute(auditLogEntry, guild) {
    // Make every entry available to the gateway-event handlers that would
    // otherwise fetchAuditLogs to find the executor. Done BEFORE the ignore-guild
    // short-circuit so custom-bot guilds also benefit from the fast path.
    try { recordEntry(guild, auditLogEntry); } catch {}

    // Only the default bot should ignore guilds with custom bots
    if (guild.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

    try {
      // Handle webhook-related audit log entries
      if (auditLogEntry.action === AuditLogEvent.WebhookCreate) {
        await logWebhookCreate(auditLogEntry, guild);
      } else if (auditLogEntry.action === AuditLogEvent.WebhookUpdate) {
        await logWebhookUpdate(auditLogEntry, guild);
      } else if (auditLogEntry.action === AuditLogEvent.WebhookDelete) {
        await logWebhookDelete(auditLogEntry, guild);
      }
      // Handle bot/integration additions
      else if (auditLogEntry.action === AuditLogEvent.BotAdd) {
        await logBotAdd(auditLogEntry, guild);
      }
      // Handle MemberPrune — bulk member removal; always surfaces in the log channel,
      // and flags as a potential nuke if the count is unusually high.
      else if (auditLogEntry.action === AuditLogEvent.MemberPrune) {
        await logMemberPrune(auditLogEntry, guild);
      }
      // Voice channel status (the "set status" feature in VC) — new Discord action
      // IDs 192/193. Logged as a lightweight embed in the voice channel modlog.
      else if (auditLogEntry.action === VOICE_CHANNEL_STATUS_UPDATE) {
        await logVoiceChannelStatusUpdate(auditLogEntry, guild);
      }
      else if (auditLogEntry.action === VOICE_CHANNEL_STATUS_DELETE) {
        await logVoiceChannelStatusDelete(auditLogEntry, guild);
      }
    } catch (error) {
      logger.error('[GuildAuditLogEntryCreate] Error processing audit log', {
        error: error.message,
        stack: error.stack,
        guildId: guild?.id,
        action: auditLogEntry.action
      });
    }
  }
};

async function logWebhookCreate(entry, guild) {
  const executor = entry.executor;
  const target = entry.target;

  let channelName = 'Unknown Channel';
  let channelId = target?.channelId || target?.channel_id;

  if (channelId) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    channelName = channel ? `#${channel.name}` : `<#${channelId}>`;
  }

  const embed = new EmbedBuilder()
    .setColor(themeColor(guild?.id, 'success')) // Green
    .setTitle('🔗 Webhook Created')
    .setDescription(`A webhook was created in ${channelName}`)
    .addFields(
      { name: 'Webhook Name', value: target?.name || 'Unknown', inline: true },
      { name: 'Created By', value: executor ? `${executor.tag} (${executor.id})` : 'Unknown', inline: true }
    );

  if (channelName !== 'Unknown Channel') {
    embed.addFields({ name: 'Channel', value: channelName, inline: true });
  }

  embed.setTimestamp();

  await sendLogEmbed(guild, 'webhookUpdate', embed, 'webhookUpdate.created');
}

async function logWebhookUpdate(entry, guild) {
  const executor = entry.executor;
  const target = entry.target;
  const changes = entry.changes;

  // Try multiple ways to get channel
  let channelName = 'Unknown Channel';
  let channelId = target?.channelId || target?.channel_id;

  // Check if channelId is in the changes
  if (!channelId && changes) {
    const channelChange = changes.find(c => c.key === 'channel_id');
    if (channelChange) {
      channelId = channelChange.new || channelChange.old;
    }
  }

  if (channelId) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    channelName = channel ? `#${channel.name}` : `<#${channelId}>`;
  }

  const embed = new EmbedBuilder()
    .setColor(0xFEE75C) // Yellow
    .setTitle('🔗 Webhook Modified')
    .setDescription(`A webhook was modified in ${channelName}`)
    .addFields(
      { name: 'Webhook Name', value: target?.name || 'Unknown', inline: true },
      { name: 'Modified By', value: executor ? `${executor.tag} (${executor.id})` : 'Unknown', inline: true }
    );

  if (channelName !== 'Unknown Channel') {
    embed.addFields({ name: 'Channel', value: channelName, inline: true });
  }

  // Add change details - filter out channel_id changes as we show that separately
  if (changes && changes.length > 0) {
    const relevantChanges = changes.filter(c => c.key !== 'channel_id');

    if (relevantChanges.length > 0) {
      const changeDetails = relevantChanges.map(change => {
        let oldVal = change.old;
        let newVal = change.new;

        // Handle different value types
        if (oldVal === undefined || oldVal === null) oldVal = 'None';
        if (newVal === undefined || newVal === null) newVal = 'None';

        // Truncate long values
        if (typeof oldVal === 'string' && oldVal.length > 50) oldVal = oldVal.substring(0, 47) + '...';
        if (typeof newVal === 'string' && newVal.length > 50) newVal = newVal.substring(0, 47) + '...';

        return `**${change.key}**: \`${oldVal}\` → \`${newVal}\``;
      }).join('\n');

      if (changeDetails) {
        embed.addFields({ name: 'Changes', value: changeDetails.substring(0, 1024), inline: false });
      }
    }
  }

  embed.setTimestamp();

  await sendLogEmbed(guild, 'webhookUpdate', embed, 'webhookUpdate.modified');
}

async function logWebhookDelete(entry, guild) {
  const executor = entry.executor;
  const target = entry.target;

  let channelName = 'Unknown Channel';
  let channelId = target?.channelId || target?.channel_id;

  if (channelId) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    channelName = channel ? `#${channel.name}` : `<#${channelId}>`;
  }

  const embed = new EmbedBuilder()
    .setColor(themeColor(guild?.id, 'danger')) // Red
    .setTitle('🗑️ Webhook Deleted')
    .setDescription(`A webhook was deleted from ${channelName}`)
    .addFields(
      { name: 'Webhook Name', value: target?.name || 'Unknown', inline: true },
      { name: 'Deleted By', value: executor ? `${executor.tag} (${executor.id})` : 'Unknown', inline: true }
    );

  if (channelName !== 'Unknown Channel') {
    embed.addFields({ name: 'Channel', value: channelName, inline: true });
  }

  embed.setTimestamp();

  await sendLogEmbed(guild, 'webhookUpdate', embed, 'webhookUpdate.deleted');
}

async function logBotAdd(entry, guild) {
  const executor = entry.executor;
  const target = entry.target;

  // Trusted-bot check — does the admin pre-approve this bot ID?
  // Reads protection_allowlist kind='bot', target_id=<bot id>. Migration 338 extended the
  // kind enum to include 'bot' specifically for this surface. A null target (shouldn't happen
  // for BotAdd events, but defend) short-circuits to the untrusted branch so the log at least
  // flags that we saw a bot addition we couldn't identify.
  let trusted = false;
  if (target?.id && guild?.id) {
    try {
      const [rows] = await pool.execute(
        `SELECT 1 FROM protection_allowlist WHERE guild_id = ? AND kind = 'bot' AND target_id = ? LIMIT 1`,
        [guild.id, target.id]);
      trusted = rows.length > 0;
    } catch (err) {
      // Query failure (DB blip, schema predates mig 338) — fall through as untrusted so the
      // admin at least sees the bot-added log. Do NOT fail the whole handler.
      logger.warn('[guildAuditLogEntryCreate] trusted-bot lookup failed', { err: err.message });
    }
  }

  const embed = new EmbedBuilder()
    .setColor(trusted ? themeColor(guild?.id, 'primary') : 0xE35858)   // red for unauthorized
    .setTitle(trusted ? '🤖 Trusted Bot Added' : '⚠️ Unauthorized Bot Added')
    .setDescription(trusted
      ? 'A bot on this server\'s trusted list was added.'
      : 'A bot was added that is NOT on this server\'s trusted-bot list. Review the addition and either (a) add it to the trusted list, or (b) remove the bot.')
    .addFields(
      { name: 'Bot', value: target ? `${target.tag} (${target.id})` : 'Unknown', inline: true },
      { name: 'Added By', value: executor ? `${executor.tag} (${executor.id})` : 'Unknown', inline: true },
      { name: 'Trust Status', value: trusted ? 'Pre-approved' : 'Not on trusted list', inline: true },
    )
    .setTimestamp();

  await sendLogEmbed(guild, 'integrationUpdate', embed);
}

/**
 * MemberPrune — AuditLogEvent.MemberPrune fires when an admin uses Discord's "Prune"
 * feature to kick inactive members. Surfaces as a yellow alert in the log channel by
 * default; if the pruned count is >= 25 (configurable later), promotes to a red
 * potential-nuke flag so admins see it immediately.
 *
 * The audit-log entry's `extra` field carries `{ removed: <number>, days: <number> }` —
 * these are the only numeric signals Discord gives us without reading the member list
 * before and after. `entry.reason` carries whatever the admin typed when they confirmed.
 */
async function logMemberPrune(entry, guild) {
  const executor = entry.executor;
  const extra = entry.extra || {};
  const removed = Number(extra.removed) || Number(extra.membersRemoved) || 0;
  const days = Number(extra.days) || Number(extra.pruneDays) || null;
  const reason = entry.reason || null;

  // Simple nuke heuristic — tunable later via anti_nuke_config if we add a column for it.
  // 25 removes in one action is a lot; most legitimate server-grooming prunes are smaller.
  const isLarge = removed >= 25;

  const embed = new EmbedBuilder()
    .setColor(isLarge ? 0xE35858 : 0xE2B23A)
    .setTitle(isLarge ? '⚠️ Large Member Prune' : '🤹 Member Prune')
    .setDescription(isLarge
      ? `A member prune removed **${removed}** inactive members. Review the audit log and confirm this was intentional.`
      : `A member prune removed **${removed}** inactive members.`)
    .addFields(
      { name: 'Removed', value: String(removed), inline: true },
      { name: 'Inactive For', value: days ? `${days} day${days === 1 ? '' : 's'}` : 'Unknown', inline: true },
      { name: 'Executor', value: executor ? `${executor.tag} (${executor.id})` : 'Unknown', inline: true },
    )
    .setTimestamp();
  if (reason) embed.addFields({ name: 'Reason', value: String(reason).slice(0, 1024), inline: false });

  await sendLogEmbed(guild, 'memberRemove', embed);
}

/**
 * Voice channel status update (action 192). Fires when a member with
 * `SetVoiceChannelStatus` sets or changes the status line on a VC. The audit
 * entry's `target` is the channel; `extra` may include the raw status string
 * on newer Discords, otherwise it sits in `changes[].new`.
 */
async function logVoiceChannelStatusUpdate(entry, guild) {
  const executor = entry.executor;
  const channelId = entry.target?.id || entry.targetId;
  let channelName = channelId ? `<#${channelId}>` : 'Unknown channel';
  if (channelId) {
    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (ch) channelName = `#${ch.name}`;
  }

  // Pull the new status text from whichever shape Discord sent.
  let newStatus = null;
  if (entry.extra?.status) newStatus = String(entry.extra.status);
  if (!newStatus && Array.isArray(entry.changes)) {
    const c = entry.changes.find(c => c.key === 'status' || c.key === 'voice_channel_status');
    if (c) newStatus = String(c.new ?? c.old ?? '');
  }

  const embed = new EmbedBuilder()
    .setColor(themeColor(guild?.id, 'primary'))
    .setTitle('🔊 Voice Channel Status Set')
    .setDescription(`Status updated on ${channelName}.`)
    .addFields(
      { name: 'Set By', value: executor ? `${executor.tag} (${executor.id})` : 'Unknown', inline: true },
      { name: 'Status', value: newStatus ? newStatus.slice(0, 1024) : '*(cleared or hidden)*', inline: false },
    )
    .setTimestamp();

  await sendLogEmbed(guild, 'voiceChannelStatus', embed, 'voiceChannelStatus.update');
}

/**
 * Voice channel status cleared (action 193). Companion to the update above.
 */
async function logVoiceChannelStatusDelete(entry, guild) {
  const executor = entry.executor;
  const channelId = entry.target?.id || entry.targetId;
  let channelName = channelId ? `<#${channelId}>` : 'Unknown channel';
  if (channelId) {
    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (ch) channelName = `#${ch.name}`;
  }

  const embed = new EmbedBuilder()
    .setColor(themeColor(guild?.id, 'danger'))
    .setTitle('🔇 Voice Channel Status Cleared')
    .setDescription(`Status cleared on ${channelName}.`)
    .addFields(
      { name: 'Cleared By', value: executor ? `${executor.tag} (${executor.id})` : 'Unknown', inline: true },
    )
    .setTimestamp();

  await sendLogEmbed(guild, 'voiceChannelStatus', embed, 'voiceChannelStatus.delete');
}

