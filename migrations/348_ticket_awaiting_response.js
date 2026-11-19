/**
 * Migration 348 — Awaiting Response state for tickets + modmail (TicketsBot parity).
 *
 * Adds `last_staff_reply_at` and `last_user_reply_at` columns to both the tickets
 * table and modmail_threads. "Awaiting response" = user has replied since staff's
 * last reply. Mods can filter dashboard lists by this state to see which tickets
 * actually need their attention vs which are waiting on the user.
 *
 * Both columns backfilled to created_at so a ticket with no replies yet is
 * neither awaiting nor sent-to; the dashboard shows "no replies yet".
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
    for (const table of ['tickets', 'modmail_threads']) {
        if (!(await hasColumn(db, table, 'last_staff_reply_at'))) {
            await db.execute(`ALTER TABLE ${table} ADD COLUMN last_staff_reply_at TIMESTAMP NULL DEFAULT NULL`);
            console.log(`[migrate 348] ${table}.last_staff_reply_at added`);
        }
        if (!(await hasColumn(db, table, 'last_user_reply_at'))) {
            await db.execute(`ALTER TABLE ${table} ADD COLUMN last_user_reply_at TIMESTAMP NULL DEFAULT NULL`);
            console.log(`[migrate 348] ${table}.last_user_reply_at added`);
        }
    }
}
