/*
 * Audit log for the super-admin "Service keys" page (dashboard/routes/service-keys.js).
 *
 * One row per change the owner makes from the dashboard: which allow-listed key, whether it was
 * SET or CLEARED, who did it, and when. The secret VALUE is never stored here (or anywhere the page
 * can read) — only the key name and the action. The page shows the newest few rows so the owner can
 * see the history of rotations.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS service_key_audit (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            key_name    VARCHAR(64)  NOT NULL,
            action      VARCHAR(16)  NOT NULL COMMENT 'set | cleared',
            actor_id    VARCHAR(20)  NOT NULL COMMENT 'Discord id of the super-admin who made the change',
            actor_name  VARCHAR(64)  NULL DEFAULT NULL,
            created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_key_created (key_name, created_at),
            KEY idx_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS service_key_audit');
}
