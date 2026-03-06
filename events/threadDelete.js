import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logThreadDelete } from '../core/log-manager.js';

export default {
  name: Events.ThreadDelete,
  async execute(thread) {
    try {
      await logThreadDelete(thread);
    } catch (error) {
      logger.error('[ThreadDelete] Error logging thread deletion', {
        error: error.message,
        stack: error.stack,
        guildId: thread.guild?.id,
        threadId: thread.id
      });
    }
  }
};
