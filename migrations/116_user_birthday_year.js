/**
 * Migration 116 — add optional birth year to user_birthdays.
 * Nullable so year stays optional; existing rows unaffected.
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
export async function up(db) {
    const [cols] = await db.execute(
        "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'user_birthdays' AND column_name = 'year'"
    );
    if (cols[0].n === 0) {
        await db.execute('ALTER TABLE user_birthdays ADD COLUMN year INT NULL AFTER day');
    }
}

export async function down(db) {
    await db.execute('ALTER TABLE user_birthdays DROP COLUMN year').catch(() => {});
}
