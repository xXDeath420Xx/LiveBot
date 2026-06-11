/**
 * Migration 128 — per-channel timer (scheduled) messages for the Kick bot.
 * The bot posts `message` to the channel every `interval_min` minutes while the
 * channel is enrolled. Additive. Runner: scripts/run-migration-128.js.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS tokes_timers (
            id INT PRIMARY KEY AUTO_INCREMENT,
            channel_id INT NOT NULL,
            message VARCHAR(500) NOT NULL,
            interval_min INT NOT NULL DEFAULT 30,
            is_enabled TINYINT(1) NOT NULL DEFAULT 1,
            last_sent_at TIMESTAMP NULL,
            send_count INT NOT NULL DEFAULT 0,
            created_by VARCHAR(64) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_channel (channel_id, is_enabled)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS tokes_timers');
}
