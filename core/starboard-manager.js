import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import configCache from '../utils/configCache.js';
import { themeColor } from './guild-theme.js';
import { logFeatureEvent, userLabel } from './feature-log.js';

/*
 * Starboards. A server can have up to MAX_BOARDS of them (starboard_config, one row per board,
 * keyed by `id` since migration 423; before that it was one row per guild). Each board has its own
 * channel, reaction emoji, threshold, channel rules and anti-abuse settings, and every post a board
 * makes is tracked in starboard_messages under that board's id.
 *
 * Board columns read here:
 *   channel_id, star_threshold, enabled, name
 *   emoji                   JSON array of accepted reactions (a bare string is still read as one)
 *   self_star               0 = an author's reaction on their own message is removed
 *   ignore_channels         JSON array: messages in these channels (or under these categories) never count
 *   watch_channels          JSON array: when set, only messages in these channels or categories count
 *   channel_thresholds      JSON object { channelId: threshold } overriding star_threshold
 *   ignore_bots             1 = messages posted by bots and webhooks are not starred
 *   min_age_minutes         a message younger than this is not posted yet (it is, on the next reaction after)
 *   max_age_minutes         a message older than this is not posted (0 = no limit)
 *   remove_below_threshold  1 = the post is taken down when the count falls below the threshold
 *   remove_on_delete        1 = the post is taken down when the original message is deleted
 * A message from an age-restricted (NSFW) channel is never posted to a board whose channel is not.
 */

export const MAX_BOARDS = 10;
export const MAX_EMOJI = 20;
export const MAX_THRESHOLD = 100;
export const MAX_CHANNEL_LIST = 100;
export const MAX_THRESHOLD_OVERRIDES = 50;
export const NAME_MAX = 100;
/** Choices offered on the dashboard, in minutes (0 = no limit). */
export const MIN_AGE_CHOICES = [0, 1, 5, 10, 30, 60];
export const MAX_AGE_CHOICES = [0, 60, 360, 720, 1440, 4320, 10080, 20160, 43200];

