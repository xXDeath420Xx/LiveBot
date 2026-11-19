/*
 * Migration 255: music health history — feeds the super-admin "Music health" page.
 *
 * core/music-health-monitor.js checks every link of the music chain once a minute (resolvers,
 * tunnels, canaries, playback through the audio relay, cookies, bgutil, Spotify, sentinels) but only
 * kept the latest snapshot. This keeps the history:
 *
 *   music_health_samples  one row per monitor tick: the checks whose probe failed that tick
 *                         (`failing`), the checks in the DOWN state after hysteresis (`down`), and a
 *                         few counters for the trend lines (canary latency, relay traffic, requests).
 *                         ~1,440 rows a day at a few hundred bytes each.
 *   music_health_events   every state change (down / up / still_down) and whether it was DMed.
 *
 * Retention goes to the nightly retention sweeper (data_retention_policy): samples 30 days,
 * events 180 days. Both tables are indexed on `ts`, which the sweeper's batched deletes use.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
export async function up(db) {
    await db.execute(`CREATE TABLE IF NOT EXISTS music_health_samples (
        id            BIGINT AUTO_INCREMENT PRIMARY KEY,
        ts            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        checks_total  SMALLINT NOT NULL,
        failing       TEXT NULL,
        down          TEXT NULL,
        metrics       JSON NULL,
        KEY idx_ts (ts)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await db.execute(`CREATE TABLE IF NOT EXISTS music_health_events (
        id        BIGINT AUTO_INCREMENT PRIMARY KEY,
        ts        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        check_id  VARCHAR(128) NOT NULL,
        kind      ENUM('down', 'up', 'still_down') NOT NULL,
        severity  VARCHAR(16) NULL,
        title     VARCHAR(255) NOT NULL,
        detail    TEXT NULL,
        notified  TINYINT(1) NOT NULL DEFAULT 0,
        KEY idx_ts (ts),
        KEY idx_check (check_id, ts)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await db.execute(`INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, notes) VALUES
        ('music_health_samples', 'ts', 30, 'Music health page — one row per monitor tick'),
        ('music_health_events', 'ts', 180, 'Music health page — incident log')`);
}
