/**
 * Wave 417 — holiday "post on the day" de-dupe record.
 *
 * jobs/holiday-day-announcer.js posts "Today is <holiday>!" once on the holiday's date (in the
 * server's timezone) for holiday_countdowns rows with announce_on_day = 1 and a channel set. To
 * make that exactly-once across restarts it claims the row by writing the holiday's year here
 * before sending; a row whose value already equals this year is skipped.
 *
 *   holiday_countdowns.last_announced_year  SMALLINT UNSIGNED NULL   year last posted (NULL = never)
 *
 * The job posts nothing until this column exists. Apply directly: import { up } and call up(pool).
 */
async function hasColumn(pool, table, column) {
    const [rows] = await pool.query(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

export async function up(pool) {
    if (!(await hasColumn(pool, 'holiday_countdowns', 'last_announced_year'))) {
        await pool.query(`ALTER TABLE holiday_countdowns
            ADD COLUMN last_announced_year SMALLINT UNSIGNED NULL DEFAULT NULL AFTER label_override`);
    }
}

export async function down(pool) {
    if (await hasColumn(pool, 'holiday_countdowns', 'last_announced_year')) {
        await pool.query('ALTER TABLE holiday_countdowns DROP COLUMN last_announced_year');
    }
}