const SNOWFLAKE = /^\d{17,20}$/;
const CUSTOM_EMOJI = /^<(a?):(\w{2,32}):(\d{17,20})>$/;
const NAMED_EMOJI = /^:(\w{2,32}):$/;
const EMOJI_GRAPHEME = /\p{Extended_Pictographic}|\p{Regional_Indicator}|^[#*0-9]️?⃣$/u;

/** A JSON array column as a list of strings ([] for null or junk). */
export function parseJsonList(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

/** channel_thresholds as a plain { channelId: number } object. */
export function parseThresholds(raw) {
  if (!raw) return {};
  let v = raw;
  if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch { return {}; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [k, n] of Object.entries(v)) {
    const num = Number(n);
    if (SNOWFLAKE.test(k) && Number.isInteger(num) && num >= 1) out[k] = num;
  }
  return out;
}

/**
 * The configured reaction(s) of a board.
 *
 * One server chose seven emoji, not one (her own :Cheers:, :Ellie:, :Kirby_Hello:, :Rift:, :OG:,
 * :twitch: and a plain star). Any of them counts and their counts ADD UP: three people reacting
 * with three different emoji is still three people saying the same thing about the same post.
 * Stored as a JSON array; a bare string still works for rows set up with a single emoji.
 */
export function emojiList(board) {
  const raw = board?.emoji;
  if (!raw) return ['⭐'];
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try { const list = JSON.parse(raw); if (Array.isArray(list) && list.length) return list.map(String); } catch { /* fall through */ }
  }
  return [String(raw)];
}

/** Every board of a guild, oldest first (the first one is what single-board callers see). */
export async function listBoards(guildId) {
  const [rows] = await pool.execute('SELECT * FROM starboard_config WHERE guild_id = ? ORDER BY id ASC', [guildId]);
  return rows;
}

function bool(v) {
  if (Array.isArray(v)) v = v[v.length - 1];
  return v === true || v === 1 || v === '1' || v === 'on' || v === 'true';
}

function toArray(v) {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.flatMap(toArray);
  if (typeof v === 'string' && v.trim().startsWith('[')) { try { return toArray(JSON.parse(v)); } catch { /* fall through */ } }
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Turn the emoji field into a list of reaction strings. Accepts unicode emoji (with or without
 * spaces or commas between them), custom emoji as <:name:id> / <a:name:id>, and :name: for an
 * emoji of this server. Returns { list } or { error }.
 */
export function parseEmojiInput(raw, guild) {
  const items = Array.isArray(raw) ? raw.map(String) : [String(raw ?? '')];
  const out = [];
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  for (const item of items) {
    const tokens = item.match(/<a?:\w{2,32}:\d{17,20}>|:\w{2,32}:|[^\s,]+/g) || [];
    for (const token of tokens) {
      if (CUSTOM_EMOJI.test(token)) { out.push(token); continue; }
      const named = token.match(NAMED_EMOJI);
      if (named) {
        const found = guild?.emojis?.cache?.find?.((e) => e.name === named[1]);
        if (!found) return { error: `There is no server emoji called :${named[1]}:.` };
        out.push(found.toString());
        continue;
      }
      // A run of unicode emoji, possibly written together.
      for (const { segment } of segmenter.segment(token)) {
        if (!EMOJI_GRAPHEME.test(segment)) return { error: `"${token.slice(0, 40)}" is not an emoji.` };
        out.push(segment);
      }
    }
  }
  const list = [...new Set(out)];
  if (list.length > MAX_EMOJI) return { error: `A starboard can count at most ${MAX_EMOJI} different emoji.` };
  return { list: list.length ? list : ['⭐'] };
}

/**
 * Validate a board coming from the dashboard (or any other caller) against the guild it is for.
 * `input` uses the column names (channel_id, star_threshold, emoji, ...) and accepts form values
 * (strings, "on", repeated fields as arrays). Returns { ok: true, board } or { ok: false, error }.
 */
export function validateBoardInput(input, guild) {
  if (!guild) return { ok: false, error: 'The bot cannot see this server right now. Try again in a minute.' };
  const channels = guild.channels.cache;
  const isPostable = (ch) => ch && typeof ch.isTextBased === 'function' && ch.isTextBased() && !(ch.isThread?.()) && ch.type !== 2 && ch.type !== 13;
  const isWatchable = (ch) => ch && (ch.type === 4 /* category */ || ch.type === 15 /* forum */ || ch.type === 16 /* media */ || (typeof ch.isTextBased === 'function' && ch.isTextBased()));

  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
  if (/[<>@]/.test(name)) return { ok: false, error: 'The name must be plain text (no <, > or @).' };
  if ([...name].length > NAME_MAX) return { ok: false, error: `The name can be at most ${NAME_MAX} characters.` };

  const channelId = String(input.channel_id ?? '').trim();
  if (!SNOWFLAKE.test(channelId) || !isPostable(channels.get(channelId))) {
    return { ok: false, error: 'Choose a text channel in this server for the starboard.' };
  }

  const threshold = Number.parseInt(input.star_threshold, 10);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > MAX_THRESHOLD) {
    return { ok: false, error: `Reactions needed must be a whole number from 1 to ${MAX_THRESHOLD}.` };
  }

  const emoji = parseEmojiInput(input.emoji, guild);
  if (emoji.error) return { ok: false, error: emoji.error };

  const channelList = (raw, what) => {
    const ids = [...new Set(toArray(raw))];
    if (ids.length > MAX_CHANNEL_LIST) return { error: `${what}: at most ${MAX_CHANNEL_LIST} channels.` };
    for (const id of ids) {
      if (!SNOWFLAKE.test(id) || !isWatchable(channels.get(id))) return { error: `${what}: one of the channels is not in this server.` };
    }
    return { ids };
  };
  const watch = channelList(input.watch_channels, 'Only count messages in');
  if (watch.error) return { ok: false, error: watch.error };
  const ignore = channelList(input.ignore_channels, 'Ignored channels');
  if (ignore.error) return { ok: false, error: ignore.error };

  // Per-channel thresholds: either an object, or parallel lists (threshold_channel[], threshold_value[]).
  let pairs = [];
  if (input.channel_thresholds && typeof input.channel_thresholds === 'object' && !Array.isArray(input.channel_thresholds)) {
    pairs = Object.entries(input.channel_thresholds);
  } else if (typeof input.channel_thresholds === 'string' && input.channel_thresholds.trim().startsWith('{')) {
    try { pairs = Object.entries(JSON.parse(input.channel_thresholds)); } catch { return { ok: false, error: 'Channel thresholds are not valid.' }; }
  } else {
    const cs = Array.isArray(input.threshold_channel) ? input.threshold_channel : (input.threshold_channel ? [input.threshold_channel] : []);
    const vs = Array.isArray(input.threshold_value) ? input.threshold_value : (input.threshold_value ? [input.threshold_value] : []);
    pairs = cs.map((c, i) => [c, vs[i]]);
  }
  const overrides = {};
  for (const [cRaw, vRaw] of pairs) {
    const c = String(cRaw ?? '').trim();
    if (!c && (vRaw === '' || vRaw === undefined || vRaw === null)) continue; // an empty row left on the form
    if (!SNOWFLAKE.test(c) || !isWatchable(channels.get(c))) return { ok: false, error: 'Channel thresholds: choose a channel for each row.' };
    const n = Number.parseInt(vRaw, 10);
    if (!Number.isInteger(n) || n < 1 || n > MAX_THRESHOLD) return { ok: false, error: `Channel thresholds must be whole numbers from 1 to ${MAX_THRESHOLD}.` };
    overrides[c] = n;
  }
  if (Object.keys(overrides).length > MAX_THRESHOLD_OVERRIDES) return { ok: false, error: `At most ${MAX_THRESHOLD_OVERRIDES} channel thresholds.` };

  const minutes = (raw, max) => {
    const n = Number.parseInt(raw ?? 0, 10);
    return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : 0;
  };
  const minAge = minutes(input.min_age_minutes, 1440);
  const maxAge = minutes(input.max_age_minutes, 43200);
  if (maxAge > 0 && minAge >= maxAge) return { ok: false, error: 'The maximum message age must be longer than the minimum.' };

  return {
    ok: true,
    board: {
      name: name || null,
      enabled: bool(input.enabled) ? 1 : 0,
      channel_id: channelId,
      star_threshold: threshold,
      emoji: JSON.stringify(emoji.list),
      self_star: bool(input.self_star) ? 1 : 0,
      ignore_bots: bool(input.ignore_bots) ? 1 : 0,
      watch_channels: watch.ids.length ? JSON.stringify(watch.ids) : null,
      ignore_channels: ignore.ids.length ? JSON.stringify(ignore.ids) : null,
      channel_thresholds: Object.keys(overrides).length ? JSON.stringify(overrides) : null,
      min_age_minutes: minAge,
      max_age_minutes: maxAge,
      remove_below_threshold: bool(input.remove_below_threshold) ? 1 : 0,
      remove_on_delete: bool(input.remove_on_delete) ? 1 : 0,
    },
  };
}

const BOARD_COLUMNS = ['name', 'enabled', 'channel_id', 'star_threshold', 'emoji', 'self_star', 'ignore_bots',
  'watch_channels', 'ignore_channels', 'channel_thresholds', 'min_age_minutes', 'max_age_minutes',
  'remove_below_threshold', 'remove_on_delete'];

/**
 * Create (boardId null) or update a board from validateBoardInput's output.
 * Returns { ok: true, id } or { ok: false, error }.
 */
export async function saveBoard(guildId, boardId, board) {
  const cols = BOARD_COLUMNS.filter((c) => board[c] !== undefined);
  if (boardId) {
    const [res] = await pool.execute(
      `UPDATE starboard_config SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ? AND guild_id = ?`,
      [...cols.map((c) => board[c]), boardId, guildId]
    );
    configCache.invalidate('starboard_boards', guildId);
    if (!res.affectedRows) return { ok: false, error: 'That starboard no longer exists.' };
    return { ok: true, id: Number(boardId) };
  }
  const [[{ n }]] = await pool.execute('SELECT COUNT(*) AS n FROM starboard_config WHERE guild_id = ?', [guildId]);
  if (n >= MAX_BOARDS) return { ok: false, error: `A server can have at most ${MAX_BOARDS} starboards.` };
  const [res] = await pool.execute(
    `INSERT INTO starboard_config (guild_id, ${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
    [guildId, ...cols.map((c) => board[c])]
  );
  configCache.invalidate('starboard_boards', guildId);
  return { ok: true, id: res.insertId };
}

/** Delete a board and forget its posts (the posts already in Discord stay). */
export async function deleteBoard(guildId, boardId) {
  const [res] = await pool.execute('DELETE FROM starboard_config WHERE id = ? AND guild_id = ?', [boardId, guildId]);
  if (res.affectedRows) {
    await pool.execute('DELETE FROM starboard_messages WHERE guild_id = ? AND board_id = ?', [guildId, boardId]);
  }
  configCache.invalidate('starboard_boards', guildId);
  return res.affectedRows > 0;
}

/** The channel ids a message counts as being in: itself, its parent (thread to channel, channel to category) and that one's parent. */
function channelChain(channel) {
  return [channel?.id, channel?.parentId, channel?.parent?.parentId].filter(Boolean);
}

function isNsfwChannel(channel) {
  if (!channel) return false;
  if (typeof channel.isThread === 'function' && channel.isThread()) return !!channel.parent?.nsfw;
  return !!channel.nsfw;
}

/** The reactions a message in `channel` needs on `board` (a per-channel override wins). */
export function thresholdFor(board, channel) {
  const overrides = parseThresholds(board.channel_thresholds);
  for (const id of channelChain(channel)) {
    if (overrides[id]) return overrides[id];
  }
  return Number(board.star_threshold) || 3;
}

/**
 * Starboard Manager - Highlights popular messages with star reactions
 */
class StarboardManager {
  constructor(client) {
    this.client = client;
    // Per-message queue: several stars landing at once must not each see "not on the board yet"
    // and each post their own copy. Events for the same message run one after another.
    this.messageQueues = new Map();
    logger.info('[StarboardManager] Starboard manager initialized');
  }

  /** Run fn after any in-flight starboard work for the same message has finished. */
  async serializeByMessage(messageId, fn) {
    const prev = this.messageQueues.get(messageId) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.messageQueues.set(messageId, tail);
    try {
      return await run;
    } finally {
      if (this.messageQueues.get(messageId) === tail) this.messageQueues.delete(messageId);
    }
  }

  /** Every board of a guild (cached; the dashboard's saves clear the cache). */
  async getBoards(guildId) {
    try {
      return await configCache.get('starboard_boards', guildId, () => listBoards(guildId));
    } catch (error) {
      logger.error(`[StarboardManager] Failed to get boards: ${error.message}`, { guildId });
      return [];
    }
  }

  /** The guild's first board, for callers that know only one (/community starboard stats|top). */
  async getConfig(guildId) {
    const boards = await this.getBoards(guildId);
    return boards[0] || null;
  }

  /**
   * /community starboard setup: update the board already posting to that channel, or the only
   * board when there is one (the single-board behaviour this command always had), or add a board.
   */
  async setConfig(guildId, channelId, threshold = 3, emoji = '⭐', enabled = true) {
    try {
      const boards = await listBoards(guildId);
      const target = boards.find((b) => b.channel_id === channelId) || (boards.length === 1 ? boards[0] : null);
      const parsed = parseEmojiInput(emoji, null);
      const fields = {
        channel_id: channelId,
        star_threshold: Math.min(Math.max(Number.parseInt(threshold, 10) || 3, 1), MAX_THRESHOLD),
        emoji: JSON.stringify(parsed.list || [String(emoji || '⭐')]),
        enabled: enabled ? 1 : 0,
      };
      const result = await saveBoard(guildId, target ? target.id : null, fields);
      if (!result.ok) {
        logger.warn(`[StarboardManager] setConfig refused: ${result.error}`, { guildId });
        return false;
      }
      logger.info(`[StarboardManager] Updated config for guild ${guildId}`, { boardId: result.id });
      return true;
    } catch (error) {
      logger.error(`[StarboardManager] Failed to set config: ${error.message}`, { guildId });
      return false;
    }
  }

  /** Disable every starboard of a guild. */
  async disableStarboard(guildId) {
    try {
      await pool.execute('UPDATE starboard_config SET enabled = 0 WHERE guild_id = ?', [guildId]);
      configCache.invalidate('starboard_boards', guildId);
      logger.info(`[StarboardManager] Disabled starboard for guild ${guildId}`);
      return true;
    } catch (error) {
      logger.error(`[StarboardManager] Failed to disable starboard: ${error.message}`, { guildId });
      return false;
    }
  }

  emojiList(board) { return emojiList(board); }

  /** Does this reaction count towards the board? */
  matchesEmoji(emoji, board) {
    const list = emojiList(board);
    return list.some((e) => e === emoji.name || e === emoji.toString() || e === String(emoji.id));
  }

  /** The label shown on the board post: the first configured emoji. */
  displayEmoji(board) {
    return emojiList(board)[0];
  }

  /**
   * The number of reactions on a message that count for a board, right now.
   *
   * We do NOT trust `reaction.count` from the gateway event: on a remove it can arrive as `null`
   * (a partial/uncached reaction) or lag a beat behind, which is exactly why a message sitting at
   * the threshold wouldn't come off the board when the star that put it there was pulled. The
   * caller re-fetches the message first; we sum every accepted emoji off that (several accepted
   * emoji add up: the interesting number is how many PEOPLE reacted, not which glyph won), and only
   * fall back to the event's number if the fetch gave us nothing usable.
   */
  liveStarCount(message, reaction, board) {
    let total = 0, sawAny = false;
    for (const r of message.reactions.cache.values()) {
      if (!this.matchesEmoji(r.emoji, board)) continue;
      if (Number.isFinite(r.count)) { total += r.count; sawAny = true; }
    }
    if (sawAny) return total;
    if (reaction && Number.isFinite(reaction.count) && this.matchesEmoji(reaction.emoji, board)) return reaction.count;
    return 0;
  }

  /** Channel rules: not a starboard channel itself, not ignored, and inside the watched channels when there are any. */
  channelAllowed(message, board, allBoards) {
    if (allBoards.some((b) => b.channel_id === message.channel.id)) return false;
    const chain = channelChain(message.channel);
    const ignore = parseJsonList(board.ignore_channels);
    if (ignore.some((id) => chain.includes(id))) return false;
    const watch = parseJsonList(board.watch_channels);
    if (watch.length && !watch.some((id) => chain.includes(id))) return false;
    return true;
  }

  /**
   * Whether a message may be posted to a board now (the checks that only matter for a new post).
   * Returns null when it may, or the reason it may not (for the debug log).
   */
  postBlocker(message, board) {
    if (board.ignore_bots && (message.author?.bot || message.webhookId)) return 'bot message';
    const ageMin = (Date.now() - message.createdTimestamp) / 60000;
    const minAge = Number(board.min_age_minutes) || 0;
    const maxAge = Number(board.max_age_minutes) || 0;
    if (minAge > 0 && ageMin < minAge) return 'younger than the minimum age';
    if (maxAge > 0 && ageMin > maxAge) return 'older than the maximum age';
    const boardChannel = message.guild.channels.cache.get(board.channel_id);
    if (isNsfwChannel(message.channel) && !isNsfwChannel(boardChannel)) return 'NSFW channel, board channel is not';
    return null;
  }

  /** Bring one board's post for a message in line with its current reaction count. */
  async evaluateBoard(message, reaction, board, { allowCreate }) {
    const starCount = this.liveStarCount(message, reaction, board);
    const threshold = thresholdFor(board, message.channel);
    const [existing] = await pool.execute(
      'SELECT * FROM starboard_messages WHERE board_id = ? AND original_message_id = ?',
      [board.id, message.id]
    );
    if (existing.length > 0) {
      if (starCount >= threshold || !board.remove_below_threshold) {
        await this.updateStarboardMessage(message, existing[0], starCount, board);
      } else {
        await this.removeStarboardMessage(existing[0], board, 'Reactions fell below the threshold');
      }
      return;
    }
    if (!allowCreate || starCount < threshold) return;
    const blocker = this.postBlocker(message, board);
    if (blocker) {
      logger.debug(`[StarboardManager] Not posting ${message.id} to board ${board.id}: ${blocker}`);
      return;
    }
    await this.createStarboardMessage(message, starCount, board);
  }

  /**
   * Handle when a star reaction is added
   */
  async handleReactionAdd(reaction, user) {
    try {
      if (user.bot) return;
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();

      let message = reaction.message;
      if (!message.guild) return;

      const allBoards = await this.getBoards(message.guild.id);
      const boards = allBoards.filter((b) => b.enabled && this.matchesEmoji(reaction.emoji, b) && this.channelAllowed(message, b, allBoards));
      if (!boards.length) return;

      // Self-stars: a board that does not allow them takes the author's reaction back off.
      if (message.author?.id === user.id && boards.some((b) => !b.self_star)) {
        await reaction.users.remove(user.id).catch(() => {});
        return;
      }

      await this.serializeByMessage(message.id, async () => {
        // Re-fetch for an accurate, up-to-the-moment count before we decide anything.
        message = await message.fetch().catch(() => message);
        for (const board of boards) {
          await this.evaluateBoard(message, reaction, board, { allowCreate: true });
        }
      });
    } catch (error) {
      logger.error(`[StarboardManager] Reaction add error: ${error.message}`);
    }
  }

  /**
   * Handle when a star reaction is removed
   */
  async handleReactionRemove(reaction, user) {
    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();

      let message = reaction.message;
      if (!message.guild) return;

      const boards = (await this.getBoards(message.guild.id)).filter((b) => b.enabled && this.matchesEmoji(reaction.emoji, b));
      if (!boards.length) return;

      await this.serializeByMessage(message.id, async () => {
        // Re-fetch so the count reflects the reaction that was just removed, not the stale event payload.
        message = await message.fetch().catch(() => message);
        for (const board of boards) {
          await this.evaluateBoard(message, reaction, board, { allowCreate: false });
        }
      });
    } catch (error) {
      logger.error(`[StarboardManager] Reaction remove error: ${error.message}`);
    }
  }

  /**
   * Create a new starboard message
   */
  async createStarboardMessage(message, starCount, board) {
    try {
      const starboardChannel = await message.guild.channels.fetch(board.channel_id).catch(() => null);
      if (!starboardChannel || !starboardChannel.isTextBased()) return;

      const embed = new EmbedBuilder()
        .setColor(themeColor(message.guild?.id, 'warning'))
        .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
        .setDescription(message.content || '*No text content*')
        .addFields({ name: 'Source', value: `[Jump to message](${message.url}) in ${message.channel}` })
        .setTimestamp(message.createdAt);

      // Add first image attachment if present
      const attachment = message.attachments.find(att => att.contentType?.startsWith('image/'));
      if (attachment) {
        embed.setImage(attachment.url);
      }

      const starboardMessage = await starboardChannel.send({
        content: `${this.displayEmoji(board)} **${starCount}** ${message.channel}`,
        embeds: [embed],
        allowedMentions: { parse: [] },
      });

      try {
        await pool.execute(
          `INSERT INTO starboard_messages (guild_id, board_id, original_message_id, original_channel_id, starboard_message_id, star_count)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [message.guild.id, board.id, message.id, message.channel.id, starboardMessage.id, starCount]
        );
      } catch (dbError) {
        // This row is the only thing that says "already on the board". Without it the next star
        // finds nothing and posts the message AGAIN. Take the post back down instead of leaving an
        // untracked copy behind.
        logger.error(`[StarboardManager] Failed to record starboard post, removing it to avoid duplicates: ${dbError.message}`, {
          guildId: message.guild.id, messageId: message.id, starboardMessageId: starboardMessage.id, boardId: board.id
        });
        await starboardMessage.delete().catch((delError) => {
          logger.warn(`[StarboardManager] Could not remove unrecorded starboard post: ${delError.message}`, {
            guildId: message.guild.id, starboardMessageId: starboardMessage.id
          });
        });
        return;
      }

      logger.info(`[StarboardManager] Created starboard entry for message ${message.id}`, { guildId: message.guild.id, boardId: board.id, starCount });
      void logFeatureEvent(() => (message.guild), 'starboard.posted', () => ({
        title: '⭐ Message Starred',
        description: message.content ? message.content.slice(0, 300) : null,
        fields: [
          ['Author', userLabel(message.author)], ['Channel', `<#${message.channel.id}>`], ['Stars', starCount],
          ['Starboard', board.name || `<#${board.channel_id}>`],
          ['Links', `[Original](${message.url}) · [Starboard](${starboardMessage.url})`],
        ],
        url: message.url,
        avoidChannelIds: [board.channel_id],
      }));
    } catch (error) {
      logger.error(`[StarboardManager] Failed to create starboard message: ${error.message}`);
    }
  }

  /**
   * Update existing starboard message
   */
  async updateStarboardMessage(message, existing, starCount, board) {
    try {
      const starboardChannel = await message.guild.channels.fetch(board.channel_id).catch(() => null);
      if (!starboardChannel || !starboardChannel.isTextBased()) return;

      const starboardMessage = await starboardChannel.messages.fetch(existing.starboard_message_id).catch(() => null);
      if (!starboardMessage) {
        // Starboard message was deleted, remove from database
        await pool.execute('DELETE FROM starboard_messages WHERE id = ?', [existing.id]);
        return;
      }

      if (Number(existing.star_count) === starCount) return;
      await starboardMessage.edit({
        content: `${this.displayEmoji(board)} **${starCount}** ${message.channel}`,
        allowedMentions: { parse: [] },
      });

      await pool.execute(
        'UPDATE starboard_messages SET star_count = ? WHERE id = ?',
        [starCount, existing.id]
      );

      logger.debug(`[StarboardManager] Updated starboard message for ${message.id}`, { starCount, boardId: board.id });
    } catch (error) {
      logger.error(`[StarboardManager] Failed to update starboard message: ${error.message}`);
    }
  }

  /**
   * Remove message from starboard
   * @param {string|null} [reason=null] why, for the server log
   */
  async removeStarboardMessage(existing, board, reason = null) {
    try {
      const guild = await this.client.guilds.fetch(existing.guild_id).catch(() => null);
      if (!guild) return;

      const starboardChannel = await guild.channels.fetch(board.channel_id).catch(() => null);
      if (starboardChannel && starboardChannel.isTextBased()) {
        const starboardMessage = await starboardChannel.messages.fetch(existing.starboard_message_id).catch(() => null);
        if (starboardMessage) {
          await starboardMessage.delete();
        }
      }

      await pool.execute('DELETE FROM starboard_messages WHERE id = ?', [existing.id]);
      logger.info(`[StarboardManager] Removed starboard message for ${existing.original_message_id}`, { boardId: board.id });
      void logFeatureEvent(() => (guild), 'starboard.removed', () => ({
        title: '💫 Removed from Starboard',
        fields: [
          ['Reason', reason], ['Stars', existing.star_count],
          ['Starboard', board.name || `<#${board.channel_id}>`],
          ['Channel', existing.original_channel_id ? `<#${existing.original_channel_id}>` : null],
          ['Original', existing.original_channel_id
            ? `[Jump to message](https://discord.com/channels/${existing.guild_id}/${existing.original_channel_id}/${existing.original_message_id})`
            : existing.original_message_id],
        ],
        avoidChannelIds: [board.channel_id],
      }));
    } catch (error) {
      logger.error(`[StarboardManager] Failed to remove starboard message: ${error.message}`);
    }
  }

  /**
   * Handle when original message is deleted: each board that has it decides by remove_on_delete.
   */
  async handleMessageDelete(message) {
    try {
      if (!message.guild) return;

      const [rows] = await pool.execute(
        'SELECT * FROM starboard_messages WHERE guild_id = ? AND original_message_id = ?',
        [message.guild.id, message.id]
      );
      if (!rows.length) return;

      const boards = await this.getBoards(message.guild.id);
      for (const row of rows) {
        const board = boards.find((b) => Number(b.id) === Number(row.board_id));
        if (!board) {
          await pool.execute('DELETE FROM starboard_messages WHERE id = ?', [row.id]);
          continue;
        }
        if (board.remove_on_delete) {
          await this.removeStarboardMessage(row, board, 'Original message deleted');
        }
      }
    } catch (error) {
      logger.error(`[StarboardManager] Message delete error: ${error.message}`);
    }
  }

  /**
   * Get starboard statistics
   */
  async getStats(guildId) {
    try {
      const [stats] = await pool.execute(
        `SELECT
           COUNT(*) as total_starred,
           SUM(star_count) as total_stars,
           AVG(star_count) as avg_stars,
           MAX(star_count) as max_stars
         FROM starboard_messages
         WHERE guild_id = ?`,
        [guildId]
      );
      return stats[0];
    } catch (error) {
      logger.error(`[StarboardManager] Stats error: ${error.message}`, { guildId });
      return null;
    }
  }

  /**
   * Get top starred messages
   */
  async getTopMessages(guildId, limit = 10) {
    try {
      const [messages] = await pool.execute(
        `SELECT * FROM starboard_messages
         WHERE guild_id = ?
         ORDER BY star_count DESC
         LIMIT ?`,
        [guildId, limit]
      );
      return messages;
    } catch (error) {
      logger.error(`[StarboardManager] Top messages error: ${error.message}`, { guildId });
      return [];
    }
  }
}

export default StarboardManager;
