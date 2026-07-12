/*
 * Cat Bot emoji. Clean-room: no upstream emoji ids or artwork.
 *
 * Application emoji are owned by ONE application, so each bot that serves Cat Bot has its
 * own uploads — a custom bot cannot render the main bot's emoji snowflakes (that's the
 * silent-failure trap in feedback_silent_failures). Hence the map is keyed by bot id and
 * every lookup falls back to unicode, which always renders.
 */
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { EMOJI_FALLBACK } from './constants.js';

// botId -> Map<catType, "<:catbot_fine:123…>">
const custom = new Map();

// Deliberately distinct glyphs so tiers are legible at a glance in chat.
const UNICODE = Object.freeze({
  Fine: '🐱', Nice: '😺', Good: '😸', Rare: '😻', Wild: '🐯', Baby: '😼',
  Epic: '🦁', Sus: '🙀', Brave: '🦸', Rickroll: '🎵', Reverse: '🔄', Superior: '👑',
  Trash: '🗑️', Legendary: '🌟', Mythic: '🔮', '8bit': '👾', Corrupt: '💀',
  Professor: '🎓', Divine: '😇', Real: '📷', Ultimate: '💎', eGirl: '💅',
});

/** Load every bot's uploaded emoji. Call once at startup. */
export async function loadCustomEmoji() {
  custom.clear();
  try {
    const [rows] = await pool.execute('SELECT bot_id, cat_type, emoji_id, emoji_name, animated FROM catbot_emojis');
    for (const r of rows) {
      if (!custom.has(r.bot_id)) custom.set(r.bot_id, new Map());
      custom.get(r.bot_id).set(r.cat_type, `<${r.animated ? 'a' : ''}:${r.emoji_name}:${r.emoji_id}>`);
    }
    if (rows.length) logger.info(`[CatBot] loaded ${rows.length} custom emoji across ${custom.size} bot(s)`);
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') logger.warn(`[CatBot] emoji load failed: ${err.message}`);
  }
}

export function registerCustomEmoji(botId, type, markup) {
  if (!custom.has(botId)) custom.set(botId, new Map());
  custom.get(botId).set(type, markup);
}

export function hasCustomEmoji(botId) { return (custom.get(botId)?.size ?? 0) > 0; }
export function clearCustomEmoji() { custom.clear(); }

/**
 * Emoji markup for a cat type. Falls back to unicode when this specific bot has no
 * upload for it — never to another bot's snowflake, which would render as raw text.
 */
export function catEmoji(type, botId = null) {
  return (botId && custom.get(botId)?.get(type)) || UNICODE[type] || EMOJI_FALLBACK;
}

export { UNICODE as UNICODE_EMOJI };
