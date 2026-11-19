/**
 * Migration 356 - drop counting_channels.allow_same_user.
 *
 * The counting game has one rule: a user cannot post two numbers in a row.
 * The old per-channel toggle let takeover-manager silently flip the rule off,
 * which allowed a single user to grind the count by themselves (incident on
 * guild 729650115844898817 channel 1528196433239478343, 2026-10-15).
 *
 * The toggle is now ripped out of code; this drops the column so future code
 * paths cannot re-introduce it by accident.
 *
 * Idempotent.
 */
async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

export async function up(db) {
    if (await hasColumn(db, 'counting_channels', 'allow_same_user')) {
        await db.execute('ALTER TABLE counting_channels DROP COLUMN allow_same_user');
        console.log('[migrate 356] counting_channels.allow_same_user dropped');
    } else {
        console.log('[migrate 356] counting_channels.allow_same_user already absent');
    }
}
