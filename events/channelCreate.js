import { Events, EmbedBuilder, ChannelType } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { themeColor } from '../core/guild-theme.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import { onChannelCreate as autoRoleCategories } from '../core/auto-role-categories.js';

export default {
  name: Events.ChannelCreate,
  async execute(channel) {
    try {
      const guild = channel.guild;
      if (!guild) return;

      // Auto-role-categories: generate a role + lock perms for new channels in registered categories.
      autoRoleCategories(channel).catch(() => {});

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
      const channelTypeDisplay = channelTypeName.toLowerCase();

      // Create embed
      const embed = new EmbedBuilder()
        .setColor(themeColor(guild?.id, 'success')) // Green
        .setTitle('📝 Channel Created')
        .setDescription(`A new ${channelTypeDisplay} has been created`)
        .addFields(
          { name: 'Channel', value: `${channel} (${channel.name})`, inline: true },
          { name: 'Type', value: channelTypeName, inline: true },
          { name: 'ID', value: `\`${channel.id}\``, inline: true }
        );

      // Add category if applicable
      if (channel.parent) {
        embed.addFields({ name: 'Category', value: channel.parent.name, inline: true });
      }

      // Add NSFW status if applicable
      if ('nsfw' in channel) {
        embed.addFields({ name: 'NSFW', value: channel.nsfw ? 'Yes' : 'No', inline: true });
      }

      embed.setTimestamp();

      // Send log
      await sendLogEmbed(guild, 'channelCreate', embed);

      // Persist to audit_logs like every other logged event (same row shape as
      // log-manager's logChannelCreate, which is not called here because it would post a
      // second embed). Where a custom bot serves the guild, only that bot writes the row.
      if (!(channel.client.isDefaultBot && await shouldIgnoreGuild(guild.id))) {
        await saveAuditLog(
          guild.id,
          'CHANNEL_CREATE',
          null,
          channel.id,
          null,
          channel.id,
          'Channel created',
          null,
          null,
          channel.name,
          { type: channel.type, typeName: channelTypeName, parentId: channel.parentId || null }
        );
      }

      logger.info('[ChannelCreate] Channel created', {
        guildId: guild.id,
        channelId: channel.id,
        channelName: channel.name,
        channelType: channelTypeName
      });
    } catch (error) {
      logger.error('[ChannelCreate] Error logging channel creation', {
        error: error.message,
        stack: error.stack,
        channelId: channel?.id,
        guildId: channel?.guild?.id
      });
    }
  }
};
