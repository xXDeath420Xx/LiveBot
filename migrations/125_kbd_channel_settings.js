/**
 * Migration 125 — per-channel Kick Defender settings.
 * Additive. One row per enrolled channel that has customized its enforcement.
 * Absent row == use the engine's hardcoded defaults (no behavior change).
 * Runner (scripts/run-migration-125.js) calls up(pool), so `db` IS the pool.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS kbd_channel_settings (
            channel_id VARCHAR(64) PRIMARY KEY,
            ban_duration_min INT NULL,
            phishing_threshold INT NOT NULL DEFAULT 2,
            warning_template TEXT NULL,
            safe_domains TEXT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS kbd_channel_settings');
}
