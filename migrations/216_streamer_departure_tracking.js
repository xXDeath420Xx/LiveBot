/*
 * Stop tracking streamers who are no longer in the server.
 *
 * A subscription in `subscriptions` outlives the member it belongs to. Nothing in
 * guildMemberRemove, guildBanAdd or any scheduler has ever reconciled the two, so a person who
 * leaves, is kicked or is banned keeps being announced in a server they are not in — 53 of them
 * across 20 guilds when this was written, one of whom had been gone for months.
 *
 * The rule this adds: departure pauses, thirty days of absence deletes.
 *
 * Pausing rather than deleting on the spot is the whole point. A departure is very often not
 * permanent — a reconnect, a mis-click, a kick a mod reverses ten minutes later, a break between
 * seasons. Deleting the row throws away the announcement channel, the live role, the custom message
 * and the ping role, and the member has to be set up from scratch when they come back. Pausing
 * costs nothing to undo: guildMemberAdd flips it straight back.
 *
 * WHY A SEPARATE COLUMN, WHEN `paused` ALREADY EXISTS
 *
 * `paused` is overloaded. The monthly leveling reset (jobs/leveling-monthly-reset.js) sets it on
 * every subscription owned by someone below level 3, and leveling-manager clears it again when they
 * level up. If departure reused that flag alone, two things would break:
 *
 *   • the 30-day sweeper would delete subscriptions that were only paused for being under-levelled
 *   • a level-up would silently "un-depart" somebody who is not in the server at all
 *
 * `departed_at` is therefore the authority on WHY a row is paused. The sweeper reads only rows
 * where it is set, and the rejoin path clears only rows where it is set. The two systems can both
 * hold the same row paused without either one undoing the other.
 *
 * WHAT THIS MIGRATION DOES NOT DO
 *
 * It does not backfill the 53 known-stale rows. jobs/streamer-departure-sweeper.js re-derives that
 * set from live Discord membership on its first pass, which is the same answer with none of the
 * risk of freezing a months-old audit into a data migration — somebody in that list may well have
 * rejoined between the audit and the deploy.
 */
export async function up(db) {
  const [existing] = await db.execute('SHOW COLUMNS FROM subscriptions');
  const have = new Set(existing.map(c => c.Field));

  const columns = [
    // NULL means "present, as far as we know". Set means "observed absent at this time", and it is
    // the clock the 30-day delete runs on.
    ['departed_at', 'DATETIME NULL DEFAULT NULL'],
    // 'sweep' is how a departure that happened while the bot was offline gets recorded — the
    // gateway event was never delivered, so the reconciler found it by asking Discord instead.
    ['departed_reason', "ENUM('leave','kick','ban','sweep') NULL DEFAULT NULL"],
  ];
  for (const [name, type] of columns) {
    if (have.has(name)) continue;
    await db.execute(`ALTER TABLE subscriptions ADD COLUMN ${name} ${type}`);
  }

  const [idx] = await db.execute("SHOW INDEX FROM subscriptions WHERE Key_name = 'idx_subscriptions_departed_at'");
  if (idx.length === 0) {
    await db.execute('CREATE INDEX idx_subscriptions_departed_at ON subscriptions (departed_at)');
  }

  /*
   * Repair `streamers.discord_user_id` values that are not Discord ids.
   *
   * The column is VARCHAR, so a write path that had a username in hand instead of a snowflake was
   * never stopped by the schema. Two rows carried the literal string 'SuperMike242'. Discord
   * answers 400/50035 for those, which means every membership check on them fails permanently —
   * and would have made this feature's reconciler log an error for that streamer forever.
   *
   * NULL, not a guess: a bad id is worse than no id. With NULL the row is simply out of scope for
   * departure tracking, which is honest. Re-linking it is a deliberate act by whoever knows which
   * Discord account it actually is.
   *
   * Snowflakes are 17-19 digits today and Discord's own guidance is to treat them as opaque
   * numeric strings, so this checks "17 or more digits, nothing else" rather than a fixed length —
   * a 20-digit id issued years from now must not be scrubbed by this.
   */
  const [bad] = await db.execute(
    `SELECT streamer_id, platform, username, discord_user_id FROM streamers
      WHERE discord_user_id IS NOT NULL AND discord_user_id <> ''
        AND discord_user_id NOT REGEXP '^[0-9]{17,}$'`);
  for (const row of bad) {
    // eslint-disable-next-line no-console
    console.log(`  [216] clearing non-snowflake discord_user_id ${JSON.stringify(row.discord_user_id)} on ${row.platform}/${row.username} (streamer_id ${row.streamer_id})`);
    await db.execute('UPDATE streamers SET discord_user_id = NULL WHERE streamer_id = ?', [row.streamer_id]);
  }
  // eslint-disable-next-line no-console
  console.log(`  [216] repaired ${bad.length} non-snowflake discord_user_id value(s)`);
}

export async function down(db) {
  const [existing] = await db.execute('SHOW COLUMNS FROM subscriptions');
  const have = new Set(existing.map(c => c.Field));
  const [idx] = await db.execute("SHOW INDEX FROM subscriptions WHERE Key_name = 'idx_subscriptions_departed_at'");
  if (idx.length > 0) await db.execute('DROP INDEX idx_subscriptions_departed_at ON subscriptions');
  for (const name of ['departed_at', 'departed_reason']) {
    if (have.has(name)) await db.execute(`ALTER TABLE subscriptions DROP COLUMN ${name}`);
  }
  // The cleared discord_user_id values are not restored: they were invalid data, not a schema change.
}
