/**
 * When a player DELETES their One Word Story word, remove it from the story (and
 * revert the last-author so their corrected re-post isn't blocked by the
 * no-double-post rule). Fires for every client; the session map is process-global.
 * Only needs the deleted message's id + channel (works on uncached partials).
 */
import { getSessionByChannel, saveState } from '../core/word-game-manager.js';
import { removeEntryByMessage } from '../core/games/one-word-story.js';
import logger from '../utils/logger.js';

export default {
  name: 'messageDelete',
  async execute(message) {
    try {
      const channelId = message.channelId || message.channel?.id;
      if (!channelId) return;
      const session = getSessionByChannel(channelId);
      if (!session || session.gameType !== 'one_word_story') return;

      const res = removeEntryByMessage(session.state, message.id);
      if (!res.ok) return; // the deleted message wasn't a tracked story word

      session.state = res.nextState;
      await saveState(session);
      logger.info('[OneWordStory] removed deleted word from story', { channelId, removed: res.removed });
    } catch (err) {
      logger.warn('[OneWordStory] messageDelete handler failed', { error: err.message });
    }
  },
};
