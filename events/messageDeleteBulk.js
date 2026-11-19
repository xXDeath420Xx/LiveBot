import { Events, EmbedBuilder } from 'discord.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog, resolveLogTarget } from '../core/log-manager.js';
import { getMessagesByIds, markMessagesDeleted } from '../utils/message-cache.js';
import { themeColor } from '../core/guild-theme.js';
import { getEvidenceConfig, preserveBulkDeletedAttachments } from '../core/evidence-capture.js';

export default {
  name: Events.MessageBulkDelete,
  async execute(messages, channel) {
    try {
      if (!channel.guild) return;
      // Same rule as messageCreate / messageDelete: a custom bot logs its own guilds.
      if (channel.client.isDefaultBot && await shouldIgnoreGuild(channel.guild.id)) return;

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

      // Attachments of the purged messages. Bots' own messages are skipped; opted-out members
      // are skipped inside preserveBulkDeletedAttachments.
      const withAttachments = [];
      for (const [id, message] of messages) {
        if (message.author?.bot) continue;
        const dbMsg = cachedMessages.get(id);
        if (!message.attachments?.size && !dbMsg?.attachment_urls) continue;
        withAttachments.push({
          messageId: id,
          authorId: message.author?.id ?? dbMsg?.author_id ?? null,
          liveAttachments: message.attachments?.size ? message.attachments : null,
          logRow: dbMsg ?? null,
        });
      }

      let evidence = null;
      if (withAttachments.length && (await getEvidenceConfig(channel.guild.id)).enabled) {
        const target = await resolveLogTarget(channel.guild.id, 'messageDelete').catch((error) => {
          logger.error('[MessageBulkDelete] Could not resolve the delete-log channel', { guildId: channel.guild.id, error: error.message });
          return null;
        });
        evidence = await preserveBulkDeletedAttachments({
          guild: channel.guild,
          sourceChannelId: channel.id,
          entries: withAttachments,
          fallbackChannelId: target?.channelId || null,
        }).catch((error) => {
          logger.error('[MessageBulkDelete] Evidence capture failed', { guildId: channel.guild.id, error: error.message });
          return null;
        });
      }

      const embed = new EmbedBuilder()
        // `message` here used to be the for-of loop variable above, which is out of scope
        // by this point — every bulk delete threw "message is not defined" before the
        // embed was ever sent, so bulk-delete logging never worked. The guild is the
        // channel's guild; that's already been null-checked at the top.
        .setColor(themeColor(channel.guild.id, 'danger')) // Red
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

      if (withAttachments.length > 0) {
        let value;
        if (evidence && evidence.jumpUrl) {
          value = `${evidence.rehosted} image(s) from ${evidence.messages} message(s) preserved: [view evidence](${evidence.jumpUrl})`;
          if (evidence.failed) value += `\n${evidence.failed} file(s) not preserved (not images, too large or no longer available).`;
          if (evidence.truncated) value += '\nOnly the first 30 files were preserved.';
        } else if (evidence) {
          value = `${withAttachments.length} message(s) had attachments; none could be preserved.`;
        } else {
          value = `${withAttachments.length} message(s) had attachments. Turn on **Deleted-image evidence** on the dashboard to keep copies.`;
        }
        if (evidence?.skippedOptOut) value += `\n${evidence.skippedOptOut} message(s) skipped: author opted out of message logging.`;
        embed.addFields({ name: 'Attachments', value: value.substring(0, 1024), inline: false });
      }

      embed.setTimestamp();

      await sendLogEmbed(channel.guild, 'messageDelete', embed, 'messageDelete', { channel });

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

      // Cached copies of purged messages become evidence rather than plain cache.
      await markMessagesDeleted(messageIds, 'BULK_DELETE');

      logger.info('[MessageBulkDelete] Bulk message deletion logged', {
        guildId: channel.guild.id,
        channelId: channel.id,
        messageCount,
        preservedImages: evidence?.rehosted ?? 0
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
