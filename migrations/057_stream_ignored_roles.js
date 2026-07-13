/**
 * Migration 057: Add stream ignored roles
 *
 * Adds stream_ignored_roles column to guilds table.
 * Stores a JSON array of role IDs whose members should be
 * silently skipped for stream announcements (opt-out).
 */

export async function up(pool) {
    await pool.execute(
        `ALTER TABLE guilds ADD COLUMN stream_ignored_roles TEXT DEFAULT NULL`
    );
}

export async function down(pool) {
    await pool.execute(
        `ALTER TABLE guilds DROP COLUMN stream_ignored_roles`
    );
}
