/**
 * Migration 096: Twitch schedule sync view-mode toggle
 *
 * Adds:
 *   - view_mode ENUM('monthly','weekly') NOT NULL DEFAULT 'monthly'
 *
 * Lets each guild render either a full-month grid (existing behaviour, the
 * default for every existing row) or a 7-day weekly view of the Twitch
 * schedule image posted to its schedule channel.
 */

async function hasColumn(db, column) {
    const allowed = new Set(['view_mode']);
    if (!allowed.has(column)) {
        throw new Error(`Refusing to inspect unknown column: ${column}`);
    }
    const [cols] = await db.execute(
        `SHOW COLUMNS FROM twitch_schedule_sync_config LIKE '${column}'`
    );
    return cols.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'view_mode'))) {
        await db.execute(`
            ALTER TABLE twitch_schedule_sync_config
            ADD COLUMN view_mode ENUM('monthly','weekly') NOT NULL DEFAULT 'monthly'
            COMMENT 'Calendar layout — full-month grid or 7-day weekly view'
        `);
    }
    console.log('[Migration 096] Added view_mode to twitch_schedule_sync_config');
}

export async function down(db) {
    if (await hasColumn(db, 'view_mode')) {
        await db.execute(`ALTER TABLE twitch_schedule_sync_config DROP COLUMN view_mode`);
    }
    console.log('[Migration 096] Rolled back - view_mode column dropped');
}
