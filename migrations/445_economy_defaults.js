/**
 * Migration 445 — economy_config column defaults match the economy's one set of defaults (register H-668).
 *
 * core/economy-manager.js ECONOMY_DEFAULTS is what /economy uses on a server that never saved the Economy
 * page, and what that page shows. The table disagreed in two places:
 *   - currency_emoji defaulted to a literal '?': the 💰 in the original migration was lost to the
 *     connection's character set. Rows holding that '?' (no one picks a bare question mark as a currency
 *     icon; the page has never offered it) get 💰 back.
 *   - enabled defaulted to 0, so a row created by any path that does not set it (the economy API's first
 *     save of a currency name did this) switched the economy off. An unsaved server counts as on, so 1.
 * The crime and rob column defaults already match (200-1000 at 60%, fine x0.5).
 *
 * The default is written as an ASCII expression (the bytes of 💰): MariaDB keeps a table's column
 * defaults in a 3-byte character set, so a literal 4-byte emoji there shows as '?' in SHOW CREATE TABLE
 * and is easy to lose again on the next ALTER.
 *
 * Idempotent: ALTER ... DEFAULT can run again; the update only touches '?' values.
 */
export async function up(db) {
    await db.query(`ALTER TABLE economy_config
        MODIFY currency_emoji VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        DEFAULT (CONVERT(X'F09F92B0' USING utf8mb4))`);
    await db.query("UPDATE economy_config SET currency_emoji = CONVERT(X'F09F92B0' USING utf8mb4) WHERE currency_emoji = '?'");
    await db.query('ALTER TABLE economy_config ALTER COLUMN enabled SET DEFAULT 1');
}

export async function down(db) {
    await db.query("ALTER TABLE economy_config ALTER COLUMN enabled SET DEFAULT 0");
}
