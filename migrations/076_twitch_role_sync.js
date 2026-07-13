export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS twitch_role_sync_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            broadcaster_twitch_id VARCHAR(20) NOT NULL,
            broadcaster_twitch_username VARCHAR(100) NOT NULL,
            broadcaster_token JSON NOT NULL,
            broadcaster_refresh_token JSON DEFAULT NULL,
            token_expires_at DATETIME DEFAULT NULL,
            token_scopes TEXT DEFAULT NULL,
            vip_role_id VARCHAR(20) DEFAULT NULL,
            mod_role_id VARCHAR(20) DEFAULT NULL,
            sub_role_id VARCHAR(20) DEFAULT NULL,
            remove_vip_on_leave TINYINT(1) NOT NULL DEFAULT 0,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            last_synced DATETIME DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS twitch_role_sync_members (
            guild_id VARCHAR(20) NOT NULL,
            discord_user_id VARCHAR(20) NOT NULL,
            twitch_user_id VARCHAR(20) NOT NULL,
            twitch_username VARCHAR(100) NOT NULL,
            is_vip TINYINT(1) NOT NULL DEFAULT 0,
            is_mod TINYINT(1) NOT NULL DEFAULT 0,
            is_sub TINYINT(1) NOT NULL DEFAULT 0,
            last_synced DATETIME DEFAULT NULL,
            PRIMARY KEY (guild_id, discord_user_id),
            INDEX idx_twitch_id (twitch_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS twitch_role_sync_members');
    await db.execute('DROP TABLE IF EXISTS twitch_role_sync_config');
}
