/**
 * user_flag_observations — record every (user_id, flag_bits) tuple we observe,
 * so we can later answer "when did Discord first flag this user?" with a bound
 * that's as tight as our observation history. Discord does not expose this
 * timestamp directly; our bot sees public_flags on every user payload and this
 * module just remembers what we've seen.
 *
 * Hooks live in: core/spammer-guard.js (every memberIsSpammer call), events/
 * guildMemberAdd.js (every join), events/userUpdate.js (flag changes mid-stay).
 *
 * The write path is fire-and-forget: callers never await, never see errors.
 * One failed UPSERT must never block a join / message / mod action.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

// Discord's public flag bits that are actionable here. Full list in discord.js
// UserFlags; we only care about moderation-relevant ones for querying.
export const FLAG_BITS = {
    SPAMMER:     1n << 20n,  // "This user is likely a spammer"
    QUARANTINED: 1n << 44n,  // Discord has restricted this account
};

/**
 * Observe a user's current flag bitfield. Non-blocking: swallows errors so
 * callers never need to try/catch. Pass guildId when known so the first
 * observation records WHERE we first saw this state (debug aid).
 *
 * @param {{id: string, flags?: {bitfield?: number|bigint}}} user discord.js User
 * @param {string|null} guildId optional
 */
export function observeFlags(user, guildId = null) {
    if (!user?.id) return;
    const bitsRaw = user.flags?.bitfield;
    if (bitsRaw === undefined || bitsRaw === null) return;    // nothing to say
    // discord.js may return number or bigint depending on build; normalise to string
    const bits = typeof bitsRaw === 'bigint' ? bitsRaw.toString() : String(bitsRaw);
    pool.execute(
        `INSERT INTO user_flag_observations
           (user_id, flag_bits, first_seen_at, last_seen_at, observation_count, first_source_guild_id)
         VALUES (?, ?, NOW(), NOW(), 1, ?)
         ON DUPLICATE KEY UPDATE
           last_seen_at      = NOW(),
           observation_count = observation_count + 1`,
        [String(user.id), bits, guildId ? String(guildId) : null],
    ).catch(err => logger.warn(`[FlagObs] observe failed for ${user.id}: ${err.message}`));
}

/** Return every (flag_bits, first_seen, last_seen, count) tuple we've recorded for a user. */
export async function getFlagHistory(userId) {
    const [rows] = await pool.execute(
        `SELECT flag_bits, first_seen_at, last_seen_at, observation_count, first_source_guild_id
           FROM user_flag_observations
          WHERE user_id = ? ORDER BY first_seen_at`,
        [String(userId)]);
    return rows;
}

/**
 * When did we first see a specific flag bit on this user? Returns a Date or null.
 * `flagBit` is a BigInt bit mask (e.g. FLAG_BITS.SPAMMER). The & is done in SQL.
 */
export async function getFirstFlaggedAt(userId, flagBit) {
    const bit = typeof flagBit === 'bigint' ? flagBit.toString() : String(flagBit);
    const [rows] = await pool.execute(
        `SELECT MIN(first_seen_at) AS first_seen
           FROM user_flag_observations
          WHERE user_id = ? AND (flag_bits & ?) <> 0`,
        [String(userId), bit]);
    return rows[0]?.first_seen || null;
}

/**
 * When did we last see this user WITHOUT a specific flag bit set? Returns Date
 * or null. Combined with getFirstFlaggedAt this gives the tightest window we
 * can offer for "Discord flagged them sometime between X and Y".
 */
export async function getLastSeenCleanAt(userId, flagBit) {
    const bit = typeof flagBit === 'bigint' ? flagBit.toString() : String(flagBit);
    const [rows] = await pool.execute(
        `SELECT MAX(last_seen_at) AS last_clean
           FROM user_flag_observations
          WHERE user_id = ? AND (flag_bits & ?) = 0`,
        [String(userId), bit]);
    return rows[0]?.last_clean || null;
}
