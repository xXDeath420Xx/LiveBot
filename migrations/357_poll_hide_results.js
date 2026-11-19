/**
 * Migration 357 - polls.hide_results.
 *
 * Adds the "hide tallies until the poll ends" option. When set, voters see
 * the question and options but no counts, percentages or progress bars until
 * the poll is ended (automatically on timer or manually by a moderator).
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
    if (await hasColumn(db, 'polls', 'hide_results')) {
        console.log('[migrate 357] polls.hide_results already present');
        return;
    }
    await db.execute('ALTER TABLE polls ADD COLUMN hide_results TINYINT(1) NOT NULL DEFAULT 0 AFTER anonymous');
    console.log('[migrate 357] polls.hide_results added');
}
