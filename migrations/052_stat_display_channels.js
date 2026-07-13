/**
 * Migration 052: Stat display channels
 * Voice channels that show live server stats (member count, bots, etc.)
 */

export async function up(pool) {
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS stat_display_channels (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            stat_type ENUM('members', 'humans', 'bots', 'online', 'channels', 'roles', 'boosts') NOT NULL,
            template VARCHAR(100) NOT NULL DEFAULT '{stat_name}: {value}',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_guild_channel (guild_id, channel_id),
            UNIQUE KEY unique_guild_stat (guild_id, stat_type)
        )
    `);
}

export async function down(pool) {
    await pool.execute('DROP TABLE IF EXISTS stat_display_channels');
}
