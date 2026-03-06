import { Events } from 'discord.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import logger from '../utils/logger.js';
import { logMessageUpdate } from '../core/log-manager.js';
import { updateMessageContent } from '../utils/message-cache.js';

export default {
  name: Events.MessageUpdate,
  async execute(oldMessage, newMessage) {
    try {
      // Handle partial messages
      if (oldMessage.partial) {
        try {
          await oldMessage.fetch();
        } catch (error) {
          logger.debug('[MessageUpdate] Failed to fetch partial old message', {
            messageId: oldMessage.id
          });
          return;
        }
      }

      if (newMessage.partial) {
        try {
          await newMessage.fetch();
        } catch (error) {
          logger.debug('[MessageUpdate] Failed to fetch partial new message', {
            messageId: newMessage.id
          });
          return;
        }
      }

      await logMessageUpdate(oldMessage, newMessage);

      // Update cached content so delete logs show the latest version (fire-and-forget)
      if (newMessage.guild) {
        updateMessageContent(newMessage.id, newMessage.content);
      }
    } catch (error) {
      logger.error('[MessageUpdate] Error logging message update', {
        error: error.message,
        stack: error.stack,
        guildId: newMessage.guild?.id,
        messageId: newMessage.id
      });
    }
  }
};
