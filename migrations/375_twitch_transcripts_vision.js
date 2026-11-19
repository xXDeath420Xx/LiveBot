/**
 * Wave 375 — VOD transcripts (via local whisper.cpp on 8178/8179) + Gemini Vision clip
 * analysis. This unblocks the two "needs infrastructure" items from the AI roadmap.
 */
export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_vod_transcripts (
            video_id VARCHAR(32) NOT NULL PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            status ENUM('pending','running','done','failed') NOT NULL DEFAULT 'pending',
            transcript_text LONGTEXT DEFAULT NULL,
            segments_json LONGTEXT DEFAULT NULL,
            whisper_model VARCHAR(32) DEFAULT NULL,
            audio_duration_seconds INT UNSIGNED DEFAULT NULL,
            processing_duration_ms INT UNSIGNED DEFAULT NULL,
            error_message VARCHAR(500) DEFAULT NULL,
            requested_by_discord_id VARCHAR(20) DEFAULT NULL,
            requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME DEFAULT NULL,
            KEY idx_broadcaster_status (broadcaster_id, status, requested_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_clip_vision_analyses (
            clip_id VARCHAR(128) NOT NULL PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            provider VARCHAR(32) DEFAULT NULL,
            model VARCHAR(100) DEFAULT NULL,
            scene_description TEXT DEFAULT NULL,
            detected_mood VARCHAR(32) DEFAULT NULL,
            suggested_tags_json LONGTEXT DEFAULT NULL,
            thumb_url_analyzed TEXT DEFAULT NULL,
            analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_broadcaster_time (broadcaster_id, analyzed_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(pool) {
    await pool.query(`DROP TABLE IF EXISTS twitch_vod_transcripts`);
    await pool.query(`DROP TABLE IF EXISTS twitch_clip_vision_analyses`);
}
