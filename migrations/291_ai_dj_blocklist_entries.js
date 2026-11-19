/*
 * Migration 291: AI DJ blocklist entries can be a SONG or a whole ARTIST.
 *
 * ai_dj_blacklist (guild_id, song_identifier UNIQUE per guild, reason, added_by, added_at) existed but
 * nothing used it. `/music settings djblock` now manages it and core/dj-manager.cjs enforces it: every
 * entry is named to Gemini as an exclusion, and every recommendation / resolved track is checked
 * against it before it is queued (core/dj-blocklist.cjs).
 *
 *   entry_type   'song' (a title, optionally only by one artist) | 'artist' (anything they're credited on)
 *   title        the song title as the admin typed it (song entries)
 *   artist       the artist as typed (artist entries, and song entries narrowed to one artist)
 *
 * song_identifier stays the per-guild unique key: a normalized "song:<title>|<artist>" or
 * "artist:<name>", so "Rick Astley" and "rick astley - Topic" are the same entry. A row written before
 * this migration (identifier = plain title) is read as a song entry for that title.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
const COLUMNS = [
    ['entry_type', "ENUM('song', 'artist') NOT NULL DEFAULT 'song'"],
    ['title', 'VARCHAR(255) NULL DEFAULT NULL'],
    ['artist', 'VARCHAR(255) NULL DEFAULT NULL'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

export async function up(db) {
    await db.execute(`CREATE TABLE IF NOT EXISTS ai_dj_blacklist (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        guild_id         VARCHAR(20) NOT NULL,
        song_identifier  VARCHAR(255) NOT NULL,
        reason           VARCHAR(255) NULL DEFAULT NULL,
        added_by         VARCHAR(20) NULL DEFAULT NULL,
        added_at         TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_guild_song (guild_id, song_identifier),
        KEY idx_guild_id (guild_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    for (const [column, type] of COLUMNS) {
        if (!(await hasColumn(db, 'ai_dj_blacklist', column))) {
            await db.execute(`ALTER TABLE ai_dj_blacklist ADD COLUMN \`${column}\` ${type}`);
        }
    }
}

export async function down(db) {
    for (const [column] of COLUMNS) {
        if (await hasColumn(db, 'ai_dj_blacklist', column)) {
            await db.execute(`ALTER TABLE ai_dj_blacklist DROP COLUMN \`${column}\``);
        }
    }
}
