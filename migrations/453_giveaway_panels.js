/**
 * Migration 453 — where each server's "Create giveaway" panel is (register H-715).
 *
 * Giveaway host roles only gate the panel's Create Giveaway button, and nothing but a one-server script ever
 * posted the panel. The Giveaways page now posts it (core/giveaway-panel.js); this row is how a later save
 * edits that message instead of posting another, or moves it. One panel per server.
 */
export async function up(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS giveaway_panels (
            guild_id   VARCHAR(20) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            message_id VARCHAR(20) NOT NULL,
            updated_by VARCHAR(20) DEFAULT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down(db) {
    await db.query('DROP TABLE IF EXISTS giveaway_panels');
}
