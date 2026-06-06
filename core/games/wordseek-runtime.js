/**
 * Discord adapter for WordSeek. Posts a grid embed and edits it as words are
 * found. Registered under 'wordseek'; self-registers at boot.
 *
 * Consume rule: only a SUCCESSFUL find (a lone alphabetic word that is planted
 * and not yet found) is consumed. Everything else — chat, multi-word, URLs,
 * wrong/duplicate guesses — falls through so moderation/leveling still run and
 * the channel isn't ❌-spammed. (A lone a-z word can't be a URL/scam.)
 *
 * v1 has no auto-timeout: a round ends when all words are found or via
 * `/wordgame wordseek end`. Timed rounds are a future addition.
 */
import { EmbedBuilder } from 'discord.js';
import { findWord, remaining, renderGrid, initState } from './wordseek.js';
import * as wordBank from '../word-bank.js';
import { registerEngine, saveState, bumpStats, endSession } from '../word-game-manager.js';
import logger from '../../utils/logger.js';

export function freshGridState() {
  return initState({ size: 10, words: wordBank.randomWords(8, 4, 7) });
}

const WORD_RE = /^[A-Za-z]{2,}$/;

export function gridEmbed(state, { title, color } = {}) {
  const left = remaining(state);
  const lengths = left.map(w => w.length).sort((a, b) => a - b).join(', ');
  const foundList = state.found.length ? state.found.map(w => `~~${w.toUpperCase()}~~`).join(' · ') : '*none yet*';
  return new EmbedBuilder()
    .setTitle(title || '🔡 WordSeek — find the hidden words')
    .setColor(color ?? 0x5865F2)
    .setDescription(`\`\`\`\n${renderGrid(state)}\n\`\`\``)
    .addFields(
      { name: `Found ${state.found.length}/${state.words.length}`, value: foundList, inline: false },
      { name: 'Remaining word lengths', value: lengths || '—', inline: false },
    );
}

async function updateBoard(channel, state, opts) {
  const embed = gridEmbed(state, opts);
  if (state.boardMessageId) {
    try {
      const msg = await channel.messages.fetch(state.boardMessageId);
      await msg.edit({ embeds: [embed] });
      return state.boardMessageId;
    } catch { /* re-post below */ }
  }
  try {
    const sent = await channel.send({ embeds: [embed] });
    return sent.id;
  } catch (err) {
    logger.warn('[WordSeek] failed to post board', { error: err.message });
    return state.boardMessageId;
  }
}

async function handle(message, session) {
  const content = (message.content || '').trim();
  if (!WORD_RE.test(content)) return false; // not a lone word → let moderation/leveling run
  const res = findWord(session.state, content);
  if (!res.ok) return false; // wrong/duplicate guess → fall through (no swallow, no ❌ spam)

  session.state = res.nextState;
  try { await message.react('✅'); } catch { /* ignore */ }
  await bumpStats(session.guildId, message.author.id, 'wordseek', { words: 1, bestScore: res.points, streak: 0 });

  if (!res.complete) {
    session.state.boardMessageId = await updateBoard(message.channel, session.state);
    await saveState(session);
    return true;
  }

  await updateBoard(message.channel, session.state, { title: '🎉 WordSeek — all words found!', color: 0x57F287 });
  await message.channel.send(`🎉 All ${session.state.words.length} words found! (${session.state.words.map(w => w.toUpperCase()).join(', ')})`).catch(() => {});
  if (session.mode === 'persistent') {
    // auto-roll a fresh grid so a bound channel stays playable
    const fresh = freshGridState();
    fresh.boardMessageId = await updateBoard(message.channel, fresh, { title: '🔡 WordSeek — new grid!' });
    session.state = fresh;
    await saveState(session);
  } else {
    await endSession(session, 'ended');
  }
  return true;
}

registerEngine('wordseek', handle);
export default handle;
