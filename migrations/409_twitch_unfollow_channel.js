/**
 * Wave 409 — Twitch unfollow channel.
 *
 * The hourly follower diff (core/twitch-analytics-cron.js runFollowerChurn) posts verified
 * unfollows to this channel. NULL = off. Set from the Twitch analytics page, Alert configuration.
 */
export async function up(pool) {
    const [cols] = await pool.query(
        "SHOW COLUMNS FROM twitch_analytics_alerts_config LIKE 'unfollow_channel_id'");
    if (cols.length) return;
    await pool.query(
        `ALTER TABLE twitch_analytics_alerts_config
           ADD COLUMN unfollow_channel_id VARCHAR(20) NULL DEFAULT NULL AFTER alert_channel_id`);
}

export async function down(pool) {
    await pool.query('ALTER TABLE twitch_analytics_alerts_config DROP COLUMN unfollow_channel_id');
}
