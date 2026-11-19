/*
 * Migration 262: collectible cards — card_collection + card_energy.
 *
 * WHY
 * ---
 * `/fun games cardpull`, `/fun games collection` and `/fun games trade`
 * (commands/fun/entertainment-handlers.js) read and write these two tables, which never existed in
 * the live database. cardpull tried to create them inline on every call, but collection/trade
 * failed outright for anyone who had not pulled first. The schema now lives here (the inline
 * CREATE TABLE statements were removed), matching exactly what the handlers use:
 *
 *   card_collection  one row per pulled card; `id` is the "Card ID" users pass to trade.
 *                    Read by (guild_id, user_id) ordered by power, and by (id, guild_id, user_id).
 *   card_energy      one row per (guild_id, user_id): pull energy 0-10, refilled 1 per hour
 *                    counted from last_refill.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS.
 */

export async function up(db) {
    await db.execute(`CREATE TABLE IF NOT EXISTS card_collection (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        guild_id      VARCHAR(20) NOT NULL,
        user_id       VARCHAR(20) NOT NULL,
        card_name     VARCHAR(255) NOT NULL,
        card_type     VARCHAR(50) NOT NULL,
        rarity        VARCHAR(20) NOT NULL,
        power         INT NOT NULL,
        description   TEXT NULL,
        collected_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_user_cards (guild_id, user_id, power)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await db.execute(`CREATE TABLE IF NOT EXISTS card_energy (
        guild_id     VARCHAR(20) NOT NULL,
        user_id      VARCHAR(20) NOT NULL,
        energy       INT NOT NULL DEFAULT 10,
        last_refill  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS card_energy');
    await db.execute('DROP TABLE IF EXISTS card_collection');
}
