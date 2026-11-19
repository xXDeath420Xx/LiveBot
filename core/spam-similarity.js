/*
 * Near-duplicate detection for multi-channel spam.
 *
 * adaptive-spam-manager grouped cross-channel posts by an exact SHA-256 of the message, with URLs
 * collapsed to [URL]. That only catches someone who copy-pastes byte-identical text, and nobody
 * spamming five channels does that — they add an emoji, swap a word, tag a different role, or
 * reorder a sentence, and every copy lands in its own bucket where nothing looks repeated.
 *
 * Similarity here is Jaccard over word trigrams, which survives exactly those edits while still
 * separating genuinely different messages. Short posts fall back to character 4-grams, because a
 * six-word message has too few trigrams for the overlap to mean anything.
 *
 * Pure and DB-free so it can be unit-tested; the tracker holds only in-memory state.
 */

import crypto from 'node:crypto';

const URL_RE = /https?:\/\/\S+|\bwww\.\S+/g;
const MENTION_RE = /<@[!&]?\d+>|<#\d+>|<a?:\w+:\d+>/g;

/**
 * Strip everything a spammer varies for free, keeping the words that carry the message.
 * Mentions and URLs become placeholders rather than disappearing — "join <#a>" and "join <#b>"
 * should still look alike, but "join" alone should not match every other one-word post.
 */
