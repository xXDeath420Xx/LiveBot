import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logThreadCreate } from '../core/log-manager.js';

export default {
  name: Events.ThreadCreate,
  async execute(thread) {
    try {
      await logThreadCreate(thread);
    } catch (error) {
      logger.error('[ThreadCreate] Error logging thread creation', {
        error: error.message,
        stack: error.stack,
        guildId: thread.guild?.id,
        threadId: thread.id
      });
    }
  }
};
