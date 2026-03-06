import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logEmojiUpdate } from '../core/log-manager.js';

export default {
  name: Events.GuildEmojiUpdate,
  async execute(oldEmoji, newEmoji) {
    try {
      await logEmojiUpdate(oldEmoji, newEmoji);
    } catch (error) {
      logger.error('[GuildEmojiUpdate] Error logging emoji update', {
        error: error.message,
        stack: error.stack,
        guildId: newEmoji.guild?.id,
        emojiId: newEmoji.id
      });
    }
  }
};
