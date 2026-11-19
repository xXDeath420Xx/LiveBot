/**
 * Wave 384 — the analytics page offers a 90-day range, but per-minute snapshots were
 * swept after 30 days, so most 90d charts silently showed 30. Keep 90 days instead
 * (~100k rows/day across all broadcasters ≈ 1.7 GB at steady state).
 * idx_broadcaster_time duplicates uq_broadcaster_minute (same columns, same order), so
 * it's dropped to offset the growth.
 */
export async function up(pool) {
    await pool.query(
        `UPDATE data_retention_policy SET retain_days = 90,
                notes = 'Per-minute live-stream snapshots. 90d matches the longest analytics range.'
          WHERE table_name = 'twitch_stream_snapshots'`);
    await pool.query('ALTER TABLE twitch_stream_snapshots DROP INDEX IF EXISTS idx_broadcaster_time');
}

export async function down(pool) {
    await pool.query(
        `UPDATE data_retention_policy SET retain_days = 30,
                notes = 'Per-minute live-stream snapshots. 30d covers monthly trend baselines.'
          WHERE table_name = 'twitch_stream_snapshots'`);
    await pool.query(
        'ALTER TABLE twitch_stream_snapshots ADD INDEX IF NOT EXISTS idx_broadcaster_time (broadcaster_id, recorded_at)');
}
