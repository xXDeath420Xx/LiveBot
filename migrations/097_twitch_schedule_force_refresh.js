/**
 * Migration 097: One-shot force-refresh flag for Twitch schedule syncs
 *
 * Adds:
 *   - force_refresh TINYINT(1) NOT NULL DEFAULT 0
 *
 * When set to 1, the next cron tick of `processAllSyncs` will re-render and
 * edit-in-place the posted schedule message regardless of the per-sync
 * interval and the 10-minute change-cooldown. The flag self-clears on
 * successful post/edit. Operators set this flag (UPDATE ... SET
 * force_refresh = 1) whenever the renderer changes and existing posted
 * images need to pick up the new layout — e.g. after migrations 095/096
 * landed timezone-aware rendering and the weekly view.
 */

async function hasColumn(db, column) {
    const allowed = new Set(['force_refresh']);
    if (!allowed.has(column)) {
        throw new Error(`Refusing to inspect unknown column: ${column}`);
    }
    const [cols] = await db.execute(
        `SHOW COLUMNS FROM twitch_schedule_sync_config LIKE '${column}'`
    );
    return cols.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'force_refresh'))) {
        await db.execute(`
            ALTER TABLE twitch_schedule_sync_config
            ADD COLUMN force_refresh TINYINT(1) NOT NULL DEFAULT 0
            COMMENT 'When 1, next cron tick re-renders the posted image bypassing interval+cooldown; auto-cleared on success'
        `);
    }
    console.log('[Migration 097] Added force_refresh to twitch_schedule_sync_config');
}

export async function down(db) {
    if (await hasColumn(db, 'force_refresh')) {
        await db.execute(`ALTER TABLE twitch_schedule_sync_config DROP COLUMN force_refresh`);
    }
    console.log('[Migration 097] Rolled back - force_refresh column dropped');
}