export function normaliseForSimilarity(content) {
  return String(content || '')
    .toLowerCase()
    .replace(URL_RE, ' url ')
    .replace(MENTION_RE, ' mention ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')  // emoji
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The tokens normalisation substitutes in. A message made of nothing but these carries no content
// of its own — see the note in shingles().
const PLACEHOLDER_TOKENS = new Set(['url', 'mention']);

/** Word trigrams, or character 4-grams when the message is too short for trigrams to be meaningful. */
export function shingles(text, k = 3) {
  const words = text.split(' ').filter(Boolean);
  const out = new Set();

  // A message that is ONLY placeholders has nothing comparable in it. Normalisation deliberately
  // collapses every link to "url" and every mention to "mention" so that "join <#a>" and "join
  // <#b>" still look alike — but it means a bare "https://one.example" and a bare
  // "https://something-else.example" both reduce to the single token "url" and scored 1.00 against
  // each other, as did two different @mentions. Posting three unrelated links in three channels
  // was therefore a "near-identical cluster".
  //
  // The distinguishing word is what makes a match evidence; "url" on its own is what every link
  // post has in common. No shingles means no evidence, and similarity() reads that as 0.
  if (words.length && words.every(w => PLACEHOLDER_TOKENS.has(w))) return out;

  if (words.length >= k + 1) {
    for (let i = 0; i + k <= words.length; i++) out.add(words.slice(i, i + k).join(' '));
    return out;
  }
  const flat = words.join(' ');
  if (flat.length < 4) return flat ? new Set([flat]) : out;
  for (let i = 0; i + 4 <= flat.length; i++) out.add(flat.slice(i, i + 4));
  return out;
}

/**
 * Overlap of two shingle sets.
 *
 * Containment — |A ∩ B| / min(|A|,|B|) — rather than Jaccard, because the messages being compared
 * are usually different lengths and Jaccard punishes that twice. Inserting one word into a short
 * ad breaks two trigrams AND grows the union, dragging "Free nitro giveaway! Join now" vs
 * "...Join now guys" down to 0.50 when they are obviously the same post. Containment reads it as
 * 0.75, which is what a human would say.
 *
 * Only used once both sides have enough shingles to mean something; below that it degenerates
 * (a two-shingle message is trivially "contained" in anything) so Jaccard takes over.
 */
export function similarity(a, b) {
  const A = a instanceof Set ? a : shingles(normaliseForSimilarity(a));
  const B = b instanceof Set ? b : shingles(normaliseForSimilarity(b));

  // Nothing left after normalisation is an ABSENCE of evidence, not proof of a match.
  //
  // This used to return 1 when both sides normalised to nothing, and that is the same mistake the
  // character-spam filter made when it counted spaces: a property that ordinary messages satisfy
  // for free was being read as a signal. normaliseForSimilarity strips emoji, mentions and URLs, so
  // "🎉" and "👍" both reduce to nothing and scored 1.00 against each other — as did two different
  // @mentions, and two entirely different links. A member dropping a different emoji in three
  // channels was a "near-identical cross-channel cluster".
  //
  // Two messages with no comparable content are not evidence of anything, so they score 0 and the
  // caller is left to decide on other grounds. Image-only posts are keyed on the attachment itself
  // (see adaptive-spam-manager's attachmentKey) rather than being funnelled through here.
  if (!A.size || !B.size) return 0;

  let inter = 0;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  for (const s of small) if (large.has(s)) inter++;

  if (small.size >= 3) return inter / small.size;
  return inter / (A.size + B.size - inter);
}

export const DEFAULT_SIMILARITY = 0.65;

/**
 * Tracks recent posts per (guild, user) and reports when near-duplicates appear across channels.
 *
 * Bounded by construction: a fixed number of posts per user and a fixed number of tracked users,
 * both evicted oldest-first, so a busy guild cannot grow this without limit. Comparison is against
 * that small per-user window only — no global scan.
 */
export class CrossChannelTracker {
  constructor({ maxPostsPerUser = 12, maxUsers = 5000, windowMs = 5 * 60 * 1000 } = {}) {
    this.maxPostsPerUser = maxPostsPerUser;
    this.maxUsers = maxUsers;
    this.windowMs = windowMs;
    this.users = new Map(); // "guild:user" -> [{ channelId, shingles, content, at }]
  }

  /**
   * Record a post and report on the near-duplicate cluster it belongs to.
   *
   * @returns {{channels:string[], count:number, similarity:number, matches:number}} the distinct
   *          channels this message (or something close to it) has now appeared in.
   */
  add(guildId, userId, channelId, content, { threshold = DEFAULT_SIMILARITY, now = Date.now() } = {}) {
    const key = `${guildId}:${userId}`;
    const norm = normaliseForSimilarity(content);
    const sh = shingles(norm);

    if (!this.users.has(key)) {
      if (this.users.size >= this.maxUsers) this.users.delete(this.users.keys().next().value);
      this.users.set(key, []);
    }
    const posts = this.users.get(key);

    // Drop anything outside the window before comparing — a repeat an hour later is not a burst.
    const live = posts.filter(p => now - p.at <= this.windowMs);

    let best = 0;
    let matches = 0;
    const channels = new Set([channelId]);
    for (const p of live) {
      const s = similarity(sh, p.shingles);
      if (s >= threshold) {
        matches++;
        if (s > best) best = s;
        channels.add(p.channelId);
      }
    }

    live.push({ channelId, shingles: sh, content: norm.slice(0, 120), at: now });
    while (live.length > this.maxPostsPerUser) live.shift();
    this.users.set(key, live);

    return { channels: [...channels], count: channels.size, similarity: best, matches };
  }

  /** Forget a user's history — used when a moderator clears them, so they start clean. */
  forget(guildId, userId) { this.users.delete(`${guildId}:${userId}`); }

  /** Periodic sweep so idle users do not linger for the life of the process. */
  prune(now = Date.now()) {
    for (const [key, posts] of this.users) {
      const live = posts.filter(p => now - p.at <= this.windowMs);
      if (live.length) this.users.set(key, live);
      else this.users.delete(key);
    }
  }
}

export default {
  normaliseForSimilarity, shingles, similarity, CrossChannelTracker, DEFAULT_SIMILARITY,
};

/**
 * Content key for a post whose TEXT carries nothing — an image, a sticker, a bare embed.
 *
 * The text hash is null for these and the cluster tracker skips them, which is correct as far as it
 * goes: bucketing every wordless post under the SHA of the empty string made one member sharing
 * unrelated pictures in four channels look like a spammer. But skipping them outright removed the
 * only thing that noticed image-only cross-posting, and image-only cross-posting is what the scam
 * waves actually are — both August incidents in guild 961514092848382043 were the same four
 * attachments re-uploaded into seven and ten channels, and neither produced a single row.
 *
 * Keying on the attachments themselves restores the discrimination without a download: the SAME
 * file re-uploaded keeps its filename, byte size and dimensions, while two DIFFERENT pictures
 * almost never agree on all three. "The same image in ten channels" clusters; "ten different
 * pictures" does not. That is exactly the distinction the empty-string hash could not make.
 *
 * Cheap on purpose — this runs for every wordless message in 82 guilds, so perceptual hashing here
 * would mean downloading every image posted anywhere. core/image-fingerprint.js does that work, but
 * only against a short blocklist.
 *
 * @param {Iterable<{name?:string,size?:number,width?:number,height?:number}>} attachments
 * @returns {string|null} 16-hex-char key, or null when there is nothing to key on.
 */
export function attachmentKey(attachments) {
  const parts = [...(attachments || [])]
    .map(a => `${(a?.name || '').toLowerCase()}:${a?.size || 0}:${a?.width || 0}x${a?.height || 0}`)
    .sort();
  if (!parts.length) return null;
  return crypto.createHash('sha256').update(`att|${parts.join('|')}`).digest('hex').substring(0, 16);
}
