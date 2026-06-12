/**
 * Discord adapter for Coordle (collaborative Wordle). A single board message per
 * channel is edited in place as guesses come in. Anyone may guess; the channel
 * wins/loses together. Registered under 'coordle'; self-registers at boot.
 *
 * Consume rule: only a lone 5-letter alphabetic token is treated as a guess (and
 * consumed). Everything else — chat, URLs, multi-word — falls through so
 * moderation still runs. A 5-letter non-dictionary word is rejected with ❌ and
 * does NOT burn a guess.
 */
import { EmbedBuilder } from 'discord.js';
import { applyGuess, renderBoard, initState } from './coordle.js';
import * as wordBank from '../word-bank.js';
import { registerEngine, saveState, bumpStats } from '../word-game-manager.js';
import logger from '../../utils/logger.js';

const GUESS_RE = /^[A-Za-z]{5}$/;

export function boardEmbed(state, { title, color } = {}) {
  return new EmbedBuilder()
    .setTitle(title || '🟩 Coordle — guess the 5-letter word')
    .setColor(color ?? 0x5865F2)
    .setDescription(`${renderBoard(state)}\n\nGuesses: **${state.guesses.length}/${state.maxGuesses}** — type a 5-letter word.`);
}

async function updateBoard(channel, state, opts) {
  const embed = boardEmbed(state, opts);
  if (state.boardMessageId) {
    try {
      const msg = await channel.messages.fetch(state.boardMessageId);
      await msg.edit({ embeds: [embed] });
      return state.boardMessageId;
    } catch { /* message gone — post a fresh one below */ }
  }
  try {
    const sent = await channel.send({ embeds: [embed] });
    return sent.id;
  } catch (err) {
    logger.warn('[Coordle] failed to post board', { error: err.message });
    return state.boardMessageId;
  }
}

async function handle(message, session) {
  const content = (message.content || '').trim();
  if (!GUESS_RE.test(content)) return false; // not a guess → let moderation/leveling run
  const word = content.toLowerCase();

  if (wordBank.isLoaded() && !wordBank.isValidGuess(word, 5)) {
    try { await message.react('❌'); } catch { /* ignore */ }
    return false; // not a real word — fall through so moderation/leveling still run (and it doesn't burn a guess)
  }

  const res = applyGuess(session.state, word);
  if (!res.ok) return false; // game already over (stale session) → don't consume future messages
  if (!res.nextState.participants.includes(message.author.id)) res.nextState.participants.push(message.author.id);
  session.state = res.nextState;
  try { await message.react(res.status === 'won' ? '🎉' : res.status === 'lost' ? '💀' : '✅'); } catch { /* ignore */ }

  if (res.status === 'active') {
    session.state.boardMessageId = await updateBoard(message.channel, session.state);
    await saveState(session);
    return true;
  }

  // game over
  const won = res.status === 'won';
  await updateBoard(message.channel, session.state, {
    title: won ? '🎉 Coordle — solved!' : '💀 Coordle — out of guesses',
    color: won ? 0x57F287 : 0xED4245,
  });
  const answer = session.state.answer.toUpperCase();
  await message.channel.send(won
    ? `🎉 Solved in **${res.guessesUsed}/${session.state.maxGuesses}** — the word was **${answer}**!`
    : `💀 Out of guesses — the word was **${answer}**.`).catch(() => {});

  const bonus = won ? (session.state.maxGuesses - res.guessesUsed + 1) : 0;
  for (const uid of session.state.participants) {
    await bumpStats(session.guildId, uid, 'coordle', { played: 1, wins: won ? 1 : 0, bestScore: bonus, streak: 0 });
  }

  // Auto-roll a fresh puzzle so the game continues until someone runs `/wordgame coordle end`.
  const fresh = initState(wordBank.randomAnswer(5) || session.state.answer);
  fresh.boardMessageId = await updateBoard(message.channel, fresh, { title: '🟩 Coordle — new puzzle!' });
  session.state = fresh;
  await saveState(session);
  return true;
}

registerEngine('coordle', handle);
export default handle;
