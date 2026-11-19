/*
 * Chat-to-voice reader and voice transcription.
 *
 * voice_reader_config         one row per guild: which text channels are read aloud, into which
 *                             voice channel, with which Piper voice (core/voice-reader-manager.js).
 * voice_transcription_config  one row per guild: where live captions and the finished transcript go,
 *                             which Whisper model, how long transcripts are kept.
 * voice_transcription_sessions / _segments
 *                             a recording session and every transcribed phrase in it. Segments are
 *                             the transcript; no audio is ever stored.
 * voice_transcription_optouts members who must never be transcribed — enforced before a single
 *                             packet of theirs is decoded, in every guild.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS voice_reader_config (
            guild_id VARCHAR(20) NOT NULL PRIMARY KEY,
            enabled TINYINT(1) NOT NULL DEFAULT 0,
            text_channels TEXT NULL,
            voice_channel_id VARCHAR(20) NULL,
            follow_author TINYINT(1) NOT NULL DEFAULT 1,
            voice VARCHAR(64) NULL,
            read_names TINYINT(1) NOT NULL DEFAULT 1,
            require_in_voice TINYINT(1) NOT NULL DEFAULT 1,
            max_length INT NOT NULL DEFAULT 250,
            allowed_roles TEXT NULL,
            skip_links TINYINT(1) NOT NULL DEFAULT 1,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS voice_transcription_config (
            guild_id VARCHAR(20) NOT NULL PRIMARY KEY,
            -- "may staff start a session here", not "is one running": sessions are always started
            -- by hand, so a guild that never opened the settings page is not locked out.
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            caption_channel_id VARCHAR(20) NULL,
            live_captions TINYINT(1) NOT NULL DEFAULT 1,
            post_transcript TINYINT(1) NOT NULL DEFAULT 1,
            transcript_channel_id VARCHAR(20) NULL,
            model VARCHAR(16) NOT NULL DEFAULT 'fast',
            starter_role_id VARCHAR(20) NULL,
            retention_days INT NOT NULL DEFAULT 30,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS voice_transcription_sessions (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            voice_channel_id VARCHAR(20) NOT NULL,
            starter_user_id VARCHAR(20) NOT NULL,
            started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            ended_at DATETIME NULL,
            end_reason VARCHAR(32) NULL,
            segment_count INT NOT NULL DEFAULT 0,
            INDEX idx_vts_guild (guild_id, started_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS voice_transcription_segments (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            session_id INT UNSIGNED NOT NULL,
            user_id VARCHAR(20) NOT NULL,
            display_name VARCHAR(100) NOT NULL,
            offset_ms INT UNSIGNED NOT NULL,
            duration_ms INT UNSIGNED NOT NULL,
            text TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_vtseg_session (session_id, offset_ms)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS voice_transcription_optouts (
            user_id VARCHAR(20) NOT NULL PRIMARY KEY,
            opted_out_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}
