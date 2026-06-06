/**
 * Discord adapter for Last Letter: consumes a channel message, runs the pure
 * engine, reacts ✅/❌, persists state, and credits stats. Registered with the
 * word-game manager under game type 'last_letter'. Imported once at boot
 * (index.js) so it self-registers; it never gets imported BY the manager, so
 * there is no circular dependency.
 */
import { validateMove } from './last-letter.js';
import * as wordBank from '../word-bank.js';
import { registerEngine, saveState, bumpStats } from '../word-game-manager.js';
import logger from '../../utils/logger.js';

const HINTS = {
  not_a_word: (w) => `❌ \`${w}\` isn't a word I know.`,
  wrong_letter: (w, exp) => `❌ \`${w}\` must start with **${exp.toUpperCase()}**.`,
  repeat: (w) => `❌ \`${w}\` was already used.`,
};

async function react(message, emoji) {
  try { await message.react(emoji); } catch (err) { logger.warn('[LastLetter] react failed', { error: err.message }); }
}

async function handle(message, session) {
  const content = message.content || '';
  // ignore empty/attachment-only messages so they don't break the chain
  if (!content.trim()) return false;
  const res = validateMove(content, session.state, { requireDictionary: wordBank.isLoaded() });
  if (!res.ok) {
    if (res.reason === 'empty') return false; // not a move attempt
    await react(message, '❌');
    const hintFn = HINTS[res.reason];
    const word = (content.trim().split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z]/g, '');
    const hint = hintFn ? hintFn(word, res.expected) : null;
    if (hint) {
      message.channel.send(hint).then(m => setTimeout(() => m.delete().catch(() => {}), 6000)).catch(() => {});
    }
    // Only consume real game moves. `not_a_word` content (URLs, gibberish, scam
    // text) must fall through so phishing/automod/selfbot detection still runs —
    // a game channel must not be a moderation blind spot. `wrong_letter`/`repeat`
    // already passed the dictionary check, so they're safe to consume.
    return res.reason !== 'not_a_word';
  }
  session.state = res.nextState;
  await saveState(session);
  await react(message, '✅');
  await bumpStats(session.guildId, message.author.id, 'last_letter',
    { words: 1, bestScore: res.nextState.count, streak: res.nextState.count });
  return true;
}

registerEngine('last_letter', handle);
export default handle;
