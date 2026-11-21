import { Events } from 'discord.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import logger from '../utils/logger.js';
import { logMessageDelete } from '../core/log-manager.js';

export default {
  name: Events.MessageDelete,
  async execute(message) {
    try {
      // A guild served by its own custom bot is logged by that bot — the same rule messageCreate
      // applies. Without it both bots posted the delete log (and, with deleted-image evidence on,
      // both re-uploaded the attachments).
      if (message.guild && message.client.isDefaultBot && await shouldIgnoreGuild(message.guild.id)) return;

      await logMessageDelete(message);

      // AI moderation learning loop: a moderator deleting a screened message (core/ai-moderation.js; not awaited).
      import('../core/ai-moderation.js').then(m => m.onMessageDeleted(message)).catch(() => {});

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
