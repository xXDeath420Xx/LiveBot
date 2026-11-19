/*
 * `twitch_schedule_sync_config.panel_regions_json` — cached Gemini Vision
 * output for an uploaded schedule poster. One envelope per sync config:
 *   { sourceUrl, detectedAt, regions: { width, height, title, panels[], footer } }
 *
 * The renderer uses `regions` to write THIS WEEK'S schedule text into the
 * panels the owner already drew. Keyed on sourceUrl so swapping the uploaded
 * image invalidates the cache automatically on the next sync.
 */
async function columnExists(db, table, col) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
        [table, col]
    );
    return rows.length > 0;
}

export async function up(db) {
    if (!(await columnExists(db, 'twitch_schedule_sync_config', 'panel_regions_json'))) {
        await db.execute(
            `ALTER TABLE twitch_schedule_sync_config
             ADD COLUMN panel_regions_json LONGTEXT NULL AFTER background_cache_url`
        );
    }
}

export async function down(db) {
    if (await columnExists(db, 'twitch_schedule_sync_config', 'panel_regions_json')) {
        await db.execute(`ALTER TABLE twitch_schedule_sync_config DROP COLUMN panel_regions_json`);
    }
}
