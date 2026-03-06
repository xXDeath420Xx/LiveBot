import { Events } from 'discord.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import logger from '../utils/logger.js';
import { logMessageDelete } from '../core/log-manager.js';

export default {
  name: Events.MessageDelete,
  async execute(message) {
    try {
      await logMessageDelete(message);

      // Handle starboard message deletion
      if (message.client.starboardManager) {
        await message.client.starboardManager.handleMessageDelete(message);
      }
    } catch (error) {
      logger.error('[MessageDelete] Error logging message deletion', {
        error: error.message,
        stack: error.stack,
        guildId: message.guild?.id,
        messageId: message.id
      });
    }
  }
};
