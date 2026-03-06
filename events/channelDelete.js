import { Events, EmbedBuilder, ChannelType, AuditLogEvent } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed } from '../core/log-manager.js';

export default {
  name: Events.ChannelDelete,
  async execute(channel) {
    try {
      const guild = channel.guild;
      if (!guild) return;

      // Check anti-nuke
      const auditLogs = await guild.fetchAuditLogs({
        type: AuditLogEvent.ChannelDelete,
        limit: 1
      }).catch(() => null);

      if (auditLogs && auditLogs.entries.size > 0) {
        const entry = auditLogs.entries.first();
        if (entry.target.id === channel.id && channel.client.antiNukeManager) {
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
        .setColor(0xED4245) // Red
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
