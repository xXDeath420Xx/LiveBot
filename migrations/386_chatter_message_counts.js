/**
 * Wave 386 — twitch_chatter_sightings only recorded presence (Helix chatter-list polls), so
 * "Top chatters" ranked idle accounts that never typed above real chatters. Track messages
 * per chatter too; backfill from the chat samples already stored.
 */
export async function up(pool) {
    await pool.query(`
        ALTER TABLE twitch_chatter_sightings
            ADD COLUMN IF NOT EXISTS messages INT UNSIGNED NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS last_message_at DATETIME NULL`);
    await pool.query(`
        ALTER TABLE twitch_chatter_sightings
            ADD INDEX IF NOT EXISTS idx_broadcaster_messages (broadcaster_id, messages)`);
    await pool.query(`
        INSERT INTO twitch_chatter_sightings
            (broadcaster_id, chatter_user_id, chatter_user_login, first_seen_at, last_seen_at,
             sightings, sessions_seen, messages, last_message_at)
        SELECT broadcaster_id, chatter_user_id, MAX(chatter_user_login), MIN(occurred_at), MAX(occurred_at),
               0, 0, COUNT(*), MAX(occurred_at)
          FROM twitch_chat_message_samples
         WHERE chatter_user_id IS NOT NULL
         GROUP BY broadcaster_id, chatter_user_id
        ON DUPLICATE KEY UPDATE messages = VALUES(messages), last_message_at = VALUES(last_message_at)`);
}

export async function down(pool) {
    await pool.query(`
        ALTER TABLE twitch_chatter_sightings
            DROP INDEX IF EXISTS idx_broadcaster_messages,
            DROP COLUMN IF EXISTS messages,
            DROP COLUMN IF EXISTS last_message_at`);
}
