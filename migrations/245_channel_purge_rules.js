/*
 * Content-aware channel purge rules — the per-message half of auto-purge.
 *
 * `scheduled_purges` answers "empty this channel at 3am". That is the wrong
 * shape for the thing people actually keep asking for, which is a channel where
 * each individual post expires a fixed time after IT was made: a 24h self-promo
 * channel where a post made at 11:59pm does not get wiped one minute later, an
 * images-only channel that drops everything that is not an image after an hour,
 * a venting channel that keeps nothing over a week.
 *
 * So a rule here is (when) + (what):
 *
 *   when — delete_after_seconds, measured from the message's own timestamp.
 *   what — `filters` + `target` + `match_mode`, so the rule can act on the
 *          matching messages or on everything EXCEPT them.
 *
 * ## Why there is no message-tracking table
 *
 * The obvious build is a queue: hook messageCreate, insert (message_id,
 * delete_at), sweep the due rows. That design misses posts, permanently, and
 * silently — every message sent while the process was down, mid-reconnect, or
 * before the rule existed has no row and therefore never expires. The user
 * asking for this specifically asked that it never miss a post.
 *
 * A Discord snowflake already encodes its creation time, so channel history IS
 * the queue and it is authoritative. The sweeper converts "now - TTL" into a
 * snowflake and pages backwards from it; everything it finds is due by
 * construction. Downtime costs a delay, never a miss, and no message-level rows
 * are stored at all.
 *
 * `scan_cursor` / `scan_complete` exist only so a rule switched on over a
 * 40,000-message backlog drains across cycles instead of in one rate-limited
 * stampede. See jobs/purge-rule-sweeper.js.
 *
 * JSON-shaped columns are TEXT: MariaDB 10.11's JSON is a LONGTEXT alias, and
 * the rest of this schema (channel_post_rules) already stores arrays as TEXT.
 */

async function hasColumn(db, table, column) {
  const [cols] = await db.execute(`SHOW COLUMNS FROM \`${table}\``);
  return cols.some(c => c.Field === column);
}

export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS channel_purge_rules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      guild_id VARCHAR(20) NOT NULL,
      channel_id VARCHAR(20) NOT NULL,
      name VARCHAR(100) NOT NULL DEFAULT 'Untitled rule',
      enabled TINYINT(1) NOT NULL DEFAULT 1,

      -- Log what it would delete, delete nothing. The safe way to try a rule
      -- on a channel that matters.
      dry_run TINYINT(1) NOT NULL DEFAULT 0,

      -- Age, from the message's own timestamp. 0 is not allowed by the UI.
      delete_after_seconds INT NOT NULL DEFAULT 86400,

      -- 'matching'     = delete the messages the filters select
      -- 'non_matching' = delete everything the filters do NOT select
      --                  ("this channel is images only")
      target ENUM('matching','non_matching') NOT NULL DEFAULT 'matching',
      -- How multiple active filters combine.
      match_mode ENUM('any','all') NOT NULL DEFAULT 'any',
      -- JSON object; absent/falsy keys are inactive criteria.
      -- No active criteria = matches every message (plain TTL channel).
      filters TEXT NULL,

      -- Exemptions are applied AFTER targeting and always win.
      exempt_pinned TINYINT(1) NOT NULL DEFAULT 1,
      exempt_bots TINYINT(1) NOT NULL DEFAULT 1,
      exempt_role_ids TEXT NULL,
      exempt_user_ids TEXT NULL,

      log_channel_id VARCHAR(20) NULL,

      -- Backlog drain state. Cleared whenever the rule is edited so the new
      -- filters get applied to the whole channel, not just new posts.
      scan_cursor VARCHAR(20) NULL,
      scan_complete TINYINT(1) NOT NULL DEFAULT 0,

      last_run_at TIMESTAMP NULL,
      last_deleted INT NOT NULL DEFAULT 0,
      total_deleted BIGINT NOT NULL DEFAULT 0,
      last_error VARCHAR(255) NULL,

      created_by VARCHAR(20) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

      INDEX idx_enabled (enabled),
      INDEX idx_guild (guild_id),
      INDEX idx_guild_channel (guild_id, channel_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Deliberately NOT unique on (guild_id, channel_id): a channel can carry more
  // than one rule — "drop links after 1h" alongside "drop everything after 7d".
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS channel_purge_rules');
}
