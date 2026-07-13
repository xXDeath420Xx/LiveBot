export async function up(pool) {
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS orientation_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            channel_id VARCHAR(20),
            message_id VARCHAR(20),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);
    console.log('[Migration 050] orientation_config table created');
}

export async function down(pool) {
    await pool.execute('DROP TABLE IF EXISTS orientation_config');
    console.log('[Migration 050] orientation_config table dropped');
}
