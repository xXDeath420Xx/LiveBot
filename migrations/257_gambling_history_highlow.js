/*
 * Migration 257: gambling_history.game_type learns 'highlow'.
 *
 * /economy gamble highlow (core/gambling-manager.js playHighLow) logs game_type 'highlow', which the
 * enum never had. The wallet UPDATE had already run, so the INSERT failed after the player's balance
 * changed: they saw an error, no history row and no economy_transactions row was written.
 *
 * Every game_type the code passes to logGamble (all callers are in core/gambling-manager.js):
 *   coinflip, dice, slots, blackjack, roulette, highlow
 * 'crash' is kept — it was already in the enum and dropping a value is never done here.
 *
 * Widen-only and idempotent: skipped when 'highlow' is already allowed.
 */
const GAME_TYPES = ['coinflip', 'dice', 'slots', 'blackjack', 'roulette', 'crash', 'highlow'];

export async function up(db) {
    const [[col]] = await db.execute(
        `SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gambling_history' AND COLUMN_NAME = 'game_type'`
    );
    if (!col) return; // table not present on this database
    if (col.type.includes("'highlow'")) return;

    // Keep any value the live enum has that this list doesn't know about (never narrow)
    const existing = [...col.type.matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"));
    const values = [...new Set([...existing, ...GAME_TYPES])];
    const enumSql = values.map(v => `'${v.replace(/'/g, "''")}'`).join(',');

    await db.execute(`ALTER TABLE gambling_history MODIFY game_type ENUM(${enumSql}) NOT NULL`);
}

// eslint-disable-next-line no-unused-vars
export async function down(db) {
    // Intentionally a no-op: narrowing the enum would break rows already logged as 'highlow'.
}
