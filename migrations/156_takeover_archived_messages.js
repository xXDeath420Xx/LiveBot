// A receipt for every message the takeover deletes from someone else's guild.
//
// The takeover's first design rule is that it never touches a channel — with exactly one exception:
// rebuilding the self-assign panels has to take the old ones down, because a Carl-bot panel keeps
// rendering its reactions after Carl-bot leaves and members go on clicking a dead panel.
//
// Deleting is irreversible and it is not our server. So we keep the full content of anything we
// remove: if the owner ever asks "what did that panel say", the answer is in here rather than in
// a apology.

export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS takeover_archived_messages (
      id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
      guild_id     VARCHAR(20)  NOT NULL,
      channel_id   VARCHAR(20)  NOT NULL,
      message_id   VARCHAR(20)  NOT NULL,
      author_id    VARCHAR(20)      NULL,
      author_name  VARCHAR(100)     NULL,
      content      TEXT             NULL,
      embeds       JSON             NULL,
      reactions    JSON             NULL,
      archived_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      -- Re-archiving the same message must refresh it, not stack duplicates.
      UNIQUE KEY uq_message (message_id),
      KEY idx_guild (guild_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS takeover_archived_messages');
}
