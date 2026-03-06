import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logStickerCreate } from '../core/log-manager.js';

export default {
  name: Events.GuildStickerCreate,
  async execute(sticker) {
    try {
      await logStickerCreate(sticker);
    } catch (error) {
      logger.error('[GuildStickerCreate] Error logging sticker creation', {
        error: error.message,
        stack: error.stack,
        guildId: sticker.guild?.id,
        stickerId: sticker.id
      });
    }
  }
};
