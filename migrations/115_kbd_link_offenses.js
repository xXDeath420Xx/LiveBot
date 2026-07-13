/**
 * Migration 115 — Kick Defender per-user phishing-link offense tracking.
 *
 * Powers the delete+warn-on-first, ban-on-repeat escalation. One row per
 * (platform, user); offense_count increments on each flagged link.
 * Runner: scripts/run-migration-115.js calls up(pool), so `db` IS the pool.
 */

export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS kbd_link_offenses (
            id INT PRIMARY KEY AUTO_INCREMENT,
            platform VARCHAR(16) NOT NULL DEFAULT 'kick',
            platform_user_id VARCHAR(64) NOT NULL,
            username VARCHAR(255) NULL,
            offense_count INT NOT NULL DEFAULT 0,
            last_domain VARCHAR(255) NULL,
            last_offense_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_offender (platform, platform_user_id),
            KEY idx_last_offense (last_offense_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS kbd_link_offenses');
}
