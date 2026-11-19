/**
 * Migration 434 — why a Twitch schedule sync is paused (H-312).
 *
 * A sync whose Discord channel was deleted kept running and warning every tick forever (513 times in
 * 48 h for one sync) and nobody was told. core/twitch-schedule-manager.js now pauses it:
 *   paused_reason  'channel_deleted' (the server picks a new channel on the Twitch Schedules page)
 *                  or 'guild_left' (no bot of ours is in the server; resumes if one comes back)
 *   paused_at      when it was paused
 * A paused sync also has is_enabled = 0. Picking a new channel on the dashboard clears both.
 * Idempotent: each column is added only if missing.
 */
export async function up(db) {
    const [reason] = await db.query("SHOW COLUMNS FROM twitch_schedule_sync_config LIKE 'paused_reason'");
    if (!reason.length) {
        await db.query('ALTER TABLE twitch_schedule_sync_config ADD COLUMN paused_reason VARCHAR(32) NULL DEFAULT NULL AFTER is_enabled');
    }
    const [at] = await db.query("SHOW COLUMNS FROM twitch_schedule_sync_config LIKE 'paused_at'");
    if (!at.length) {
        await db.query('ALTER TABLE twitch_schedule_sync_config ADD COLUMN paused_at DATETIME NULL DEFAULT NULL AFTER paused_reason');
    }
}

export async function down(db) {
    const [at] = await db.query("SHOW COLUMNS FROM twitch_schedule_sync_config LIKE 'paused_at'");
    if (at.length) await db.query('ALTER TABLE twitch_schedule_sync_config DROP COLUMN paused_at');
    const [reason] = await db.query("SHOW COLUMNS FROM twitch_schedule_sync_config LIKE 'paused_reason'");
    if (reason.length) await db.query('ALTER TABLE twitch_schedule_sync_config DROP COLUMN paused_reason');
}
