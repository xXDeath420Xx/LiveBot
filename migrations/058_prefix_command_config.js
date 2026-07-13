export async function up(db) {
    // Core config: prefix, enabled, disabled commands per guild
    await db.execute(`
        CREATE TABLE IF NOT EXISTS prefix_command_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            prefix VARCHAR(5) NOT NULL DEFAULT '!',
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            disabled_commands JSON DEFAULT NULL
        )
    `);

    // Per-guild custom aliases: guild admins can add/rename/remove aliases
    // e.g., guild wants "!s" to mean "!stop" instead of "!skip"
    await db.execute(`
        CREATE TABLE IF NOT EXISTS prefix_command_aliases (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            alias VARCHAR(30) NOT NULL,
            command_name VARCHAR(50) NOT NULL,
            created_by VARCHAR(20) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_guild_alias (guild_id, alias),
            INDEX idx_guild (guild_id)
        )
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS prefix_command_aliases');
    await db.execute('DROP TABLE IF EXISTS prefix_command_config');
}
