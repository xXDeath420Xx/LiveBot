import { Events, EmbedBuilder, ChannelType, AuditLogEvent } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { themeColor } from '../core/guild-theme.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import { waitForEntry } from '../utils/audit-log-correlator.js';
import { onChannelDelete as autoRoleCategoryChannelDelete } from '../core/auto-role-categories.js';

export default {
  name: Events.ChannelDelete,
  async execute(channel) {
    try {
      const guild = channel.guild;
      if (!guild) return;

      // Inverse of the auto-role-category create flow: if the parent category is
      // registered and no sibling channel still derives the same role name, drop
      // the role (which cascades through guildRoleDelete to clean the panel).
      autoRoleCategoryChannelDelete(channel).catch(() => {});

      // Correlator first; direct audit log fetch is now a fallback.
      let entry = await waitForEntry(guild.id, AuditLogEvent.ChannelDelete, channel.id, 1000);
      if (!entry) {
        const auditLogs = await guild.fetchAuditLogs({
          type: AuditLogEvent.ChannelDelete,
          limit: 1
        }).catch(() => null);
        if (auditLogs && auditLogs.entries.size > 0) {
          const first = auditLogs.entries.first();
          if (first.target?.id === channel.id) entry = first;
        }
      }

      let executorId = null;
      if (entry) {
        executorId = entry.executor?.id || null;
        if (channel.client.antiNukeManager) {
          await channel.client.antiNukeManager.trackChannelDelete(guild, channel, entry.executor);
        }
      }

      // Get channel type name
      const channelTypes = {
        [ChannelType.GuildText]: 'Text Channel',
        [ChannelType.GuildVoice]: 'Voice Channel',
        [ChannelType.GuildCategory]: 'Category',
        [ChannelType.GuildAnnouncement]: 'Announcement Channel',
        [ChannelType.GuildStageVoice]: 'Stage Channel',
        [ChannelType.GuildForum]: 'Forum Channel',
        [ChannelType.GuildDirectory]: 'Directory',
        [ChannelType.GuildMedia]: 'Media Channel'
      };

      const channelTypeName = channelTypes[channel.type] || 'Unknown';

      // Create embed
      const embed = new EmbedBuilder()
        .setColor(themeColor(guild?.id, 'danger')) // Red
        .setTitle('🗑️ Channel Deleted')
        .setDescription(`A ${channelTypeName.toLowerCase()} has been deleted`)
        .addFields(
          { name: 'Channel Name', value: channel.name, inline: true },
          { name: 'Type', value: channelTypeName, inline: true },
          { name: 'ID', value: `\`${channel.id}\``, inline: true }
        );

      // Add category if applicable
      if (channel.parent) {
        embed.addFields({ name: 'Category', value: channel.parent.name, inline: true });
      }

      embed.setTimestamp();

      // Send log
      await sendLogEmbed(guild, 'channelDelete', embed);

      // Persist to audit_logs like every other logged event (same row shape as
      // log-manager's logChannelDelete, which is not called here because it would post a
      // second embed). Where a custom bot serves the guild, only that bot writes the row.
      if (!(channel.client.isDefaultBot && await shouldIgnoreGuild(guild.id))) {
        await saveAuditLog(
          guild.id,
          'CHANNEL_DELETE',
          null,
          channel.id,
          executorId,
          channel.id,
          'Channel deleted',
          null,
          channel.name,
          null,
          { type: channel.type, typeName: channelTypeName, parentId: channel.parentId || null }
        );
      }

      logger.info('[ChannelDelete] Channel deleted', {
        guildId: guild.id,
        channelId: channel.id,
        channelName: channel.name,
        channelType: channelTypeName
      });
    } catch (error) {
      logger.error('[ChannelDelete] Error logging channel deletion', {
        error: error.message,
        stack: error.stack,
        channelId: channel?.id,
        guildId: channel?.guild?.id
      });
    }
  }
};
