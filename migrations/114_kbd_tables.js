/**
 * Migration 114 — Kick Defender (KBD) tables + defender enrollment flag.
 * Shared-banlist defense network for Kick.
 * See docs/superpowers/specs/2026-05-29-kick-defender-design.md
 *
 * The runner (scripts/run-migration-114.js) calls up(pool), so `db` IS the
 * shared mysql2 pool (utils/db.js). Do NOT import the pool here — use the `db`
 * arg. Idempotent (CREATE TABLE IF NOT EXISTS + column guard) since nothing
 * tracks whether a migration already ran. ENGINE/CHARSET set explicitly to
 * match the rest of the schema and avoid utf8mb3 corruption of unicode names.
 */

export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS kbd_banlist (
            id INT PRIMARY KEY AUTO_INCREMENT,
            platform VARCHAR(16) NOT NULL DEFAULT 'kick',
            platform_user_id VARCHAR(64) NULL,
            username VARCHAR(255) NOT NULL,
            reason VARCHAR(255) NULL,
            list_type ENUM('ban','sublist') NOT NULL DEFAULT 'ban',
            added_by INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_user (platform, platform_user_id, list_type),
            KEY idx_username (platform, username),
            KEY idx_list_type (list_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS kbd_unbanlist (
            id INT PRIMARY KEY AUTO_INCREMENT,
            platform VARCHAR(16) NOT NULL DEFAULT 'kick',
            platform_user_id VARCHAR(64) NULL,
            username VARCHAR(255) NOT NULL,
            added_by INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_user (platform, platform_user_id),
            KEY idx_username (platform, username)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS kbd_malicious_sites (
            id INT PRIMARY KEY AUTO_INCREMENT,
            uri VARCHAR(512) NOT NULL,
            added_by INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_uri (uri)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS kbd_managers (
            id INT PRIMARY KEY AUTO_INCREMENT,
            tokes_user_id INT NOT NULL,
            added_by INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_manager (tokes_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS kbd_enforcement_log (
            id INT PRIMARY KEY AUTO_INCREMENT,
            channel_id VARCHAR(64) NOT NULL,
            target_user_id VARCHAR(64) NULL,
            target_username VARCHAR(255) NOT NULL,
            action ENUM('ban','delete','detected_no_scope') NOT NULL,
            reason VARCHAR(255) NULL,
            success TINYINT(1) NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_channel (channel_id),
            KEY idx_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Enrollment flag on existing tokes_channels (guard: column may already exist)
    const [cols] = await db.execute(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tokes_channels'
          AND COLUMN_NAME = 'defender_enabled'
    `);
    if (cols.length === 0) {
        await db.execute(
            `ALTER TABLE tokes_channels ADD COLUMN defender_enabled TINYINT(1) NOT NULL DEFAULT 0`
        );
    }
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS kbd_enforcement_log');
    await db.execute('DROP TABLE IF EXISTS kbd_managers');
    await db.execute('DROP TABLE IF EXISTS kbd_malicious_sites');
    await db.execute('DROP TABLE IF EXISTS kbd_unbanlist');
    await db.execute('DROP TABLE IF EXISTS kbd_banlist');
    // Intentionally leave defender_enabled column in place (dropping risks data loss on re-up).
}
