/**
 * Migration 120: Phishing detection — image OCR scanning toggle
 *
 * Adds a per-guild flag that gates OCR-based scam-image scanning. DEFAULT 1 so
 * every guild already opted into phishing detection gets image scanning; can be
 * turned off per guild. Idempotent (column-existence check).
 */
async function columnExists(db, table, column) {
    const allowedTables = new Set(['phishing_config']);
    const allowedColumns = new Set(['scan_images']);
    if (!allowedTables.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
    if (!allowedColumns.has(column)) throw new Error(`Refusing to inspect unknown column: ${column}`);
    const [rows] = await db.execute(
        `SELECT COUNT(*) AS n FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = '${column}'`
    );
    return rows[0].n > 0;
}

export async function up(db) {
    if (!(await columnExists(db, 'phishing_config', 'scan_images'))) {
        await db.execute(
            'ALTER TABLE phishing_config ADD COLUMN scan_images TINYINT(1) NOT NULL DEFAULT 1 AFTER log_detections'
        );
    }
}

export async function down(db) {
    if (await columnExists(db, 'phishing_config', 'scan_images')) {
        await db.execute('ALTER TABLE phishing_config DROP COLUMN scan_images');
    }
}
