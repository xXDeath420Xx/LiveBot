/*
 * Migration 256: music play log — one row per track the bot tried to play (core/music-play-log.js).
 *
 * Replaces nothing that works: music_statistics / music_history were never written (their writer has
 * no callers) and music_song_metrics / music_user_metrics are leftovers of a removed module. This
 * records each play once, with where it came from, how it played and how it ended, for the
 * super-admin "Music activity" page.
 *
 *   outcome    playing (in progress) | completed | skipped | failed | stopped (ended early) |
 *              interrupted (the bot restarted mid-song)
 *   playback   spotify | relay:<resolver> | server1-direct | direct — how the audio reached the bot
 *
 * Retention: 365 days via the nightly retention sweeper (data_retention_policy), on `logged_at`.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
export async function up(db) {
    await db.execute(`CREATE TABLE IF NOT EXISTS music_play_log (
        id                BIGINT AUTO_INCREMENT PRIMARY KEY,
        logged_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        guild_id          VARCHAR(20) NOT NULL,
        guild_name        VARCHAR(100) NULL,
        voice_channel_id  VARCHAR(20) NULL,
        requester_id      VARCHAR(20) NULL,
        requester_name    VARCHAR(100) NULL,
        added_by          ENUM('user', 'autoplay', 'dj') NOT NULL DEFAULT 'user',
        request_source    VARCHAR(16) NOT NULL,
        playlist          VARCHAR(255) NULL,
        title             VARCHAR(500) NOT NULL,
        author            VARCHAR(255) NULL,
        url               VARCHAR(1000) NULL,
        duration_sec      INT NULL,
        explicit          TINYINT(1) NULL,
        playback          VARCHAR(48) NULL,
        prefetched        TINYINT(1) NOT NULL DEFAULT 0,
        spotify_account   VARCHAR(16) NULL,
        matched_via       VARCHAR(16) NULL,
        matched_title     VARCHAR(500) NULL,
        requested_at      TIMESTAMP NULL DEFAULT NULL,
        started_at        TIMESTAMP NULL DEFAULT NULL,
        ended_at          TIMESTAMP NULL DEFAULT NULL,
        listened_sec      INT NULL,
        outcome           ENUM('playing', 'completed', 'skipped', 'failed', 'stopped', 'interrupted') NOT NULL,
        skip_reason       VARCHAR(32) NULL,
        skipped_by        VARCHAR(20) NULL,
        skipped_by_name   VARCHAR(100) NULL,
        error             VARCHAR(500) NULL,
        KEY idx_logged (logged_at),
        KEY idx_guild (guild_id, logged_at),
        KEY idx_requester (requester_id, logged_at),
        KEY idx_outcome (outcome, logged_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await db.execute(`INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, notes) VALUES
        ('music_play_log', 'logged_at', 365, 'Music activity page — one row per play')`);
}
