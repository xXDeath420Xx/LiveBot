import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logGuildBanRemove } from '../core/log-manager.js';

export default {
  name: Events.GuildBanRemove,
  async execute(ban) {
    try {
      await logGuildBanRemove(ban);
    } catch (error) {
      logger.error('[GuildBanRemove] Error logging unban', {
        error: error.message,
        stack: error.stack,
        guildId: ban.guild?.id,
        userId: ban.user?.id
      });
    }
  }
};
