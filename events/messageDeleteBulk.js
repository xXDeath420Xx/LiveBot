import { Events, EmbedBuilder } from 'discord.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { getMessagesByIds } from '../utils/message-cache.js';

export default {
  name: Events.MessageBulkDelete,
  async execute(messages, channel) {
    try {
      if (!channel.guild) return;

      const messageCount = messages.size;
      const channelMention = channel.toString();

      // Bulk lookup from DB for any uncached messages
      const messageIds = [...messages.keys()];
      const cachedMessages = await getMessagesByIds(messageIds);

      // Create a sample of deleted messages (up to 10)
      const messageSample = [];
      let count = 0;
      for (const [id, message] of messages) {
        if (count >= 10) break;
        const dbMsg = cachedMessages.get(id);
        const author = message.author ? message.author.tag : (dbMsg ? dbMsg.author_tag : 'Unknown');
        const rawContent = message.content || (dbMsg ? dbMsg.content : null);
        const content = rawContent ? rawContent.substring(0, 100) : '[No content]';
        messageSample.push(`**${author}**: ${content}`);
        count++;
      }

      const embed = new EmbedBuilder()
        .setColor(0xED4245) // Red
        .setTitle('🗑️ Bulk Message Delete')
        .setDescription(`${messageCount} messages were bulk deleted in ${channelMention}`)
        .addFields(
          { name: 'Channel', value: `${channel.name}`, inline: true },
          { name: 'Message Count', value: `${messageCount}`, inline: true },
          { name: 'Channel ID', value: `\`${channel.id}\``, inline: true }
        );

      // Add sample messages if available
      if (messageSample.length > 0) {
        embed.addFields({
          name: `Sample Messages (${messageSample.length} of ${messageCount})`,
          value: messageSample.join('\n').substring(0, 1024),
          inline: false
        });
      }

      embed.setTimestamp();

      await sendLogEmbed(channel.guild, 'messageDelete', embed);

      await saveAuditLog(
        channel.guild.id,
        'MESSAGE_BULK_DELETE',
        null,
        channel.id,
        null,
        null,
        `${messageCount} messages bulk deleted`,
        null,
        null,
        JSON.stringify({ messageCount, channelId: channel.id })
      );

      logger.info('[MessageBulkDelete] Bulk message deletion logged', {
        guildId: channel.guild.id,
        channelId: channel.id,
        messageCount
      });
    } catch (error) {
      logger.error('[MessageBulkDelete] Error logging bulk message deletion', {
        error: error.message,
        stack: error.stack,
        channelId: channel?.id,
        guildId: channel?.guild?.id
      });
    }
  }
};
