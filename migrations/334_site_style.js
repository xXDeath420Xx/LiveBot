/*
 * Migration 334: site style (core/user-preferences.js STYLES).
 *
 *   user_preferences.site_style   NEW column. Which overall look a user chose for the site: 'cards' (the
 *                                 default), 'compact' or 'classic'. Separate from `theme`, which stays the
 *                                 colour scheme; every style combines with every theme. Existing rows get
 *                                 the default. Rendered onto <html data-style> by the dashboard.
 *
 * Writes: none beyond the column default. Idempotent; down() drops the column.
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

export const ADD_COLUMN = "ALTER TABLE user_preferences ADD COLUMN site_style VARCHAR(24) NOT NULL DEFAULT 'cards' AFTER dashboard_layout";
export const DROP_COLUMN = 'ALTER TABLE user_preferences DROP COLUMN site_style';

export async function up(db) {
    if (!(await hasColumn(db, 'user_preferences', 'site_style'))) await db.execute(ADD_COLUMN);
}

export async function down(db) {
    if (await hasColumn(db, 'user_preferences', 'site_style')) await db.execute(DROP_COLUMN);
}

export default { up, down };
