/**
 * One Word Story rules (pure). Players each add exactly ONE token; the bot builds
 * a story one word at a time. A token is a single word, a standalone punctuation
 * mark (to end/break a sentence), or a paragraph marker.
 *
 * state = { entries: [{ word, authorId, messageId }], words: string[], lastAuthorId }.
 * `entries` is the source of truth (carries authorId/messageId so a DELETED word can
 * be removed from the story); `words` is kept in sync as a plain string[] for any
 * consumer that reads it. Old saved states only have `words` — entriesOf() migrates.
 *
 * A valid word starts with a letter, then letters / apostrophes / hyphens, with at
 * most one trailing sentence punctuation ("Demon."). Standalone punctuation (".",
 * "!", "?", "," …) and a paragraph marker ("---" / "/p") are also valid moves. URLs,
 * symbols and pure numbers are REJECTED so the runtime lets them fall through to
 * phishing/automod (game channels must not be a moderation blind spot).
 */
const WORD_RE = /^[A-Za-z][A-Za-z'-]*[.,!?;:]?$/;
const PUNCT_RE = /^[.,!?;:…]{1,3}$/;           // a standalone punctuation move
const PARA_RE = /^(\/p|\/para|---|—{2,}|¶)$/i; // a paragraph-break move
const PARA_TOKEN = '¶';                        // internal marker stored for a paragraph break

export function initState() { return { entries: [], words: [], lastAuthorId: null }; }

// Source of truth: entries[]. Migrate an old state that only has words[].
function entriesOf(state) {
  if (Array.isArray(state.entries)) return state.entries;
  return (state.words || []).map(word => ({ word, authorId: null, messageId: null }));
}

function pack(entries, lastAuthorId) {
  return { entries, words: entries.map(e => e.word), lastAuthorId };
}

export function validateMove(content, state, opts = {}) {
  const noDoublePost = opts.noDoublePost !== false;
  const authorId = opts.authorId ?? null;
  const messageId = opts.messageId ?? null;
  const trimmed = String(content ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (/\s/.test(trimmed)) return { ok: false, reason: 'not_one_word' };

  const isPara = PARA_RE.test(trimmed);
  const isPunct = !isPara && PUNCT_RE.test(trimmed);
  const isWord = !isPara && !isPunct && WORD_RE.test(trimmed);
  if (!isWord && !isPunct && !isPara) return { ok: false, reason: 'not_a_word' };

  if (noDoublePost && authorId && state.lastAuthorId === authorId) {
    return { ok: false, reason: 'double_post' };
  }
  const token = isPara ? PARA_TOKEN : trimmed;
  const entries = [...entriesOf(state), { word: token, authorId, messageId }];
  return { ok: true, word: trimmed, nextState: pack(entries, authorId ?? state.lastAuthorId) };
}

/**
 * Remove the entry contributed by a now-deleted message (so a player can delete
 * their word and post a corrected one). Reverts lastAuthorId to the previous
 * contributor so the correction isn't blocked by the no-double-post rule.
 */
export function removeEntryByMessage(state, messageId) {
  const entries = entriesOf(state);
  const idx = entries.findIndex(e => e.messageId && String(e.messageId) === String(messageId));
  if (idx === -1) return { ok: false };
  const next = entries.slice(0, idx).concat(entries.slice(idx + 1));
  const lastAuthorId = next.length ? next[next.length - 1].authorId : null;
  return { ok: true, removed: entries[idx].word, nextState: pack(next, lastAuthorId) };
}

/**
 * Render the collected tokens as a readable story: no space before punctuation,
 * capitalize the first word and the start of each new sentence (after . ! ?), put
 * each sentence on its own line, and render paragraph markers as a blank line.
 */
export function renderStory(state) {
  const tokens = entriesOf(state).map(e => e.word);
  let out = '';
  let capNext = true;
  const trimEnd = (s) => s.replace(/[ \t]+$/, '');
  for (const tok of tokens) {
    if (tok === PARA_TOKEN) { out = out.replace(/\s+$/, '') + '\n\n'; capNext = true; continue; }
    const isPunct = /^[.,!?;:…]+$/.test(tok);
    if (isPunct) {
      out = trimEnd(out) + tok + ' ';
    } else {
      let word = tok;
      if (capNext && /[A-Za-z]/.test(word)) { word = word.replace(/[A-Za-z]/, c => c.toUpperCase()); capNext = false; }
      out += word + ' ';
    }
    if (/[.!?]$/.test(tok)) { out = trimEnd(out).replace(/\s+$/, '') + '\n'; capNext = true; } // sentence end → new line
  }
  return out.trim();
}
