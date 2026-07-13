/**
 * Migration 084: Twitch schedule sync — configurable interval and weekly refresh
 *
 * Adds per-sync fields:
 *   - sync_interval_minutes: minimum minutes between sync attempts (default 360 = 6 hours)
 *   - weekly_refresh: toggle to delete old embed and post fresh one every 7 days
 *   - last_weekly_refresh: timestamp of the most recent fresh post
 */
export async function up(db) {
    // Check existing columns to make this idempotent
    const [cols] = await db.execute(`
        SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'twitch_schedule_sync_config'
    `);
    const existing = new Set(cols.map(c => c.COLUMN_NAME));

    if (!existing.has('sync_interval_minutes')) {
        await db.execute(`
            ALTER TABLE twitch_schedule_sync_config
            ADD COLUMN sync_interval_minutes INT NOT NULL DEFAULT 360 AFTER is_enabled
        `);
    }

    if (!existing.has('weekly_refresh')) {
        await db.execute(`
            ALTER TABLE twitch_schedule_sync_config
            ADD COLUMN weekly_refresh TINYINT(1) NOT NULL DEFAULT 0 AFTER sync_interval_minutes
        `);
    }

    if (!existing.has('last_weekly_refresh')) {
        await db.execute(`
            ALTER TABLE twitch_schedule_sync_config
            ADD COLUMN last_weekly_refresh DATETIME NULL AFTER weekly_refresh
        `);
    }
}

export async function down(db) {
    await db.execute(`ALTER TABLE twitch_schedule_sync_config DROP COLUMN IF EXISTS last_weekly_refresh`).catch(() => {});
    await db.execute(`ALTER TABLE twitch_schedule_sync_config DROP COLUMN IF EXISTS weekly_refresh`).catch(() => {});
    await db.execute(`ALTER TABLE twitch_schedule_sync_config DROP COLUMN IF EXISTS sync_interval_minutes`).catch(() => {});
}
