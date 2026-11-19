/**
 * Wave 374 — Cross-tenant peer insights with privacy constraints.
 *
 * DESIGN:
 *   - Reciprocal opt-in: a broadcaster sees peer data ONLY if they contribute theirs
 *     (ai_peer_pool_optin = 1).
 *   - Aggregates only. Nothing identifying crosses the tenant boundary — no titles, no
 *     chat samples, no logins. Only numbers.
 *   - k≥5 per bucket. Below that, we return "not enough peers in bucket, hidden" so a
 *     bucket of 1 can't be reverse-engineered.
 *   - Buckets: by follower_count. small (<100), mid (100-999), big (1k-9.9k), mega (10k+).
 *   - Snapshots are DAILY and bucket-level. We never re-query raw rows from one broadcaster
 *     to answer a question about another. The snapshot IS the only input to peer insights.
 *   - On disconnect, we leave the broadcaster_log rows for audit but opt them out of future
 *     contributions.
 *   - Super-admin view is unaffected — operator-level visibility (which already exists on
 *     /admin/twitch-analytics/compare) is a legitimate operator function and not what we're
 *     restricting here.
 */
export async function up(pool) {
    // Daily bucket aggregate — one row per (bucket, day). Nothing broadcaster-identifying.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_peer_bucket_snapshots (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            bucket VARCHAR(16) NOT NULL,
            day DATE NOT NULL,
            member_count INT UNSIGNED NOT NULL DEFAULT 0,
            median_follower_count INT UNSIGNED DEFAULT NULL,
            median_sub_count INT UNSIGNED DEFAULT NULL,
            median_hours_live_7d DECIMAL(6,2) DEFAULT NULL,
            median_peak_viewers_7d INT UNSIGNED DEFAULT NULL,
            median_msgs_7d INT UNSIGNED DEFAULT NULL,
            median_bits_total INT UNSIGNED DEFAULT NULL,
            p25_peak_viewers_7d INT UNSIGNED DEFAULT NULL,
            p75_peak_viewers_7d INT UNSIGNED DEFAULT NULL,
            p25_follower_count INT UNSIGNED DEFAULT NULL,
            p75_follower_count INT UNSIGNED DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_bucket_day (bucket, day),
            KEY idx_day (day)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Per-broadcaster-per-day log so a single broadcaster can see where THEIR numbers
    // ranked in their bucket. This table stores percentile-only (0-100), not raw peer
    // values — reading one row never reveals another broadcaster's data.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_peer_bucket_log (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            bucket VARCHAR(16) NOT NULL,
            day DATE NOT NULL,
            follower_percentile DECIMAL(5,2) DEFAULT NULL,
            sub_percentile DECIMAL(5,2) DEFAULT NULL,
            hours_live_percentile DECIMAL(5,2) DEFAULT NULL,
            peak_viewers_percentile DECIMAL(5,2) DEFAULT NULL,
            msgs_percentile DECIMAL(5,2) DEFAULT NULL,
            bits_percentile DECIMAL(5,2) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_broadcaster_day (broadcaster_id, day),
            KEY idx_broadcaster_time (broadcaster_id, day)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const extraCfgCols = [
        ['ai_peer_pool_optin', `TINYINT(1) NOT NULL DEFAULT 0`],
        ['ai_peer_pool_optin_at', 'DATETIME DEFAULT NULL'],
    ];
    for (const [col, def] of extraCfgCols) {
        const [ex] = await pool.query(
            `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'twitch_analytics_alerts_config' AND COLUMN_NAME = ?`, [col]);
        if (!ex[0].n) await pool.query(`ALTER TABLE twitch_analytics_alerts_config ADD COLUMN ${col} ${def}`);
    }
}

export async function down(pool) {
    for (const t of ['twitch_peer_bucket_snapshots','twitch_peer_bucket_log']) {
        await pool.query(`DROP TABLE IF EXISTS ${t}`);
    }
    for (const col of ['ai_peer_pool_optin','ai_peer_pool_optin_at']) {
        try { await pool.query(`ALTER TABLE twitch_analytics_alerts_config DROP COLUMN ${col}`); } catch {}
    }
}
