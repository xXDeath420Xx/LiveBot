/**
 * Migration 346 — widen throne_seen_gifts.gift_name.
 *
 * Amazon product names routinely exceed 255 characters (one hit was 419 chars
 * and silently stalled karabi420 notifications). PK is (throne_username,
 * gift_id), gift_name is unindexed, so widening is cheap.
 *
 * Idempotent.
 */
export async function up(db) {
    const [[row]] = await db.execute(
        `SELECT CHARACTER_MAXIMUM_LENGTH AS len
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'throne_seen_gifts'
            AND COLUMN_NAME = 'gift_name'`);
    if (!row || row.len >= 600) {
        console.log(`[migrate 346] throne_seen_gifts.gift_name already ${row?.len || 'unknown'} chars — skipping`);
        return;
    }
    await db.execute(`ALTER TABLE throne_seen_gifts MODIFY gift_name VARCHAR(600) NULL`);
    console.log(`[migrate 346] widened throne_seen_gifts.gift_name from ${row.len} -> 600 chars`);
}
