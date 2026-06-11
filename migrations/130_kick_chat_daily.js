/**
 * Migration 130 — per-channel daily chat message counts (engagement analytics).
 * One row per channel per day, incremented by a buffered counter in the bot.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS tokes_chat_daily (
            channel_id INT NOT NULL,
            date DATE NOT NULL,
            messages INT NOT NULL DEFAULT 0,
            PRIMARY KEY (channel_id, date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}
export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS tokes_chat_daily');
}
