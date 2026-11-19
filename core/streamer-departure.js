/*
 * Departure tracking for streamer subscriptions.
 *
 * Three entry points, one rule between them:
 *
 *   markDeparted()   a member left / was kicked / was banned  -> pause their subscriptions here
 *   markReturned()   a member joined                          -> un-pause the ones WE paused
 *   isSnowflake()    guard for anything writing discord_user_id
 *
 * The delete side lives in jobs/streamer-departure-sweeper.js, on a 30-day clock.
 *
 * SCOPE, deliberately narrow
 *
 * This only ever touches subscriptions in the guild the member left, and only ones whose streamer
 * row carries their `discord_user_id`. A streamer with no linked Discord account cannot be matched
 * to a member and is never touched — 365 of the network's 958 subscriptions are in that state, and
 * silence is the correct behaviour for them, not a guess.
 *
 * `permanent = 1` is honoured throughout. It already means "the owner said never auto-remove this"
 * to the Community Support rotation, and a departure is a weaker signal than that flag, not a
 * stronger one.
 *
 * WHY THE PAUSE IS IMMEDIATE AND THE DELETE IS NOT
 *
 * There is no grace window on pausing. A pause is free to undo and instantly correct: the moment
 * somebody is out of the server, announcing them in it is wrong, and if they walk back in a minute
 * later markReturned() restores the row untouched. Putting a grace window here would only mean
 * announcing an ex-member for the length of the window. The 30 days before deletion is where the
 * caution belongs, because deletion is the part that cannot be taken back.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/** How long somebody stays gone before their paused subscription is actually deleted. */
export const DELETE_AFTER_DAYS = 30;

/**
 * Discord snowflakes are numeric strings, currently 17-19 digits.
 *
 * Checked as "17+ digits, nothing else" rather than a fixed length: ids get longer over time, and a
 * validator that hard-codes today's width would start rejecting real accounts later. The failure
 * this guards against is a USERNAME landing in the column (the literal 'SuperMike242' did), which
 * this catches whatever the id length happens to be.
 */
export function isSnowflake(value) {
  return typeof value === 'string' && /^[0-9]{17,}$/.test(value);
}

/**
 * Pause every subscription in `guildId` belonging to `userId`, and stamp when and why.
 *
 * Idempotent by `departed_at IS NULL`. A ban raises BOTH guildMemberRemove and guildBanAdd, so this
 * gets called twice for the same person within milliseconds; the second call updates nothing rather
 * than overwriting a 'leave'/'kick' reason and, more importantly, rather than resetting the 30-day
 * clock. The one exception is a reason upgrade to 'ban', below.
 *
 * Returns the number of subscriptions paused.
 */
export async function markDeparted(guildId, userId, reason = 'leave') {
  if (!guildId || !isSnowflake(String(userId))) return 0;

  const [res] = await pool.execute(
    `UPDATE subscriptions sub
       JOIN streamers s ON s.streamer_id = sub.streamer_id
        SET sub.paused = 1,
            sub.departed_at = NOW(),
            sub.departed_reason = ?
      WHERE sub.guild_id = ?
        AND s.discord_user_id = ?
        AND sub.permanent = 0
        -- An 'external' subscription is tracked because the server chose to promote that
        -- streamer, not because they are a member. A partner who is ALSO in the server and
        -- then leaves must keep being announced; their membership was never the reason.
        AND sub.tracking_origin <> 'external'
        AND sub.departed_at IS NULL`,
    [reason, String(guildId), String(userId)]);

  /*
   * A ban that follows a leave should read as a ban.
   *
   * guildMemberRemove fires first when someone is banned, so the row is already stamped 'leave' by
   * the time guildBanAdd arrives and the idempotency guard above skips it. That would leave the
   * record saying the wrong thing about why they are gone, which matters to whoever reads the
   * departed list later. The clock is deliberately NOT reset here — only the label changes.
   */
  if (reason === 'ban') {
    await pool.execute(
      `UPDATE subscriptions sub
         JOIN streamers s ON s.streamer_id = sub.streamer_id
          SET sub.departed_reason = 'ban'
        WHERE sub.guild_id = ?
          AND s.discord_user_id = ?
          AND sub.departed_at IS NOT NULL
          AND sub.departed_reason <> 'ban'`,
      [String(guildId), String(userId)]).catch(() => {});
  }

  if (res.affectedRows > 0) {
    logger.info(`[StreamerDeparture] paused ${res.affectedRows} subscription(s) in ${guildId} for departed member ${userId} (${reason})`);
  }
  return res.affectedRows;
}

/**
 * Undo a departure pause when the member comes back.
 *
 * Gated on `departed_at IS NOT NULL` so it only clears pauses this feature created. A subscription
 * paused by the monthly leveling reset for being under level 3 must stay paused through a rejoin —
 * un-pausing it here would hand someone a way to bypass the level gate by leaving and returning.
 */
export async function markReturned(guildId, userId) {
  if (!guildId || !isSnowflake(String(userId))) return 0;

  const [res] = await pool.execute(
    `UPDATE subscriptions sub
       JOIN streamers s ON s.streamer_id = sub.streamer_id
        SET sub.paused = 0,
            sub.departed_at = NULL,
            sub.departed_reason = NULL
      WHERE sub.guild_id = ?
        AND s.discord_user_id = ?
        AND sub.departed_at IS NOT NULL`,
    [String(guildId), String(userId)]);

  if (res.affectedRows > 0) {
    logger.info(`[StreamerDeparture] restored ${res.affectedRows} subscription(s) in ${guildId} for returning member ${userId}`);
  }
  return res.affectedRows;
}

/** Every subscription currently marked departed, newest first. Used by the sweeper and by /admin. */
export async function listDeparted(guildId = null) {
  const [rows] = await pool.execute(
    `SELECT sub.subscription_id, sub.guild_id, sub.departed_at, sub.departed_reason, sub.permanent,
            s.streamer_id, s.platform, s.username, s.discord_user_id,
            DATEDIFF(NOW(), sub.departed_at) AS days_gone
       FROM subscriptions sub
       JOIN streamers s ON s.streamer_id = sub.streamer_id
      WHERE sub.departed_at IS NOT NULL ${guildId ? 'AND sub.guild_id = ?' : ''}
      ORDER BY sub.departed_at DESC`,
    guildId ? [String(guildId)] : []);
  return rows;
}
