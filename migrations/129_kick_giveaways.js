/**
 * Migration 129 — chat giveaways for the Kick bot.
 * Viewers type !<keyword> to enter; the streamer draws a winner from the
 * dashboard. One active giveaway per channel at a time (enforced in code).
 * Runner: scripts/run-migration-129.js.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS tokes_giveaways (
            id INT PRIMARY KEY AUTO_INCREMENT,
            channel_id INT NOT NULL,
            title VARCHAR(200) NOT NULL,
            keyword VARCHAR(50) NOT NULL DEFAULT 'enter',
            status ENUM('active','closed','drawn') NOT NULL DEFAULT 'active',
            winner_username VARCHAR(100) NULL,
            created_by VARCHAR(64) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            closed_at TIMESTAMP NULL,
            KEY idx_channel_status (channel_id, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS tokes_giveaway_entries (
            id INT PRIMARY KEY AUTO_INCREMENT,
            giveaway_id INT NOT NULL,
            platform_user_id VARCHAR(64) NOT NULL,
            username VARCHAR(100) NOT NULL,
            entered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_entry (giveaway_id, platform_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS tokes_giveaway_entries');
    await db.execute('DROP TABLE IF EXISTS tokes_giveaways');
}
