/**
 * Migration 056: Default stream announcements to self-cleaning
 *
 * Changes delete_on_end default from 0 to 1 so stream announcements
 * are automatically deleted when streams go offline. Updates all
 * existing subscriptions and in-flight live_announcements.
 */

export async function up(pool) {
    // Flip all existing subscriptions to delete-on-end
    await pool.execute(
        `UPDATE subscriptions SET delete_on_end = 1 WHERE delete_on_end = 0`
    );

    // Change column default for future inserts
    await pool.execute(
        `ALTER TABLE subscriptions ALTER COLUMN delete_on_end SET DEFAULT 1`
    );

    // Update any in-flight live announcements that inherited the old default
    await pool.execute(
        `UPDATE live_announcements SET delete_on_end = 1 WHERE delete_on_end = 0`
    );
}

export async function down(pool) {
    // Revert column default to 0 — does NOT reset existing rows (destructive)
    await pool.execute(
        `ALTER TABLE subscriptions ALTER COLUMN delete_on_end SET DEFAULT 0`
    );

    await pool.execute(
        `ALTER TABLE live_announcements ALTER COLUMN delete_on_end SET DEFAULT 0`
    );
}
