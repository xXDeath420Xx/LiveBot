// Application emoji are owned by a single application, so every bot that serves Cat Bot
// needs its own uploads. Keyed by (bot_id, cat_type).
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS catbot_emojis (
      bot_id     VARCHAR(20) NOT NULL,
      cat_type   VARCHAR(16) NOT NULL,
      emoji_id   VARCHAR(20) NOT NULL,
      emoji_name VARCHAR(32) NOT NULL,
      animated   TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (bot_id, cat_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS catbot_emojis');
}
