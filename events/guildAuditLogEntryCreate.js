import { Events, AuditLogEvent, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
  name: Events.GuildAuditLogEntryCreate,
  async execute(auditLogEntry, guild) {
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
    .setColor(0x57F287) // Green
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

  await sendLogEmbed(guild, 'webhookUpdate', embed);
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

  await sendLogEmbed(guild, 'webhookUpdate', embed);
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
    .setColor(0xED4245) // Red
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

  await sendLogEmbed(guild, 'webhookUpdate', embed);
}

async function logBotAdd(entry, guild) {
  const executor = entry.executor;
  const target = entry.target;

  const embed = new EmbedBuilder()
    .setColor(0x5865F2) // Blurple
    .setTitle('🤖 Bot Added')
    .setDescription(`A bot was added to the server`)
    .addFields(
      { name: 'Bot', value: target ? `${target.tag} (${target.id})` : 'Unknown', inline: true },
      { name: 'Added By', value: executor ? `${executor.tag} (${executor.id})` : 'Unknown', inline: true }
    )
    .setTimestamp();

  await sendLogEmbed(guild, 'integrationUpdate', embed);
}
