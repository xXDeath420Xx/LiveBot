/**
 * Discord adapter for One Word Story. Appends each valid one-word message to the
 * shared story, reacts ✅, persists, and credits stats. Registered under
 * 'one_word_story'. Imported once at boot so it self-registers (one-way dep on
 * the manager — no circular import).
 *
 * Consume rule (moderation safety): only genuine single-word moves are consumed.
 * Multi-word messages, URLs, numbers and symbols (not_one_word / not_a_word /
 * empty) fall through so phishing/automod still scan them. A 'double_post' is a
 * real one-word move, so it is consumed (with a hint).
 */
import { validateMove } from './one-word-story.js';
import { registerEngine, saveState, bumpStats } from '../word-game-manager.js';
import logger from '../../utils/logger.js';

async function react(message, emoji) {
  try { await message.react(emoji); } catch (err) { logger.warn('[OneWordStory] react failed', { error: err.message }); }
}

function ephemeralHint(message, text) {
  message.channel.send(text).then(m => setTimeout(() => m.delete().catch(() => {}), 6000)).catch(() => {});
}

async function handle(message, session) {
  const content = message.content || '';
  if (!content.trim()) return false;
  const res = validateMove(content, session.state, {
    authorId: message.author.id,
    noDoublePost: session.state.noDoublePost !== false,
  });
  if (!res.ok) {
    if (res.reason === 'double_post') {
      await react(message, '🌀');
      ephemeralHint(message, '🌀 Let someone else add the next word before you go again.');
      return true; // genuine one-word move, just out of turn
    }
    return false; // not_one_word / not_a_word / empty → let moderation handle it
  }
  session.state = res.nextState;
  await saveState(session);
  await react(message, '✅');
  await bumpStats(session.guildId, message.author.id, 'one_word_story',
    { words: 1, bestScore: res.nextState.words.length, streak: res.nextState.words.length });
  return true;
}

registerEngine('one_word_story', handle);
export default handle;
