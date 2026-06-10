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
import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { findWord, remaining, initState, canTrace } from './wordseek.js';
import { renderGridImage } from './wordseek-image.js';
import * as wordBank from '../word-bank.js';
import { registerEngine, saveState, bumpStats, endSession } from '../word-game-manager.js';
import logger from '../../utils/logger.js';

export function freshGridState() {
  const words = wordBank.randomCommonWords(10, 4, 7);
  if (!words.length) throw new Error('word bank not loaded — cannot generate a WordSeek grid');
  return initState({ size: 12, words });
}

const WORD_RE = /^[A-Za-z]{2,}$/;

// The grid is rendered as a PNG IMAGE (big, legible, never wraps) attached to the
// embed; the found/remaining info sits in the embed fields beside it.
export function boardMessagePayload(state, { title, color } = {}) {
  const left = remaining(state);
  const lengths = left.map(w => w.length).sort((a, b) => a - b).join(', ');
  const foundList = state.found.length ? state.found.map(w => `~~${w.toUpperCase()}~~`).join(' · ') : '*none yet*';
  const file = new AttachmentBuilder(renderGridImage(state), { name: 'wordseek.png' });
  const embed = new EmbedBuilder()
    .setTitle(`🔡 ${title || 'WordSeek'}`)
    .setColor(color ?? 0x5865F2)
    .setImage('attachment://wordseek.png')
    .setDescription('Type any word you spot — forwards, backwards, or diagonally. **Any real word you can trace counts** (the listed ones + bonuses ✨).');
  const fields = [
    { name: `🎯 Target words ${state.found.length}/${state.words.length}`, value: foundList, inline: false },
    { name: 'Remaining target lengths', value: lengths || '—', inline: false },
  ];
  const bonus = state.bonus || [];
  if (bonus.length) {
    fields.push({ name: `✨ Bonus words found (${bonus.length})`, value: bonus.map(w => w.toUpperCase()).join(' · ').slice(0, 1024), inline: false });
  }
  embed.addFields(fields);
  return { embeds: [embed], files: [file] };
}

async function updateBoard(channel, state, opts) {
  const payload = boardMessagePayload(state, opts);
  if (state.boardMessageId) {
    try {
      const msg = await channel.messages.fetch(state.boardMessageId);
      await msg.edit({ ...payload, attachments: [] }); // clear old image, attach the new one
      return state.boardMessageId;
    } catch { /* re-post below */ }
  }
  try {
    const sent = await channel.send(payload);
    return sent.id;
  } catch (err) {
    logger.warn('[WordSeek] failed to post board', { error: err.message });
    return state.boardMessageId;
  }
}

async function handle(message, session) {
  const content = (message.content || '').trim();
  if (!WORD_RE.test(content)) return false; // not a lone word → let moderation/leveling run
  const word = content.toLowerCase().replace(/[^a-z]/g, '');
  const res = findWord(session.state, word);
  if (!res.ok) {
    // Not a planted target — but accept ANY real dictionary word the player can
    // actually trace in the grid (a "bonus" find), so legit words aren't rejected.
    const already = (session.state.bonus || []).includes(word) || session.state.found.includes(word);
    if (!already && word.length >= 4 && wordBank.isWord(word) && canTrace(session.state.grid, word)) {
      session.state.bonus = [...(session.state.bonus || []), word];
      try { await message.react('✨'); } catch { /* ignore */ }
      await bumpStats(session.guildId, message.author.id, 'wordseek', { words: 1, bestScore: word.length, streak: 0 });
      session.state.boardMessageId = await updateBoard(message.channel, session.state);
      await saveState(session);
      return true;
    }
    return false; // not a real word / not traceable in the grid → fall through
  }

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
