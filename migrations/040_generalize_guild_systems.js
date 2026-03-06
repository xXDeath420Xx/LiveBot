/**
 * Migration 040: Generalize Guild Systems
 *
 * - Creates self_promo_config table (config-driven self-promo per guild)
 * - Adds edit_on_end column to subscriptions and live_announcements
 * - Seeds existing ReeferRealm self-promo config
 * - Sets edit_on_end=1 on ReeferRealm self-promo subscriptions
 */

export async function up(db) {
    // 1. Create self_promo_config table
    await db.execute(`
        CREATE TABLE IF NOT EXISTS self_promo_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            enabled TINYINT(1) DEFAULT 0,
            channel_id VARCHAR(20),
            allowed_platforms JSON,
            auto_subscribe TINYINT(1) DEFAULT 1,
            delete_invalid TINYINT(1) DEFAULT 1,
            dm_on_track TINYINT(1) DEFAULT 1,
            dm_on_already_tracked TINYINT(1) DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 2. Add edit_on_end to subscriptions
    await db.execute(`
        ALTER TABLE subscriptions ADD COLUMN edit_on_end TINYINT(1) DEFAULT 0 AFTER delete_on_end
    `);

    // 3. Add edit_on_end to live_announcements
    await db.execute(`
        ALTER TABLE live_announcements ADD COLUMN edit_on_end TINYINT(1) DEFAULT 0
    `);

    // 4. Seed ReeferRealm self-promo config
    await db.execute(`
        INSERT IGNORE INTO self_promo_config (guild_id, enabled, channel_id, allowed_platforms)
        VALUES ('985116833193553930', 1, '1474951572914966618', '["twitch","kick","youtube"]')
    `);

    // 5. Set edit_on_end=1 on ReeferRealm self-promo subscriptions
    await db.execute(`
        UPDATE subscriptions SET edit_on_end = 1
        WHERE guild_id = '985116833193553930'
          AND announcement_channel_id = '1474951572914966618'
    `);

    console.log('[Migration 040] Generalized guild systems - self_promo_config created, edit_on_end added');
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS self_promo_config');
    await db.execute('ALTER TABLE subscriptions DROP COLUMN edit_on_end');
    await db.execute('ALTER TABLE live_announcements DROP COLUMN edit_on_end');
    console.log('[Migration 040] Rolled back - self_promo_config dropped, edit_on_end removed');
}
