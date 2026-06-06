/**
 * Word-game session manager: in-memory channel->session registry backed by
 * word_game_sessions for restart recovery, plus per-channel bindings
 * (word_game_channels) and stats (word_game_stats). The messageCreate hook
 * calls handleWordGameMessage(); engine routing is registered per game type.
 *
 * Dependency direction is one-way: game runtimes import THIS module to call
 * registerEngine()/saveState()/bumpStats(); this module never imports them.
 * Boot (index.js) imports the runtime modules so they self-register — that
 * avoids a circular import (manager <-> runtime) and the TDZ it would cause.
 */
import { randomUUID } from 'node:crypto';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const sessionsByChannel = new Map(); // channelId -> { id, guildId, channelId, gameType, mode, status, hostUserId, state }
const engines = new Map();           // gameType -> async (message, session) => boolean (consumed)

export function registerEngine(gameType, handler) { engines.set(gameType, handler); }
export function getSessionByChannel(channelId) { return sessionsByChannel.get(channelId) || null; }

export async function createSession({ guildId, channelId, gameType, mode, hostUserId, state }) {
  const id = randomUUID();
  const session = { id, guildId, channelId, gameType, mode, status: 'active', hostUserId: hostUserId || null, state };
  sessionsByChannel.set(channelId, session);
  await pool.execute(
    `INSERT INTO word_game_sessions (id, guild_id, channel_id, game_type, mode, status, host_user_id, state_json)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [id, guildId, channelId, gameType, mode, session.hostUserId, JSON.stringify(state)]
  );
  return session;
}

export async function saveState(session) {
  await pool.execute('UPDATE word_game_sessions SET state_json = ? WHERE id = ?',
    [JSON.stringify(session.state), session.id]);
}

export async function endSession(session, status = 'ended') {
  session.status = status;
  if (sessionsByChannel.get(session.channelId)?.id === session.id) sessionsByChannel.delete(session.channelId);
  await pool.execute('UPDATE word_game_sessions SET status = ?, ended_at = NOW() WHERE id = ?', [status, session.id]);
}

export async function bindChannel({ guildId, channelId, gameType, createdBy, config }) {
  await pool.execute(
    `INSERT INTO word_game_channels (guild_id, channel_id, game_type, enabled, config_json, created_by)
     VALUES (?, ?, ?, 1, ?, ?)
     ON DUPLICATE KEY UPDATE game_type = VALUES(game_type), enabled = 1, config_json = VALUES(config_json)`,
    [guildId, channelId, gameType, config ? JSON.stringify(config) : null, createdBy || null]
  );
}

export async function unbindChannel(guildId, channelId) {
  await pool.execute('DELETE FROM word_game_channels WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);
  const s = sessionsByChannel.get(channelId);
  if (s) await endSession(s, 'ended');
}

export async function bumpStats(guildId, userId, gameType, { words = 0, played = 0, wins = 0, bestScore = null, streak = null } = {}) {
  await pool.execute(
    `INSERT INTO word_game_stats (guild_id, user_id, game_type, words_contributed, games_played, wins, best_score, current_streak, best_streak)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       words_contributed = words_contributed + VALUES(words_contributed),
       games_played      = games_played + VALUES(games_played),
       wins              = wins + VALUES(wins),
       best_score        = GREATEST(best_score, VALUES(best_score)),
       current_streak    = VALUES(current_streak),
       best_streak       = GREATEST(best_streak, VALUES(current_streak))`,
    [guildId, userId, gameType, words, played, wins, bestScore ?? 0, streak ?? 0, streak ?? 0]
  );
}

export async function getStats(guildId, userId, gameType) {
  const [rows] = await pool.execute(
    'SELECT * FROM word_game_stats WHERE guild_id = ? AND user_id = ? AND game_type = ?',
    [guildId, userId, gameType]);
  return rows[0] || null;
}

export async function getLeaderboard(guildId, gameType, limit = 10) {
  const [rows] = await pool.execute(
    'SELECT user_id, best_score, words_contributed, wins FROM word_game_stats WHERE guild_id = ? AND game_type = ? ORDER BY best_score DESC, words_contributed DESC LIMIT ?',
    [guildId, gameType, limit]);
  return rows;
}

export async function rehydrateWordGames() {
  const [rows] = await pool.execute("SELECT * FROM word_game_sessions WHERE status = 'active'");
  let n = 0;
  for (const r of rows) {
    let state; try { state = JSON.parse(r.state_json); } catch { state = {}; }
    sessionsByChannel.set(r.channel_id, {
      id: r.id, guildId: r.guild_id, channelId: r.channel_id, gameType: r.game_type,
      mode: r.mode, status: r.status, hostUserId: r.host_user_id, state,
    });
    n++;
  }
  logger.info('[WordGames] rehydrated active sessions', { count: n });
  return n;
}

/** messageCreate hook. Returns true if the message was consumed by a word game. */
export async function handleWordGameMessage(message) {
  try {
    if (message.author?.bot || !message.guild) return false;
    const session = sessionsByChannel.get(message.channel.id);
    if (!session || session.status !== 'active') return false;
    const engine = engines.get(session.gameType);
    if (!engine) return false;
    return await engine(message, session);
  } catch (err) {
    logger.error('[WordGames] message handler error', { error: err.message });
    return false;
  }
}
