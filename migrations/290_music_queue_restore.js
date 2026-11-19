/*
 * Migration 290: music queue restore across restarts (core/music-queue-persistence.js).
 *
 * music_queues already existed (guild_id PK, queue, now_playing, is_playing, is_paused) but nothing
 * ever wrote it. It now holds one row per guild with music: a snapshot of the queue, rewritten as the
 * queue changes and every 15 s while it plays, deleted when the music stops. After a deploy or a crash
 * the next process restores each row (rejoins the voice channel, rebuilds the queue, resumes the track
 * near where it was) and clears it. These columns are what the restore needs beyond the track lists:
 *
 *   voice_channel_id / text_channel_id   where to rejoin and where to post the "I'm back" note
 *   bot_user_id                          which bot was playing (custom bots log in after the default one)
 *   position_ms                          how far into the current track (resume a few seconds earlier)
 *   volume, repeat_mode                  restored as they were
 *   metadata                             JSON: DJ-mode session (prompt, seeds, initiator, played tracks)
 *   instance_id                          the process that wrote the row — a restore only takes rows from
 *                                        an EARLIER process, never the live ones it is writing itself
 *   saved_at                             last snapshot time; rows older than 30 min are discarded
 *
 * No retention policy needed: rows are deleted on stop, on restore, and on expiry.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
const COLUMNS = [
    ['voice_channel_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['text_channel_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['bot_user_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['position_ms', 'INT NOT NULL DEFAULT 0'],
    ['volume', 'INT NULL DEFAULT NULL'],
    ['repeat_mode', 'TINYINT NOT NULL DEFAULT 0'],
    ['metadata', 'LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL'],
    ['instance_id', 'VARCHAR(40) NULL DEFAULT NULL'],
    ['saved_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

export async function up(db) {
    // The table predates the migrations folder on some installs; make sure it exists with its original shape.
    await db.execute(`CREATE TABLE IF NOT EXISTS music_queues (
        guild_id     VARCHAR(255) NOT NULL PRIMARY KEY,
        queue        LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
        is_playing   TINYINT(1) NOT NULL DEFAULT 0,
        is_paused    TINYINT(1) NOT NULL DEFAULT 0,
        now_playing  LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    for (const [column, type] of COLUMNS) {
        if (!(await hasColumn(db, 'music_queues', column))) {
            await db.execute(`ALTER TABLE music_queues ADD COLUMN \`${column}\` ${type}`);
        }
    }
}

export async function down(db) {
    for (const [column] of COLUMNS) {
        if (await hasColumn(db, 'music_queues', column)) {
            await db.execute(`ALTER TABLE music_queues DROP COLUMN \`${column}\``);
        }
    }
}
