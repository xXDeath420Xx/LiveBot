import { Events } from 'discord.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import logger from '../utils/logger.js';
import { logMessageUpdate } from '../core/log-manager.js';
import { updateMessageContent } from '../utils/message-cache.js';
import { checkMessage as checkWordFilter } from '../core/word-filter.js';

export default {
  name: Events.MessageUpdate,
  async execute(oldMessage, newMessage) {
    try {
      // Deliberately NOT fetching a partial oldMessage: it is a detached clone, so
      // fetch() patches the cached (already-updated) message and leaves the clone
      // untouched — one API call per event that tells us nothing about the old
      // content. log-manager falls back to our message_logs copy instead.

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

      // An edit can add a filtered word to a message that was clean when it was sent.
      if (newMessage.guild && oldMessage.content !== newMessage.content
        && !(newMessage.client.isDefaultBot && await shouldIgnoreGuild(newMessage.guild.id))) {
        await checkWordFilter(newMessage);
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
