/*
 * Migration 292: voice channel recording (/music record, core/voice-recorder.js).
 *
 * record_config (guild_id, is_enabled, allowed_role_ids JSON, output_channel_id) existed with nothing
 * reading it. It is now the switch: recording is impossible unless a server admin enables it
 * (`/music settings recording` or the dashboard card), and only Manage Server or the allowed roles
 * may start one. Added:
 *   record_config.max_minutes   per-server cap on one recording (NULL = 30). It is further capped so
 *                               the file always fits the server's Discord upload limit.
 *
 * voice_recordings — one row per recording, for accountability (who recorded which channel, when,
 * for how long) and so a restart mid-recording can be cleaned up: the bot's "🔴 REC" nickname is put
 * back and the audio captured so far is still delivered. The audio itself is NOT kept: the file is
 * deleted once posted; one that could not be posted is kept on disk for 7 days (file_path) and then
 * removed by the recorder's own sweep.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

export async function up(db) {
    await db.execute(`CREATE TABLE IF NOT EXISTS record_config (
        guild_id           VARCHAR(255) NOT NULL PRIMARY KEY,
        is_enabled         TINYINT(1) NULL DEFAULT 0,
        allowed_role_ids   LONGTEXT NULL DEFAULT '[]',
        output_channel_id  VARCHAR(255) NULL DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    if (!(await hasColumn(db, 'record_config', 'max_minutes'))) {
        await db.execute('ALTER TABLE record_config ADD COLUMN max_minutes INT NULL DEFAULT NULL');
    }

    await db.execute(`CREATE TABLE IF NOT EXISTS voice_recordings (
        id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
        guild_id           VARCHAR(20) NOT NULL,
        voice_channel_id   VARCHAR(20) NOT NULL,
        text_channel_id    VARCHAR(20) NULL DEFAULT NULL,
        output_channel_id  VARCHAR(20) NULL DEFAULT NULL,
        started_by         VARCHAR(20) NOT NULL,
        bot_user_id        VARCHAR(20) NULL DEFAULT NULL,
        started_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        max_minutes        INT NOT NULL,
        ended_at           TIMESTAMP NULL DEFAULT NULL,
        end_reason         VARCHAR(32) NULL DEFAULT NULL,
        stopped_by         VARCHAR(20) NULL DEFAULT NULL,
        duration_sec       INT NULL DEFAULT NULL,
        speaker_count      INT NULL DEFAULT NULL,
        file_path          VARCHAR(500) NULL DEFAULT NULL,
        file_bytes         BIGINT NULL DEFAULT NULL,
        delivered          TINYINT(1) NOT NULL DEFAULT 0,
        message_id         VARCHAR(20) NULL DEFAULT NULL,
        nick_changed       TINYINT(1) NOT NULL DEFAULT 0,
        original_nick      VARCHAR(64) NULL DEFAULT NULL,
        KEY idx_guild (guild_id, started_at),
        KEY idx_open (ended_at),
        KEY idx_undelivered (delivered, ended_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS voice_recordings');
    if (await hasColumn(db, 'record_config', 'max_minutes')) {
        await db.execute('ALTER TABLE record_config DROP COLUMN max_minutes');
    }
}
