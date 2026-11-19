/**
 * Migration 440 — open voice-XP sessions survive a restart (register H-672).
 *
 * core/leveling-voice-sessions.js keeps one row per member currently in voice in a server with voice
 * XP on: the channel and when the session started. last_seen_at is refreshed every few minutes while
 * the bot runs; after a restart a session whose member has left is credited up to that time. A row
 * is deleted when the member leaves voice, so the table only ever holds people in voice right now.
 *
 * /privacy delete covers it (core/privacy-tables.js DELETE_PLAN).
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS.
 */
export async function up(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS level_voice_sessions (
            guild_id     VARCHAR(20) NOT NULL,
            user_id      VARCHAR(20) NOT NULL,
            channel_id   VARCHAR(20) NOT NULL,
            started_at   DATETIME    NOT NULL,
            last_seen_at DATETIME    NOT NULL,
            PRIMARY KEY (guild_id, user_id),
            KEY idx_user (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down(db) {
    await db.query('DROP TABLE IF EXISTS level_voice_sessions');
}
