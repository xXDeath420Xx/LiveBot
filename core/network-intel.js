/*
 * Network Intel — cross-guild member activity graph.
 *
 * The join-gate scored single-guild signals (name, age, avatar) and lost the modern
 * commission-spammer: real-age account, blank profile, zero posts, straight to DMs. That attack
 * is only visible when you look across SERVERS. CertiFried's reach is the sensor array.
 *
 * This module writes the graph from passive gateway events — no polling, no explicit API calls:
 *
 *   recordNetworkJoin(member)        on GUILD_MEMBER_ADD        bumps guilds_joined + currently_in
 *   recordNetworkJoinSnapshot(mem)   same event, after recordJoin freezes join-time primary evidence
 *   recordNetworkLeave(userId)       on GUILD_MEMBER_REMOVE     decrements currently_in
 *   recordNetworkBan(userId)         on GUILD_BAN_ADD           bumps guilds_banned_from
 *   recordNetworkMessage(message)    on MESSAGE_CREATE          sets last_message_at (debounced)
 *   getNetworkActivity(userId)       read side; join-gate uses this (Wave 367)
 *
 * Every writer is a single upsert; every reader is a single keyed row read. Debounce is in-memory
 * and bounded so a message-heavy guild cannot blow up the hot path.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const DISCORD_EPOCH = 1420070400000;

function snowflakeToDate(id) {
  try {
    return new Date(Number(BigInt(id) >> 22n) + DISCORD_EPOCH);
  } catch { return null; }
}

// We don't need ms-precision on last_message_at — the join-gate uses it as a boolean
// ("has this user ever posted anywhere?") and a rough recency comparator. One DB write per
// user per hour keeps the hot path cheap on a high-traffic guild.
const messageTouchCache = new Map();
const MESSAGE_DEBOUNCE_MS = 60 * 60 * 1000;
const CACHE_MAX = 50_000;

function touchCache(userId) {
  const now = Date.now();
  const last = messageTouchCache.get(userId) || 0;
  if (now - last < MESSAGE_DEBOUNCE_MS) return false;
  messageTouchCache.set(userId, now);
  if (messageTouchCache.size > CACHE_MAX) {
    const drop = [...messageTouchCache.keys()].slice(0, Math.floor(CACHE_MAX / 10));
    for (const k of drop) messageTouchCache.delete(k);
  }
  return true;
}

export async function recordNetworkJoin(member) {
  if (!member?.id || member.user?.bot) return;
  try {
    const createdAt = snowflakeToDate(member.id);
    const flags = member.user?.flags?.bitfield ?? null;
    const username = (member.user?.username || '').slice(0, 100);
    await pool.query(
      `INSERT INTO network_member_activity
         (user_id, account_created_at, public_flags, last_username,
          guilds_joined, guilds_currently_in, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, 1, 1, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         guilds_joined = guilds_joined + 1,
         guilds_currently_in = guilds_currently_in + 1,
         public_flags = COALESCE(VALUES(public_flags), public_flags),
         last_username = VALUES(last_username),
         last_seen_at = NOW()`,
      [member.id, createdAt, flags, username]
    );
  } catch (e) {
    logger.warn(`[NetworkIntel] recordNetworkJoin failed for ${member.id}: ${e.message}`);
  }
}

// Writes the frozen join-time snapshot into the EXISTING member_join_history row that
// core/join-history.js recordJoin() just INSERT IGNORE'd. Separate from recordNetworkJoin so the
// per-user network row and the per-guild history row stay decoupled.
export async function recordNetworkJoinSnapshot(member) {
  if (!member?.id || !member.guild?.id) return;
  try {
    const createdAt = snowflakeToDate(member.id);
    const ageHours = createdAt
      ? Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 3_600_000))
      : null;
    const flags = member.user?.flags?.bitfield ?? null;
    const hasCustomAvatar = member.user?.avatar ? 1 : 0;
    const hasBanner = member.user?.banner ? 1 : 0;
    const username = (member.user?.username || '').slice(0, 100);
    const globalName = (member.user?.globalName || '').slice(0, 100) || null;
    const wasBot = member.user?.bot ? 1 : 0;
    await pool.query(
      `UPDATE member_join_history
          SET account_age_hours = ?,
              public_flags_at_join = ?,
              has_custom_avatar = ?,
              has_banner = ?,
              username_at_join = ?,
              global_name_at_join = ?,
              was_bot_user = ?
        WHERE guild_id = ? AND user_id = ? AND account_age_hours IS NULL`,
      [ageHours, flags, hasCustomAvatar, hasBanner, username, globalName, wasBot,
       member.guild.id, member.id]
    );
  } catch (e) {
    logger.warn(`[NetworkIntel] recordNetworkJoinSnapshot failed: ${e.message}`);
  }
}

export async function recordNetworkLeave(userId) {
  if (!userId) return;
  try {
    await pool.query(
      `UPDATE network_member_activity
          SET guilds_currently_in = GREATEST(0, guilds_currently_in - 1),
              last_seen_at = NOW()
        WHERE user_id = ?`,
      [userId]
    );
  } catch (e) {
    logger.warn(`[NetworkIntel] recordNetworkLeave failed for ${userId}: ${e.message}`);
  }
}

export async function recordNetworkBan(userId) {
  if (!userId) return;
  try {
    await pool.query(
      `INSERT INTO network_member_activity
         (user_id, guilds_banned_from, first_seen_at, last_seen_at)
       VALUES (?, 1, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         guilds_banned_from = guilds_banned_from + 1,
         last_seen_at = NOW()`,
      [userId]
    );
  } catch (e) {
    logger.warn(`[NetworkIntel] recordNetworkBan failed for ${userId}: ${e.message}`);
  }
}

export async function recordNetworkMessage(message) {
  if (!message?.guild || message.author?.bot) return;
  const uid = message.author?.id;
  if (!uid) return;
  if (!touchCache(uid)) return;
  try {
    await pool.query(
      `INSERT INTO network_member_activity
         (user_id, guilds_active, total_messages_sent, last_message_at,
          first_seen_at, last_seen_at)
       VALUES (?, 1, 1, NOW(), NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         guilds_active = IF(last_message_at IS NULL, guilds_active + 1, guilds_active),
         total_messages_sent = total_messages_sent + 1,
         last_message_at = NOW(),
         last_seen_at = NOW()`,
      [uid]
    );
  } catch (e) {
    // Silent — must never break message handling.
  }
}

export async function getNetworkActivity(userId) {
  if (!userId) return null;
  try {
    const [[row]] = await pool.query(
      `SELECT * FROM network_member_activity WHERE user_id = ? LIMIT 1`,
      [userId]
    );
    return row || null;
  } catch { return null; }
}
