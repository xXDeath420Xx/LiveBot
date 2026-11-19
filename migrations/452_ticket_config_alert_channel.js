/**
 * Migration 452 — a "New Ticket Opened" alert channel for the default ticket panel (register H-714).
 *
 * interactions/buttons/ticket_create.js posts the alert to the opening panel's alert_channel_id. Panels made
 * on the Tickets page keep it in ticket_panels.alert_channel_id (migration 045), which nothing could set until
 * now; the default panel (/support ticket setup, the Tickets page's "Default panel" form) reads ticket_config,
 * which had no such column, so its tickets could never alert. Idempotent: the column is added only when missing.
 */
async function hasColumn(db, table, column) {
    const [rows] = await db.query(
        `SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`, [table, column]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'ticket_config', 'alert_channel_id'))) {
        await db.query('ALTER TABLE ticket_config ADD COLUMN alert_channel_id VARCHAR(20) DEFAULT NULL AFTER log_channel_id');
    }
}

export async function down(db) {
    if (await hasColumn(db, 'ticket_config', 'alert_channel_id')) {
        await db.query('ALTER TABLE ticket_config DROP COLUMN alert_channel_id');
    }
}
