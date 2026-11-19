/**
 * Wave 379 — auto_role_categories: when a channel is CREATED inside a registered
 * category, the bot auto-generates a matching role (or re-uses an existing one for
 * `-codes` siblings), locks the channel to that role, and appends it to the
 * guild's game-roles reaction-role panel.
 */
export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS auto_role_categories (
            guild_id VARCHAR(20) NOT NULL,
            category_id VARCHAR(20) NOT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            role_color VARCHAR(10) DEFAULT NULL,
            default_emoji VARCHAR(16) DEFAULT NULL,
            reaction_panel_id INT DEFAULT NULL,
            added_by VARCHAR(20) DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, category_id),
            KEY idx_enabled (enabled)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
}
export async function down(pool) {
    await pool.query('DROP TABLE IF EXISTS auto_role_categories');
}
