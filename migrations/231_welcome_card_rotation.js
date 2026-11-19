/*
 * Rotating welcome card designs.
 *
 * A server that likes more than one card had to pick one anyway. This lets a guild
 * enable a pool of designs and deal them out as people join.
 *
 * The bag is persisted rather than held in memory because joins are rare and restarts
 * are not: an in-memory bag resets on every deploy, which in a quiet server means the
 * same design lands again and again and the rotation looks broken.
 *
 * card_rotation defaults to 'fixed', so every existing guild keeps the single card it
 * already has.
 */

export async function up(db) {
    const [cols] = await db.execute(
        `SELECT COLUMN_NAME FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'welcome_settings'
            AND COLUMN_NAME IN ('card_pool', 'card_rotation')`
    );
    const have = new Set(cols.map((c) => c.COLUMN_NAME));

    if (!have.has('card_pool')) {
        await db.execute(
            `ALTER TABLE welcome_settings ADD COLUMN card_pool TEXT DEFAULT NULL AFTER card_style`
        );
    }
    if (!have.has('card_rotation')) {
        await db.execute(
            `ALTER TABLE welcome_settings
               ADD COLUMN card_rotation VARCHAR(16) NOT NULL DEFAULT 'fixed' AFTER card_pool`
        );
    }

    await db.execute(`
        CREATE TABLE IF NOT EXISTS welcome_card_bag (
            guild_id VARCHAR(20) NOT NULL PRIMARY KEY,
            remaining TEXT DEFAULT NULL,
            last_key VARCHAR(64) DEFAULT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS welcome_card_bag');
    await db.execute('ALTER TABLE welcome_settings DROP COLUMN card_rotation');
    await db.execute('ALTER TABLE welcome_settings DROP COLUMN card_pool');
}
