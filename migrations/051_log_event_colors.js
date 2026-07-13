/**
 * Migration 051: Log Event Embed Colors
 *
 * Adds embed_color column to log_event_config so admins can customize
 * the color of log embeds per event type (e.g. #ED4245 for red).
 * NULL = use the hardcoded default color.
 */
export async function up(pool) {
    await pool.execute(`
        ALTER TABLE log_event_config
        ADD COLUMN embed_color VARCHAR(7) DEFAULT NULL
    `);
    console.log('[Migration 051] Added embed_color column to log_event_config');
}

export async function down(pool) {
    await pool.execute(`
        ALTER TABLE log_event_config
        DROP COLUMN embed_color
    `);
    console.log('[Migration 051] Removed embed_color column from log_event_config');
}
