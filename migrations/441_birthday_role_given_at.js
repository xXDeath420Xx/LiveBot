/**
 * Migration 441 — the birthday role is held for 24 hours from when it was given (register H-664).
 *
 * user_birthdays.birthday_role_given_at is set when the announcement gives the role, and
 * jobs/birthday-scheduler.js takes the role back once it is 24 hours old, then clears the column.
 * Before this the hourly cleanup took it back when the UTC date changed, about 19 to 20 hours after
 * the midnight New York announcement. Rows from before the column keep that old rule (NULL = no time).
 *
 * Idempotent: the column is added only when missing.
 */
export async function up(db) {
    const [col] = await db.query(
        `SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_birthdays' AND COLUMN_NAME = 'birthday_role_given_at' LIMIT 1`);
    if (!col.length) {
        await db.query('ALTER TABLE user_birthdays ADD COLUMN birthday_role_given_at DATETIME NULL DEFAULT NULL AFTER last_announced');
    }
}

export async function down(db) {
    const [col] = await db.query(
        `SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_birthdays' AND COLUMN_NAME = 'birthday_role_given_at' LIMIT 1`);
    if (col.length) await db.query('ALTER TABLE user_birthdays DROP COLUMN birthday_role_given_at');
}
