/**
 * Migration 131 — received Kick webhook events (follows, subs, stream status).
 * Stored for dashboard feeds + debugging. channel_id is the Kick broadcaster id.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS tokes_kick_events (
            id INT PRIMARY KEY AUTO_INCREMENT,
            channel_id VARCHAR(64) NOT NULL,
            event_type VARCHAR(64) NOT NULL,
            actor_username VARCHAR(100) NULL,
            payload JSON NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_channel_time (channel_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}
export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS tokes_kick_events');
}
