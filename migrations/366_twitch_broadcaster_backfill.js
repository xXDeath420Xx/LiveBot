/**
 * Wave 366 — Twitch broadcaster backfill summary.
 *
 * On OAuth connect we hit Helix for lifetime/current state that EventSub webhooks will NEVER
 * emit after the fact: total follower count, active subscriber count, bits leaderboard,
 * current stream info, current VIPs/mods list, teams, charity campaign, active goals. Those
 * one-shot numbers populate the analytics headline so a fresh connection isn't a wasteland.
 *
 * This table is the home for channel-wide snapshot data. Per-session SUMs still live on
 * twitch_stream_sessions; event-stream details still live on twitch_*_events tables. The
 * analytics route COALESCEs session SUMs with this summary so pre-connection sessions
 * (zero EventSub coverage) don't drag headline tiles to zero.
 */
export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_broadcaster_backfill (
            broadcaster_id VARCHAR(64) NOT NULL PRIMARY KEY,
            broadcaster_login VARCHAR(100) DEFAULT NULL,
            follower_count INT UNSIGNED DEFAULT NULL,
            subscriber_count INT UNSIGNED DEFAULT NULL,
            subscriber_points INT UNSIGNED DEFAULT NULL,
            bits_leaderboard_json LONGTEXT DEFAULT NULL,
            bits_leaderboard_period VARCHAR(16) DEFAULT NULL,
            bits_total_period INT UNSIGNED DEFAULT NULL,
            current_vips_json LONGTEXT DEFAULT NULL,
            current_mods_json LONGTEXT DEFAULT NULL,
            current_stream_json LONGTEXT DEFAULT NULL,
            current_channel_json LONGTEXT DEFAULT NULL,
            charity_campaign_json LONGTEXT DEFAULT NULL,
            active_goals_json LONGTEXT DEFAULT NULL,
            teams_json LONGTEXT DEFAULT NULL,
            scope_errors_json LONGTEXT DEFAULT NULL,
            last_run_at DATETIME DEFAULT NULL,
            last_run_duration_ms INT DEFAULT NULL,
            last_run_ok TINYINT(1) NOT NULL DEFAULT 0,
            last_error TEXT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_last_run (last_run_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(pool) {
    await pool.query('DROP TABLE IF EXISTS twitch_broadcaster_backfill');
}
