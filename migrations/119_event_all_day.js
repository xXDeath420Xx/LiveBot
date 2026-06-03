/**
 * Migration 119: Event schedule — all-day / time-TBD events
 *
 * Adds an `all_day` flag to `event_schedule_events` so a user can schedule an
 * event for a known date (or weekday) without committing to a time. A plain
 * datetime can't express "time unknown" — 00:00 is ambiguous with a real
 * midnight event — so the flag disambiguates.
 *
 *   all_day  TINYINT(1) NOT NULL DEFAULT 0
 *
 * When set, the event is stored spanning the full day (one-off: that date;
 * weekly: recur_start_min=0, recur_end_min=1440) and the board renders a
 * "Time TBD" label instead of a clock range. DEFAULT 0 leaves every existing
 * timed event untouched.
 *
 * Idempotent (column-existence check).
 */

async function columnExists(db, table, column) {
    const allowedTables = new Set(['event_schedule_events']);
    const allowedColumns = new Set(['all_day']);
    if (!allowedTables.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
    if (!allowedColumns.has(column)) throw new Error(`Refusing to inspect unknown column: ${column}`);
    const [rows] = await db.execute(
        `SELECT COUNT(*) AS n FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = '${column}'`
    );
    return rows[0].n > 0;
}

export async function up(db) {
    if (!(await columnExists(db, 'event_schedule_events', 'all_day'))) {
        await db.execute(
            'ALTER TABLE event_schedule_events ADD COLUMN all_day TINYINT(1) NOT NULL DEFAULT 0 AFTER recur_end_min'
        );
    }
}

export async function down(db) {
    if (await columnExists(db, 'event_schedule_events', 'all_day')) {
        await db.execute('ALTER TABLE event_schedule_events DROP COLUMN all_day');
    }
}
