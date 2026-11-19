/*
 * Migration 297: stream history (stream_uptime) is recorded.
 *
 * stream_uptime existed (streamer_id, stream_start, stream_end, duration_seconds, platform) but was
 * never written, and its streamer_id was INT(11) while streamers.streamer_id is BIGINT(20) — a
 * value the parent can hold would not fit. Widened to BIGINT (MODIFY that only widens; the table
 * is empty).
 *
 * core/stream-session-recorder.js now opens a row when core/stream-manager.js sees a streamer
 * live and closes it once they have been offline for a while; /socials streamer history shows it.
 * Added:
 *   username       which channel (a session belongs to platform+username — several streamers rows
 *                  can share one, one per guild)
 *   last_seen_at   last time the stream was observed live; the session end is this, not the moment
 *                  the offline was noticed (which can lag by a full check cycle)
 *   peak_viewers   highest viewer count seen (platforms that report one)
 *   title, game    as last seen
 *   open_key       "platform:username" while the session is open, NULL once closed. UNIQUE, so two
 *                  bot clients observing the same live stream cannot open two sessions; MariaDB
 *                  allows any number of NULLs, so closed sessions do not collide.
 *   KEY (platform, username, stream_start) for the per-channel history query.
 *
 * Apply directly: import { up } and call up(pool).
 */
const COLUMNS = [
    ['stream_uptime', 'username', 'VARCHAR(255) NULL DEFAULT NULL'],
    ['stream_uptime', 'last_seen_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ['stream_uptime', 'peak_viewers', 'INT NULL DEFAULT NULL'],
    ['stream_uptime', 'title', 'VARCHAR(255) NULL DEFAULT NULL'],
    ['stream_uptime', 'game', 'VARCHAR(255) NULL DEFAULT NULL'],
    ['stream_uptime', 'open_key', 'VARCHAR(191) NULL DEFAULT NULL'],
];

const INDEXES = [
    ['uniq_open_key', 'UNIQUE KEY `uniq_open_key` (`open_key`)'],
    ['idx_channel_start', 'KEY `idx_channel_start` (`platform`, `username`, `stream_start`)'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

async function hasIndex(db, table, index) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
        [table, index]
    );
    return rows.length > 0;
}

export async function up(db) {
    // Widen streamer_id INT -> BIGINT (only if it is still INT).
    const [[col]] = await db.execute(
        `SELECT DATA_TYPE AS type FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stream_uptime' AND COLUMN_NAME = 'streamer_id'`
    );
    if (col && String(col.type).toLowerCase() === 'int') {
        await db.execute('ALTER TABLE stream_uptime MODIFY streamer_id BIGINT(20) NOT NULL');
    }

    for (const [table, column, type] of COLUMNS) {
        if (!(await hasColumn(db, table, column))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
        }
    }
    for (const [index, definition] of INDEXES) {
        if (!(await hasIndex(db, 'stream_uptime', index))) {
            await db.execute(`ALTER TABLE stream_uptime ADD ${definition}`);
        }
    }
}

export async function down(db) {
    for (const [index] of INDEXES) {
        if (await hasIndex(db, 'stream_uptime', index)) {
            await db.execute(`ALTER TABLE stream_uptime DROP INDEX \`${index}\``);
        }
    }
    for (const [table, column] of COLUMNS) {
        if (await hasColumn(db, table, column)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
    // streamer_id stays BIGINT: narrowing could truncate ids.
}
