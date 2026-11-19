/*
 * Per-channel posting requirements.
 *
 * For channels that exist for one kind of post — an events channel that wants
 * event posters, not "here's my twitch link" drive-bys. A message that fails the
 * rule is removed and the author is told why.
 *
 * Two independent gates, either can be off:
 *   - require_image: the message must carry an actual image. Link previews do
 *     NOT count (they arrive after messageCreate anyway), so a bare stream link,
 *     or a stream link with a sentence attached, fails.
 *   - min_level: the author must have earned it through the leveling system.
 *   - min_messages / activity_window_days: an alternative activity gate for
 *     guilds with leveling off. Counted from activity_logs EXCLUDING this
 *     channel, so nobody can farm their way in by posting here.
 *
 * No row for a channel = no rules, so this is inert everywhere until configured.
 */
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS channel_post_rules (
      guild_id VARCHAR(20) NOT NULL,
      channel_id VARCHAR(20) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      require_image TINYINT(1) NOT NULL DEFAULT 1,
      blocked_link_domains TEXT NULL,
      min_level INT NOT NULL DEFAULT 0,
      min_messages INT NOT NULL DEFAULT 0,
      activity_window_days INT NOT NULL DEFAULT 30,
      min_member_days INT NOT NULL DEFAULT 0,
      exempt_role_ids TEXT NULL,
      delete_violations TINYINT(1) NOT NULL DEFAULT 1,
      notify_user TINYINT(1) NOT NULL DEFAULT 1,
      log_channel_id VARCHAR(20) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, channel_id)
    )
  `);

  // min_level was added after the table shipped — bring existing installs up.
  const [cols] = await db.execute("SHOW COLUMNS FROM channel_post_rules LIKE 'min_level'");
  if (cols.length === 0) {
    await db.execute('ALTER TABLE channel_post_rules ADD COLUMN min_level INT NOT NULL DEFAULT 0 AFTER blocked_link_domains');
  }
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS channel_post_rules');
}

export default { up, down };
