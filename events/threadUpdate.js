import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logThreadUpdate } from '../core/log-manager.js';

export default {
  name: Events.ThreadUpdate,
  async execute(oldThread, newThread) {
    try {
      await logThreadUpdate(oldThread, newThread);
    } catch (error) {
      logger.error('[ThreadUpdate] Error logging thread update', {
        error: error.message,
        stack: error.stack,
        guildId: newThread.guild?.id,
        threadId: newThread.id
      });
    }
  }
};
