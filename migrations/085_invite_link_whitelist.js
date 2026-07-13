/**
 * Migration 085: Invite link filter — configurable block + user/role/channel whitelist
 *
 * Creates:
 *   - invite_filter_config: per-guild configuration (enabled, use_whitelist, action, log_channel_id)
 *   - automod_link_whitelist: unified whitelist (target_type: user|role|channel)
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS invite_filter_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            use_whitelist TINYINT(1) NOT NULL DEFAULT 0,
            action ENUM('delete','delete_warn','log_only') NOT NULL DEFAULT 'delete_warn',
            log_channel_id VARCHAR(20) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS automod_link_whitelist (
            guild_id VARCHAR(20) NOT NULL,
            target_type ENUM('user','role','channel') NOT NULL,
            target_id VARCHAR(20) NOT NULL,
            added_by VARCHAR(20) DEFAULT NULL,
            reason VARCHAR(255) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, target_type, target_id),
            INDEX idx_guild_type (guild_id, target_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS automod_link_whitelist');
    await db.execute('DROP TABLE IF EXISTS invite_filter_config');
}
