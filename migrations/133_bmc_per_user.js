/**
 * Migration 133: Buy Me a Coffee — per-USER multi-tenant redesign
 *
 * Replaces the old per-guild-single-account model (`bmc_config`) with a
 * Throne-style two-table split:
 *   - `bmc_user_links`  : user → their own BMC account (encrypted read-only key)
 *   - `bmc_announce`    : per-guild subscription → channel for a linked user
 *
 * ANY user in ANY guild links THEIR OWN BMC read-only API key, then announces
 * THEIR supporters in a channel.
 *
 * Applied directly (NOT via migrations/run.js).
 */

export async function up(db) {
    // Drop the old per-guild table (never used in prod)
    await db.execute('DROP TABLE IF EXISTS bmc_config');

    // user → BMC account (encrypted key + per-type high-water-marks)
    await db.execute(`
        CREATE TABLE IF NOT EXISTS bmc_user_links (
            user_id VARCHAR(20) PRIMARY KEY,
            api_key TEXT NOT NULL,
            account_id VARCHAR(50) NULL,
            last_support_id BIGINT DEFAULT 0,
            last_subscription_id BIGINT DEFAULT 0,
            last_extra_id BIGINT DEFAULT 0,
            linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // per-guild announce subscription (user announces in a channel of a guild)
    await db.execute(`
        CREATE TABLE IF NOT EXISTS bmc_announce (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id VARCHAR(20) NOT NULL,
            guild_id VARCHAR(20) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            enabled TINYINT(1) DEFAULT 1,
            show_amounts TINYINT(1) DEFAULT 1,
            show_names TINYINT(1) DEFAULT 1,
            embed_color VARCHAR(7) DEFAULT '#FFDD00',
            added_by VARCHAR(20) NULL,
            added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_user_guild (user_id, guild_id),
            INDEX idx_guild (guild_id),
            INDEX idx_enabled (enabled)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS bmc_announce');
    await db.execute('DROP TABLE IF EXISTS bmc_user_links');
}
