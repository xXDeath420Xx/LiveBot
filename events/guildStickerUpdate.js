import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logStickerUpdate } from '../core/log-manager.js';

export default {
  name: Events.GuildStickerUpdate,
  async execute(oldSticker, newSticker) {
    try {
      await logStickerUpdate(oldSticker, newSticker);
    } catch (error) {
      logger.error('[GuildStickerUpdate] Error logging sticker update', {
        error: error.message,
        stack: error.stack,
        guildId: newSticker.guild?.id,
        stickerId: newSticker.id
      });
    }
  }
};
