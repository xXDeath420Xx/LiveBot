/*
 * Targeted anti-sabotage for counting channels.
 *
 * A known griefer posts specific out-of-turn numbers to reset the count for everyone. This table lets
 * moderation name (guild, channel, user, numbers): when that user posts one of those numbers out of
 * turn, core/counting-manager.js deletes it, protects the count from resetting, and permanently
 * revokes their access to the channel. Config-driven so no user IDs live in code.
 */
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS counting_sabotage_guards (
      guild_id VARCHAR(20) NOT NULL,
      channel_id VARCHAR(20) NOT NULL,
      user_id VARCHAR(20) NOT NULL,
      numbers VARCHAR(255) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      triggered_count INT NOT NULL DEFAULT 0,
      last_triggered_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, channel_id, user_id)
    )
  `);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS counting_sabotage_guards');
}

export default { up, down };
