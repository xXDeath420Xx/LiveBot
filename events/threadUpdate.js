import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logThreadUpdate } from '../core/log-manager.js';
import { applyOnArchive } from '../core/forum-manager.js';

export default {
  name: Events.ThreadUpdate,
  async execute(oldThread, newThread) {
    try {
      // Forum "lock on archive" — this is the only place the archived flag can be seen
      // flipping, so it cannot be handled at thread creation.
      await applyOnArchive(oldThread, newThread).catch(err => {
        logger.warn('[ThreadUpdate] Forum lock-on-archive failed', {
          error: err.message, threadId: newThread.id,
        });
      });

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
