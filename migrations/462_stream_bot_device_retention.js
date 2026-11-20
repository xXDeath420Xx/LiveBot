/*
 * Migration 462 (fix wave 3, 2026-11-19): two data_retention_policy rows, enforced by jobs/retention-sweeper.js.
 *
 *   stream_bot_devices.revoked_at, 30 days (H-765)
 *       A revoked device (CertiFried Studio, an overlay token or an OBS dock key) is deleted 30 days after it was revoked.
 *       Active devices have revoked_at NULL, which never matches `revoked_at < cutoff`, so they are kept until the
 *       streamer removes them (Devices page, Remove) or deletes their data (/privacy delete).
 *   twitch_user_follows.updated_at, 30 days, with a sweep guard (H-762)
 *       Historical data, no longer collected: the channels two broadcasters followed, read once on 2026-10-28 under
 *       user:read:follows (a scope CertiFried no longer requests). The owner chose to keep it. jobs/retention-sweeper.js
 *       SWEEP_GUARDS only lets a row go once its broadcaster (follower_id) has no CertiFried Twitch connection left
 *       (no server analytics grant in twitch_role_sync_config, no linked Twitch account in twitch_oauth_accounts or
 *       stream_platform_accounts); updated_at never changes now, so 30 days means "as soon as the broadcaster is gone".
 *       /privacy delete removes the rows earlier (core/twitch-follows-archive.js).
 *
 * Safe to re-run (INSERT IGNORE). Shown live on /legal/data (dashboard/content/legal/data-inventory.js).
 */
export const RETENTION_ROWS = Object.freeze([
    ['stream_bot_devices', 'revoked_at', 30, 'Stream bot devices: deleted 30 days after they are revoked; active devices are kept'],
    ['twitch_user_follows', 'updated_at', 30, 'Historical follows (2026-10-28, no longer collected): only once the broadcaster has no CertiFried Twitch link (SWEEP_GUARDS)'],
]);

export async function up(db) {
    for (const [table, column, days, notes] of RETENTION_ROWS) {
        await db.query(`INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES (?, ?, ?, 1, ?)`,
            [table, column, days, notes]);
    }
}

export async function down(db) {
    await db.query(`DELETE FROM data_retention_policy WHERE table_name IN ('stream_bot_devices', 'twitch_user_follows')`);
}

export default { up, down, RETENTION_ROWS };
