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
 *
 * Sticky board: the grid is kept as the LAST message in the channel. Editing it in place (the old
 * behaviour) left it scrolling up out of sight under guesses and chat, so players had to hunt for
 * the puzzle they were playing. Now every message that reaches the game schedules a repost at the
 * bottom — debounced, so a busy channel reposts at most every few seconds rather than per message.
 * The new board is sent BEFORE the old one is deleted, so there is never a moment with no board.
 */
import { EmbedBuilder } from 'discord.js';
import { findWord, remaining, initState, canTrace, nextHint } from './wordseek.js';
import { getConfig as getFeatureConfig } from '../feature-config.js';
import { accessibleAttachment } from '../../utils/accessible-attachment.js';
import { renderGridImage } from './wordseek-image.js';
import * as wordBank from '../word-bank.js';
import { registerEngine, saveState, bumpStats, getSessionByChannel } from '../word-game-manager.js';
import { announceResult, resultEmbed } from '../word-game-results.js';

/** Count a find for the result post (state.byUser: { userId: finds }). */
function creditFind(state, userId) {
  state.byUser = { ...(state.byUser || {}), [userId]: ((state.byUser || {})[userId] || 0) + 1 };
}
import logger from '../../utils/logger.js';

export function freshGridState() {
  const words = wordBank.randomCommonWords(10, 4, 7);
  if (!words.length) throw new Error('word bank not loaded — cannot generate a WordSeek grid');
  return initState({ size: 12, words });
}

const WORD_RE = /^[A-Za-z]{2,}$/;

/**
 * Read the puzzle out as text so it can be solved without seeing the image.
 *
 * A word search is one of the few things where dumping the raw data IS the
 * accessible presentation — the player needs the letters, and row-by-row is how
 * accessible word searches are conventionally given. Rows are labelled so a
 * player can refer to a position out loud.
 *
 * A 12x12 grid is ~12 rows of 24 characters plus the word list, comfortably
 * inside the 1024-character attachment description limit; normalizeAltText
 * clamps anything larger.
 */
function describeGrid(state, left) {
  const rows = state.grid
    .map((row, i) => `Row ${i + 1}: ${row.join(' ').toUpperCase()}`)
    .join('. ');
  const toFind = left.length
    ? `${left.length} word${left.length === 1 ? '' : 's'} left to find, of lengths ${left.map(w => w.length).sort((a, b) => a - b).join(', ')}.`
    : 'All words found.';
  const alreadyFound = state.found.length
    ? ` Already found: ${state.found.map(w => w.toUpperCase()).join(', ')}.`
    : '';
  return `WordSeek ${state.size} by ${state.size} letter grid. ${toFind}${alreadyFound} ${rows}.`;
}

