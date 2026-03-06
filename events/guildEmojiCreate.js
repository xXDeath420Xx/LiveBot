import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logEmojiCreate } from '../core/log-manager.js';

export default {
  name: Events.GuildEmojiCreate,
  async execute(emoji) {
    try {
      await logEmojiCreate(emoji);
    } catch (error) {
      logger.error('[GuildEmojiCreate] Error logging emoji creation', {
        error: error.message,
        stack: error.stack,
        guildId: emoji.guild?.id,
        emojiId: emoji.id
      });
    }
  }
};
