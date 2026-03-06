/**
 * Migration 046: Add live_role_id to guild_streamer_auto_track
 *
 * Allows per-mapping live role configuration for auto-tracked streamers.
 * When set, auto-created subscriptions inherit this role instead of the guild default.
 */
export async function up(pool) {
    await pool.execute(`
        ALTER TABLE guild_streamer_auto_track
        ADD COLUMN live_role_id VARCHAR(20) DEFAULT NULL
        AFTER announcement_channel_id
    `);
}

export async function down(pool) {
    await pool.execute(`
        ALTER TABLE guild_streamer_auto_track
        DROP COLUMN live_role_id
    `);
}