// The grid is rendered as a PNG IMAGE (big, legible, never wraps) attached to the
// embed; the found/remaining info sits in the embed fields beside it.
export function boardMessagePayload(state, { title, color } = {}) {
  const left = remaining(state);
  const lengths = left.map(w => w.length).sort((a, b) => a - b).join(', ');
  // Alphabetical, not discovery order: with 20+ bonus finds, "was X already found?" has to be a scan.
  const alpha = list => [...list].sort((a, b) => a.localeCompare(b));
  const foundList = state.found.length ? alpha(state.found).map(w => `~~${w.toUpperCase()}~~`).join(' · ') : '*none yet*';
  // The grid only exists as pixels, so without this the game is unplayable for
  // anyone using a screen reader. Reading the letters row by row is how an
  // accessible word search is normally presented, and state.grid already holds
  // exactly that.
  const file = accessibleAttachment(renderGridImage(state), {
    name: 'wordseek.png',
    description: describeGrid(state, left),
  });
  const embed = new EmbedBuilder()
    .setTitle(`🔡 ${title || 'WordSeek'}`)
    .setColor(color ?? 0x5865F2)
    .setImage('attachment://wordseek.png')
    .setDescription('Type any word you spot — forwards, backwards, or diagonally. **Any real word you can trace counts** (the listed ones + bonuses ✨).');
  const fields = [
    { name: `🎯 Target words ${state.found.length}/${state.words.length}`, value: foundList, inline: false },
    { name: 'Remaining target lengths', value: lengths || '—', inline: false },
  ];
  if (state.hint?.text && !state.found.includes(state.hint.word)) {
    // The latest hint rides on the board so it can't scroll away either.
    fields.push({ name: `💡 Hint ${state.hint.level}`, value: state.hint.text.slice(0, 1024), inline: false });
  }
  const bonus = state.bonus || [];
  if (bonus.length) {
    fields.push({ name: `✨ Bonus words found (${bonus.length})`, value: alpha(bonus).map(w => w.toUpperCase()).join(' · ').slice(0, 1024), inline: false });
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

// ── sticky board ────────────────────────────────────────────────────────────────────
const BUMP_QUIET_MS = 2_500;   // repost once the channel has been quiet this long…
const BUMP_MAX_WAIT_MS = 8_000; // …or after this long of continuous chat, whichever comes first
const FIND_QUIET_MS = 1_000;   // a find should show quickly, but rapid finds still share one repost

const bumps = new Map(); // channelId -> { timer, firstAt, dirty, running: Promise|null }

function bumpState(channelId) {
  let b = bumps.get(channelId);
  if (!b) { b = { timer: null, firstAt: 0, dirty: false, running: null }; bumps.set(channelId, b); }
  return b;
}

/**
 * Ask for the board to be (re)shown at the bottom of the channel.
 * @param {boolean} dirty  the board's contents changed (a find), so it must be redrawn even if it
 *                         is already the last message
 */
function scheduleBump(channel, session, { dirty = false, quietMs = BUMP_QUIET_MS } = {}) {
  const b = bumpState(channel.id);
  if (dirty) b.dirty = true;
  const now = Date.now();
  if (!b.timer) b.firstAt = now;
  clearTimeout(b.timer);
  const delay = Math.max(0, Math.min(quietMs, b.firstAt + BUMP_MAX_WAIT_MS - now));
  b.timer = setTimeout(() => {
    b.timer = null;
    b.running = (b.running || Promise.resolve())
      .then(() => bumpBoard(channel, session))
      .catch(err => logger.warn('[WordSeek] board repost failed', { error: err.message }))
      .finally(() => { if (!b.timer) b.running = null; });
  }, delay);
}

/** Cancel a pending repost and wait out one in flight (before the round is replaced). */
async function settleBump(channelId) {
  const b = bumps.get(channelId);
  if (!b) return;
  clearTimeout(b.timer);
  b.timer = null;
  b.dirty = false;
  await b.running?.catch(() => {});
}

async function bumpBoard(channel, session) {
  // The round may have ended or been replaced while we waited.
  if (session.status !== 'active' || getSessionByChannel(channel.id)?.id !== session.id) return;
  const b = bumpState(channel.id);
  const dirty = b.dirty;
  b.dirty = false;

  const state = session.state;
  const oldId = state.boardMessageId;
  const isLast = oldId && channel.lastMessageId === oldId;

  if (isLast) {
    if (dirty) state.boardMessageId = await updateBoard(channel, state);   // already at the bottom: edit
    else return;                                                          // nothing to do
  } else {
    let sent;
    try {
      sent = await channel.send(boardMessagePayload(state));
    } catch (err) {
      logger.warn('[WordSeek] could not repost board', { error: err.message });
      if (dirty) state.boardMessageId = await updateBoard(channel, state); // at least keep it current
      return saveState(session);
    }
    state.boardMessageId = sent.id;
    if (oldId) {
      // Our own message, so no Manage Messages needed. Already gone is fine.
      channel.messages.delete(oldId).catch(() => {});
    }
  }
  await saveState(session);
}

// ── hints ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_HINT_AFTER = 8;

async function hintThreshold(guildId) {
  const cfg = await getFeatureConfig('wordgames', guildId).catch(() => ({}));
  const n = Number(cfg.wordseek_hint_after ?? DEFAULT_HINT_AFTER);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_HINT_AFTER;
}

/**
 * A wrong guess: a real dictionary word that is neither a target nor traceable. Every `threshold`
 * of them in a row (reset by a target find) posts the next, stronger hint.
 */
async function recordMiss(message, session) {
  const threshold = await hintThreshold(session.guildId);
  if (!threshold) return;                                   // 0 = hints off
  const state = session.state;
  state.misses = (state.misses || 0) + 1;
  if (state.misses < threshold) return;                     // counted in memory; persisted with the next save

  const result = nextHint(state);
  state.misses = 0;
  if (!result) return;
  state.hint = result.hint;
  await message.channel.send({ content: `💡 **Hint:** ${result.text}`, allowedMentions: { parse: [] } })
    .catch(err => logger.warn('[WordSeek] could not post hint', { error: err.message }));
  await saveState(session);
  scheduleBump(message.channel, session, { dirty: true, quietMs: FIND_QUIET_MS });
}

async function handle(message, session) {
  // Whatever this message is — a find, a miss, or chat — it pushed the board up.
  scheduleBump(message.channel, session);

  const content = (message.content || '').trim();
  if (!WORD_RE.test(content)) return false; // not a lone word → let moderation/leveling run
  const word = content.toLowerCase().replace(/[^a-z]/g, '');
  const res = findWord(session.state, word);
  if (!res.ok) {
    // Not a planted target — but accept ANY real dictionary word the player can
    // actually trace in the grid (a "bonus" find), so legit words aren't rejected.
    const already = (session.state.bonus || []).includes(word) || session.state.found.includes(word);
    const accepts = !already && word.length >= 3 && wordBank.isWord(word) && canTrace(session.state.grid, word);
    if (accepts) {
      session.state.bonus = [...(session.state.bonus || []), word];
      creditFind(session.state, message.author.id);
      try { await message.react('✨'); } catch { /* ignore */ }
      await bumpStats(session.guildId, message.author.id, 'wordseek', { words: 1, bestScore: word.length, streak: 0 });
      await saveState(session);
      scheduleBump(message.channel, session, { dirty: true, quietMs: FIND_QUIET_MS });
      return true;
    }
    // Only a real word that isn't in the grid counts as a wrong guess. A repeat of something already
    // found (either spelling) is a real spot, and chat like "lol" or "brb" isn't a guess at all.
    const wrongGuess = !already && res.reason !== 'already_found' && word.length >= 3 && wordBank.isWord(word);
    if (wrongGuess) await recordMiss(message, session).catch(err => logger.warn('[WordSeek] hint check failed', { error: err.message }));
    return false; // not a real word / not traceable in the grid → fall through
  }

  session.state = res.nextState;
  creditFind(session.state, message.author.id);
  // Progress resets the wrong-guess count; finding the hinted word retires its hint.
  session.state.misses = 0;
  if (session.state.hint?.word === res.word) session.state.hint = null;
  try { await message.react('✅'); } catch { /* ignore */ }
  await bumpStats(session.guildId, message.author.id, 'wordseek', { words: 1, bestScore: res.points, streak: 0 });

  if (!res.complete) {
    await saveState(session);
    scheduleBump(message.channel, session, { dirty: true, quietMs: FIND_QUIET_MS });
    return true;
  }

  // Round over: nothing pending may repost the finished grid underneath the new one.
  await settleBump(message.channel.id);
  await updateBoard(message.channel, session.state, { title: '🎉 WordSeek — all words found!', color: 0x57F287 });
  await message.channel.send(`🎉 All ${session.state.words.length} words found! (${session.state.words.map(w => w.toUpperCase()).join(', ')})`).catch(() => {});
  await announceResult({
    client: message.client, guildId: session.guildId, sourceChannelId: message.channel.id,
    embed: resultEmbed('wordseek', session.state, { outcome: 'complete', channelId: message.channel.id }),
  });
  // Auto-roll a fresh grid so the game continues until someone runs `/wordgame wordseek end`.
  const fresh = freshGridState();
  fresh.boardMessageId = await updateBoard(message.channel, fresh, { title: '🔡 WordSeek — new grid!' });
  session.state = fresh;
  await saveState(session);
  return true;
}

registerEngine('wordseek', handle);
export default handle;
