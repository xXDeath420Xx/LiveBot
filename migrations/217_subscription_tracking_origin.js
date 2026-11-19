/*
 * Make "why is this streamer tracked?" an answerable question.
 *
 * `streamers.discord_user_id IS NULL` currently means two completely different things, and nothing
 * distinguishes them:
 *
 *   (a) a MEMBER whose Discord link was never captured when they were added — departure tracking
 *       should apply to them, and cannot, because there is no id to check membership with;
 *   (b) an EXTERNAL streamer the server deliberately promotes — a partner, an affiliate, a friend
 *       of the community who was never in the server at all. Departure tracking is meaningless for
 *       them: they never joined, so they can never leave.
 *
 * 164 subscriptions across 30 guilds sit in that ambiguous state. Guessing which is which from
 * names is exactly the mistake that put squatter Twitch accounts into community_twitch_links, so
 * this does not guess. It records what is actually KNOWN and leaves the rest honestly 'unknown'.
 *
 * WHAT THE BACKFILL INFERS, AND WHY EACH IS SAFE
 *
 *   team_subscription_id IS NOT NULL  -> 'external'
 *       The Twitch team roster governs these, not server membership. core/team-sync.js already
 *       adds and removes them hourly against the live roster, and all three teams were verified
 *       exactly in sync. Membership is irrelevant to them by construction.
 *
 *   permanent = 1                     -> 'external'
 *       Already means "the owner said never auto-remove this" — the friends-and-family bucket.
 *
 *   discord_user_id IS NOT NULL       -> 'member'
 *       There is a real linked account, so membership is the right question to ask about them.
 *
 *   anything else                     -> 'unknown' (the default)
 *       Not a guess, and not a bug to be fixed later by inference. New rows written by the add
 *       paths say which they are; these legacy ones stay unknown until a human says otherwise.
 *
 * THIS COLUMN IS ENFORCED, not decorative. jobs/streamer-departure-sweeper.js skips 'external'
 * outright, so a partner who happens to also be a member does not get untracked for leaving.
 */
export async function up(db) {
  const [existing] = await db.execute('SHOW COLUMNS FROM subscriptions');
  if (!existing.some(c => c.Field === 'tracking_origin')) {
    await db.execute(
      `ALTER TABLE subscriptions
         ADD COLUMN tracking_origin ENUM('member','external','unknown') NOT NULL DEFAULT 'unknown'`);
  }

  // Order matters: 'external' is claimed first so a team/permanent row that ALSO carries a Discord
  // link stays external. Being reachable on Discord does not make somebody's tracking conditional
  // on their membership.
  const [team] = await db.execute(
    `UPDATE subscriptions SET tracking_origin = 'external'
      WHERE tracking_origin = 'unknown' AND team_subscription_id IS NOT NULL`);
  const [perm] = await db.execute(
    `UPDATE subscriptions SET tracking_origin = 'external'
      WHERE tracking_origin = 'unknown' AND permanent = 1`);
  const [member] = await db.execute(
    `UPDATE subscriptions sub JOIN streamers s ON s.streamer_id = sub.streamer_id
        SET sub.tracking_origin = 'member'
      WHERE sub.tracking_origin = 'unknown'
        AND s.discord_user_id IS NOT NULL AND s.discord_user_id <> ''`);

  const [[left]] = await db.execute(
    `SELECT COUNT(*) n FROM subscriptions WHERE tracking_origin = 'unknown'`);

  /*
   * Recover the handful of Discord links that can be recovered WITHOUT guessing.
   *
   * community_twitch_links holds 885 rows with link_source = 'guess' and 12 with 'confirmed'. The
   * guesses are the same display-name-to-login inference that previously bound real members to
   * squatter Twitch accounts, and `streamers.discord_user_id` is global — one row serves every
   * guild — so a single bad guess would propagate network-wide and then have the departure sweeper
   * act on it. Only 'confirmed' rows are trusted here, and only on an exact login match.
   */
  const [linked] = await db.execute(
    `UPDATE streamers s
       JOIN community_twitch_links l
         ON LOWER(l.twitch_username) = LOWER(s.username) AND l.link_source = 'confirmed'
        SET s.discord_user_id = l.discord_user_id
      WHERE s.platform = 'twitch'
        AND (s.discord_user_id IS NULL OR s.discord_user_id = '')
        AND l.discord_user_id REGEXP '^[0-9]{17,}$'`);

  // eslint-disable-next-line no-console
  console.log(`  [217] external: ${team.affectedRows} team + ${perm.affectedRows} permanent · member: ${member.affectedRows} · still unknown: ${left.n} · confirmed links recovered: ${linked.affectedRows}`);
}

export async function down(db) {
  const [existing] = await db.execute('SHOW COLUMNS FROM subscriptions');
  if (existing.some(c => c.Field === 'tracking_origin')) {
    await db.execute('ALTER TABLE subscriptions DROP COLUMN tracking_origin');
  }
  // Recovered discord_user_id values are left in place — they came from confirmed links and are
  // correct data, not part of this migration's schema change.
}
