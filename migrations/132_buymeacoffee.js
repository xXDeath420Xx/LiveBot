/**
 * Migration 132: Buy Me a Coffee integration
 *
 * One lean table `bmc_config`. One BMC account (read-only API key in env
 * BMC_API_KEY) but each configured guild announces independently via its own
 * per-type high-water-marks (last_*_id). Optional per-guild encrypted api_key
 * overrides the env key.
 *
 * Applied directly (NOT via migrations/run.js).
 */

export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS bmc_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            channel_id VARCHAR(20) NULL,
            enabled TINYINT(1) DEFAULT 1,
            api_key TEXT NULL,
            show_amounts TINYINT(1) DEFAULT 1,
            show_names TINYINT(1) DEFAULT 1,
            embed_color VARCHAR(7) DEFAULT '#FFDD00',
            last_support_id BIGINT DEFAULT 0,
            last_subscription_id BIGINT DEFAULT 0,
            last_extra_id BIGINT DEFAULT 0,
            set_by VARCHAR(20) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS bmc_config');
}
