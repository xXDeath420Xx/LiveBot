/**
 * Migration 087: OwO-Style Module Tables
 *
 * Creates (integrates with existing economy + leveling systems):
 *   - owo_config: per-guild on/off toggle (OFF BY DEFAULT)
 *   - owo_zoo: per-guild animal inventory (unique to this module)
 *   - owo_cooldowns: per-user-per-command cooldown tracking
 *
 * Currency + XP rewards flow through core/economy-manager.js and
 * core/leveling-manager.js respectively — no separate OwO wallet.
 *
 * See /LICENSE-OWO-NOTICE.md for attribution and licensing scope.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS owo_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            enabled TINYINT(1) NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Zoo is per-guild so Mama Bear's Lair vs The Pac each have their own
    // collection progression. Users chasing level roles per guild see their
    // zoo tied to that progression.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS owo_zoo (
            guild_id VARCHAR(20) NOT NULL,
            user_id VARCHAR(20) NOT NULL,
            animal_key VARCHAR(64) NOT NULL,
            rank VARCHAR(32) NOT NULL,
            count INT UNSIGNED NOT NULL DEFAULT 1,
            first_caught TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_caught TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, user_id, animal_key),
            INDEX idx_rank (guild_id, user_id, rank),
            INDEX idx_leaderboard (guild_id, count DESC)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS owo_cooldowns (
            guild_id VARCHAR(20) NOT NULL,
            user_id VARCHAR(20) NOT NULL,
            command VARCHAR(32) NOT NULL,
            used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, user_id, command)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS owo_cooldowns');
    await db.execute('DROP TABLE IF EXISTS owo_zoo');
    await db.execute('DROP TABLE IF EXISTS owo_config');
}
