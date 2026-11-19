/*
 * Member purge — erase a departed member's traces from a server.
 *
 * Two tables:
 *   member_purge_config  per-guild settings: what triggers a purge, what is exempt from one
 *   member_purge_jobs    one row per purge, so a run that touches tens of thousands of messages
 *                        can report progress, survive a restart and be cancelled mid-way
 *
 * The archive reuses `takeover_archived_messages`: deleting a message is irreversible and this is
 * the receipt. A purge that cannot be audited afterwards is indistinguishable from a bug.
 */
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS member_purge_config (
      guild_id           VARCHAR(20) PRIMARY KEY,
      enabled            TINYINT(1)  NOT NULL DEFAULT 0,
      on_leave           TINYINT(1)  NOT NULL DEFAULT 1,
      on_kick            TINYINT(1)  NOT NULL DEFAULT 1,
      on_ban             TINYINT(1)  NOT NULL DEFAULT 1,
      -- Widest scope the owner can pick: also remove messages that MENTION the departed member.
      include_mentions   TINYINT(1)  NOT NULL DEFAULT 0,
      -- Moderation and ban records are exempt by default. Erasing a member's chat is data hygiene;
      -- erasing WHY they were banned destroys the record staff rely on to spot ban evasion.
      exempt_mod_logs    TINYINT(1)  NOT NULL DEFAULT 1,
      exempt_channels    TEXT        NULL,
      archive_before     TINYINT(1)  NOT NULL DEFAULT 1,
      -- A member gone this long is safe to purge. Guards against a rejoin racing the purge.
      grace_minutes      INT         NOT NULL DEFAULT 5,
      created_at         TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at         TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS member_purge_jobs (
      id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      guild_id           VARCHAR(20) NOT NULL,
      user_id            VARCHAR(20) NULL,
      kind               ENUM('member','backfill') NOT NULL DEFAULT 'member',
      reason             VARCHAR(32) NULL,
      status             ENUM('planned','running','complete','cancelled','failed') NOT NULL DEFAULT 'planned',
      dry_run            TINYINT(1)  NOT NULL DEFAULT 1,
      channels_total     INT UNSIGNED NOT NULL DEFAULT 0,
      channels_done      INT UNSIGNED NOT NULL DEFAULT 0,
      messages_found     INT UNSIGNED NOT NULL DEFAULT 0,
      messages_deleted   INT UNSIGNED NOT NULL DEFAULT 0,
      messages_failed    INT UNSIGNED NOT NULL DEFAULT 0,
      users_total        INT UNSIGNED NOT NULL DEFAULT 0,
      users_done         INT UNSIGNED NOT NULL DEFAULT 0,
      started_by         VARCHAR(20) NULL,
      error              TEXT        NULL,
      started_at         TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at        TIMESTAMP   NULL,
      INDEX idx_guild_status (guild_id, status),
      INDEX idx_guild_user (guild_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS member_purge_jobs');
  await db.execute('DROP TABLE IF EXISTS member_purge_config');
}

export default { up, down };
