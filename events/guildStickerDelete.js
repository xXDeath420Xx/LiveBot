import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logStickerDelete } from '../core/log-manager.js';

export default {
  name: Events.GuildStickerDelete,
  async execute(sticker) {
    try {
      await logStickerDelete(sticker);
    } catch (error) {
      logger.error('[GuildStickerDelete] Error logging sticker deletion', {
        error: error.message,
        stack: error.stack,
        guildId: sticker.guild?.id,
        stickerId: sticker.id
      });
    }
  }
};
