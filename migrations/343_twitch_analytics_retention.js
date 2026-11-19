/**
 * Migration 343 — retention policy rows for Twitch analytics tables.
 *
 * The analytics pipeline writes high-frequency snapshots that otherwise accumulate
 * without bound. Rough per-active-broadcaster volume:
 *   twitch_stream_snapshots  ~79K rows/day while live, 0 while offline
 *   twitch_anomaly_alerts    small (few/day worst case) — kept longer for audit value
 *   twitch_mention_targets   sliding-window harassment buckets — short-lived by design
 *
 * The retention sweeper (reference_certifried_db_retention) deletes rows older than
 * retain_days using timestamp_column as the age field.
 *
 * Idempotent: safe to re-run.
 */

export async function up(db) {
    const rows = [
        // Per-minute snapshots. 30 days gives us a month of trend history for the detectors
        // and dashboard summary without ballooning the table on any high-stream guild.
        ['twitch_stream_snapshots', 'recorded_at',  30, 'Per-minute live-stream snapshots. 30d covers monthly trend baselines.'],
        // Alert ledger. 180 days matches audit_logs — these are moderation-adjacent evidence,
        // worth keeping for incident reviews.
        ['twitch_anomaly_alerts',  'created_at',   180, 'Twitch anomaly alerts (view-bot, follow-bot, raid, harassment, mod spike).'],
        // Harassment detection rolling buckets. 7 days is well beyond the 5-minute window used
        // by the detector; nothing reads older rows.
        ['twitch_mention_targets', 'window_start',   7, 'Rolling @-mention buckets for harassment detection — short-lived by design.'],
    ];
    for (const [table, col, days, notes] of rows) {
        await db.execute(`
            INSERT INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes)
            VALUES (?, ?, ?, 1, ?)
            ON DUPLICATE KEY UPDATE
                timestamp_column = VALUES(timestamp_column),
                retain_days      = VALUES(retain_days),
                enabled          = VALUES(enabled),
                notes            = VALUES(notes)
        `, [table, col, days, notes]);
    }
    console.log(`[migrate 343] inserted ${rows.length} retention policy rows for Twitch analytics tables.`);
}
