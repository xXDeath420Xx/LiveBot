/**
 * One Word Story rules (pure). Players each add exactly ONE word; the bot builds
 * a story one word at a time. state = { words: string[], lastAuthorId: string|null }.
 *
 * A valid word is a single token: starts with a letter, then letters / apostrophes
 * / hyphens, with at most one trailing sentence punctuation. This deliberately
 * REJECTS URLs, symbols and pure numbers so the runtime can let that content fall
 * through to phishing/automod instead of swallowing it (game channels must not be
 * a moderation blind spot — see project_word_games).
 */
const WORD_RE = /^[A-Za-z][A-Za-z'-]*[.,!?;:]?$/;

export function initState() { return { words: [], lastAuthorId: null }; }

export function renderStory(state) { return (state.words || []).join(' '); }

export function validateMove(content, state, opts = {}) {
  const noDoublePost = opts.noDoublePost !== false;
  const authorId = opts.authorId ?? null;
  const trimmed = String(content ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (/\s/.test(trimmed)) return { ok: false, reason: 'not_one_word' };
  if (!WORD_RE.test(trimmed)) return { ok: false, reason: 'not_a_word' };
  if (noDoublePost && authorId && state.lastAuthorId === authorId) {
    return { ok: false, reason: 'double_post' };
  }
  const nextState = { words: [...state.words, trimmed], lastAuthorId: authorId ?? state.lastAuthorId };
  return { ok: true, word: trimmed, nextState };
}
