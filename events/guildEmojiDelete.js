import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logEmojiDelete } from '../core/log-manager.js';

export default {
  name: Events.GuildEmojiDelete,
  async execute(emoji) {
    try {
      await logEmojiDelete(emoji);
    } catch (error) {
      logger.error('[GuildEmojiDelete] Error logging emoji deletion', {
        error: error.message,
        stack: error.stack,
        guildId: emoji.guild?.id,
        emojiId: emoji.id
      });
    }
  }
};
