/**
 * Wave 382 — Normalize `twitch_clips_catalog` and `twitch_broadcaster_backfill`
 * from `utf8mb4_general_ci` to `utf8mb4_unicode_ci` so correlated subqueries
 * against them stop raising ER_CANT_AGGREGATE_2COLLATIONS.
 *
 * Fixes a dashboard-level recurrence (compare page 500s); the rest of the
 * twitch_* family is already unicode_ci. Both tables are small (345 + 5 rows
 * at migration time) and FK-free, so the ALTER completes in milliseconds.
 */
export async function up(pool) {
    await pool.query(`
        ALTER TABLE twitch_clips_catalog
        CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await pool.query(`
        ALTER TABLE twitch_broadcaster_backfill
        CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
}

export async function down(pool) {
    await pool.query(`
        ALTER TABLE twitch_clips_catalog
        CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
    `);
    await pool.query(`
        ALTER TABLE twitch_broadcaster_backfill
        CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
    `);
}
