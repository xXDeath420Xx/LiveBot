/**
 * Migration 127 — per-channel keyword auto-responders for the Kick/Tokes bot.
 * When a chat message matches a trigger, the bot replies with a template
 * response (supports the same {{variables}} as custom commands). Additive.
 * Runner: scripts/run-migration-127.js calls up(pool), so `db` IS the pool.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS tokes_auto_responders (
            id INT PRIMARY KEY AUTO_INCREMENT,
            channel_id INT NOT NULL,
            trigger_text VARCHAR(100) NOT NULL,
            match_type ENUM('contains','exact','starts','word') NOT NULL DEFAULT 'contains',
            response VARCHAR(500) NOT NULL,
            cooldown INT NOT NULL DEFAULT 10,
            is_enabled TINYINT(1) NOT NULL DEFAULT 1,
            use_count INT NOT NULL DEFAULT 0,
            created_by VARCHAR(64) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_channel (channel_id, is_enabled)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS tokes_auto_responders');
}
