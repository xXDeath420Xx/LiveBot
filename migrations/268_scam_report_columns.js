/*
 * Migration 268: scam reports + scammer watchlist — the fields /engage report collects.
 *
 * /engage report scammer|vendor|review|check|list wrote columns that did not exist, so no report could
 * be filed and nothing ever reached the watchlist. The code now uses the existing columns
 * (reported_username, entity_name, report_type 'user'/'seedbank', entity_type, user_id, username,
 * added_by, report_count). This adds only what the forms collect and no column holds:
 *
 *   scam_reports.scam_type        the "type of scam" choice (fake_seeds, payment_scam, trade_scam, …).
 *                                 report_type says WHAT was reported (user / seedbank); this says HOW.
 *   scam_reports.website          vendor reports: the vendor's website
 *   scam_reports.loss_amount      "Amount lost" from the report modal (free text, e.g. "$50, 10 seeds")
 *   scammer_watchlist.website     vendor entries: website shown by /engage report list and check
 *   scammer_watchlist.report_id   the scam_reports row whose confirmation last added/updated the entry
 *
 * Both tables were empty when this was written.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */

async function addColumn(db, table, column, definition) {
    const [rows] = await db.execute(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    if (!rows.length) {
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

export async function up(db) {
    await addColumn(db, 'scam_reports', 'scam_type',
        'VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL AFTER report_type');
    await addColumn(db, 'scam_reports', 'website',
        'VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL AFTER entity_name');
    await addColumn(db, 'scam_reports', 'loss_amount',
        'VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL AFTER evidence_urls');

    await addColumn(db, 'scammer_watchlist', 'website',
        'VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL AFTER entity_name');
    await addColumn(db, 'scammer_watchlist', 'report_id',
        'INT(11) NULL AFTER added_by');
}

export async function down(db) {
    await db.execute('ALTER TABLE scam_reports DROP COLUMN scam_type').catch(() => {});
    await db.execute('ALTER TABLE scam_reports DROP COLUMN website').catch(() => {});
    await db.execute('ALTER TABLE scam_reports DROP COLUMN loss_amount').catch(() => {});
    await db.execute('ALTER TABLE scammer_watchlist DROP COLUMN website').catch(() => {});
    await db.execute('ALTER TABLE scammer_watchlist DROP COLUMN report_id').catch(() => {});
}
