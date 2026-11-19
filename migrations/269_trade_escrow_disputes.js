/*
 * Migration 269: trade escrow — dispute and staff-resolution fields for /engage trade.
 *
 * /engage trade create|confirm|dispute|resolve wrote columns that did not exist, so no trade could be
 * created. The code now uses the existing columns: item_description = what the creator offers,
 * agreed_price = what the partner offers, notes = extra details, seller_confirmed / buyer_confirmed for
 * confirmations (status keeps its own lifecycle values), plus a generated trade_id reference.
 *
 * This adds what the dispute → resolve flow collects and no column holds:
 *   dispute_reason     the reason given with /engage trade dispute
 *   resolved_by        staff member who ran /engage trade resolve
 *   resolution_notes   the chosen resolution and staff notes
 * and widens agreed_price from VARCHAR(100) to VARCHAR(1000): it now holds the partner's side of the
 * trade ("what are they offering?"), which is item text rather than a short price. 1000 keeps it inside
 * a Discord embed field.
 *
 * trade_escrow was empty when this was written.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */

async function addColumn(db, column, definition) {
    const [rows] = await db.execute(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trade_escrow' AND COLUMN_NAME = ?`,
        [column]
    );
    if (!rows.length) {
        await db.execute(`ALTER TABLE trade_escrow ADD COLUMN ${column} ${definition}`);
    }
}

export async function up(db) {
    await addColumn(db, 'dispute_reason',
        'TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL AFTER notes');
    await addColumn(db, 'resolved_by',
        'VARCHAR(20) NULL AFTER dispute_reason');
    await addColumn(db, 'resolution_notes',
        'TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL AFTER resolved_by');

    const [[price]] = await db.execute(
        `SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trade_escrow' AND COLUMN_NAME = 'agreed_price'`
    );
    if (price && Number(price.len) < 1000) {
        await db.execute(
            `ALTER TABLE trade_escrow MODIFY COLUMN agreed_price
                VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL`
        );
    }
}

export async function down(db) {
    await db.execute('ALTER TABLE trade_escrow DROP COLUMN dispute_reason').catch(() => {});
    await db.execute('ALTER TABLE trade_escrow DROP COLUMN resolved_by').catch(() => {});
    await db.execute('ALTER TABLE trade_escrow DROP COLUMN resolution_notes').catch(() => {});
    // agreed_price stays VARCHAR(1000): shrinking it could truncate stored trades.
}
