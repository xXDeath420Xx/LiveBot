export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS imagine_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            enabled TINYINT(1) DEFAULT 1,
            allowed_channel_id VARCHAR(20) DEFAULT NULL,
            cooldown_seconds INT DEFAULT 15,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS imagine_config');
}
