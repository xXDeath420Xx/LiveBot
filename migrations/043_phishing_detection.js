/**
 * Migration 043: Anti-Phishing Link Detection System
 *
 * Creates tables for:
 * - phishing_domains: global cache of known phishing domains (auto-synced from community lists)
 * - phishing_config: per-guild settings (action, alert channel, whitelist)
 * - phishing_detections: log of detected phishing attempts
 */
export async function up(pool) {
    // Global domain cache
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS phishing_domains (
            domain VARCHAR(255) PRIMARY KEY,
            source ENUM('discord-phishing-links', 'phishing-database', 'manual') NOT NULL,
            added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Per-guild config
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS phishing_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            enabled TINYINT(1) DEFAULT 1,
            action ENUM('delete', 'warn', 'mute', 'kick', 'ban') DEFAULT 'delete',
            mute_duration_minutes INT DEFAULT 30,
            alert_channel_id VARCHAR(20),
            whitelist_domains TEXT,
            log_detections TINYINT(1) DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);

    // Detection log
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS phishing_detections (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            user_id VARCHAR(20) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            matched_domain VARCHAR(255) NOT NULL,
            matched_url TEXT,
            source VARCHAR(50),
            action_taken VARCHAR(50),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_guild_date (guild_id, created_at)
        )
    `);
}

export async function down(pool) {
    await pool.execute('DROP TABLE IF EXISTS phishing_detections');
    await pool.execute('DROP TABLE IF EXISTS phishing_config');
    await pool.execute('DROP TABLE IF EXISTS phishing_domains');
}
