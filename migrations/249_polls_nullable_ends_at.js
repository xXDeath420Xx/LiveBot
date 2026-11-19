/*
 * polls.ends_at becomes nullable: NULL means "no time limit".
 *
 * It was TIMESTAMP NOT NULL, so a poll created without a duration had its NULL coerced to
 * NOW() and the minute scheduler ended it straight away. The scheduler already treats NULL
 * as open-ended (`ends_at IS NOT NULL AND ends_at <= NOW()`).
 */
export async function up(db) {
    const [[col]] = await db.execute("SHOW COLUMNS FROM polls LIKE 'ends_at'");
    if (col && col.Null !== 'YES') {
        await db.execute('ALTER TABLE polls MODIFY ends_at TIMESTAMP NULL DEFAULT NULL');
    }
}
