/**
 * Migration 457: song requests for the stream bot, played through CertiFried's music pipeline
 * (docs/superpowers/specs/2026-11-19-stream-bot-design.md §7, core/stream-bot/music/).
 *
 *   stream_bot_music_requests        one row per request from chat or the dashboard: who asked (platform viewer id),
 *                                    the song, and its life: pending (waits for a mod) → queued → playing → played,
 *                                    or denied / removed / skipped / failed. Stats (!topSongs, !myTopSongs) read it.
 *   stream_bot_music_bans            banned songs (track key) and artists
 *   stream_bot_music_likes           !like from viewers
 *   stream_bot_music_playlists       the streamer's CertiFried playlists (imported from a Spotify / YouTube /
 *   stream_bot_music_playlist_items  SoundCloud link, or built with !addSong), one of them the fallback list
 *
 *   music_play_log (migration 256)   extended, not duplicated: `context` ('discord' default, 'stream'),
 *                                    `stream_profile_id`, `stream_request_id`. Stream rows keep requester_id NULL
 *                                    (that column is a Discord id); the viewer is on the request row.
 *
 * Every new table hangs off stream_bot_profiles with ON DELETE CASCADE. Viewer rows (requests, likes) are covered
 * by /privacy through core/stream-bot/music/privacy.js (export and delete by the linked Twitch / Kick account);
 * the streamer's own data goes with the profile, and their stream rows in music_play_log are deleted with it.
 *
 * Retention (data_retention_policy): requests 365 days (created_at), likes 400 days (created_at). Bans and
 * playlists are kept until the streamer removes them. music_play_log keeps its 365 days.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS, columns and index added only when missing, INSERT IGNORE.
 * `musicDdl(prefix)` builds the same tables under a test prefix; `playLogAlter(table)` extends any copy of the play log.
 * Apply directly: node -e "import('./migrations/457_stream_bot_music.js').then(async m => { const p = (await import('./utils/db.js')).default; await m.up(p); await p.end(); })"
 */
const TAIL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
const TEXT = (n, len, nullable = true) => `\`${n}\` VARCHAR(${len}) ${nullable ? 'DEFAULT NULL' : 'NOT NULL'}`;

export function musicDdl(prefix = 'stream_bot_') {
    const t = (n) => `\`${prefix}${n}\``;
    const fk = (n) => `CONSTRAINT ${prefix}fk_${n}_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE`;
    return [
        `CREATE TABLE IF NOT EXISTS ${t('music_requests')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            platform VARCHAR(16) NOT NULL,
            ${TEXT('viewer_id', 64)},
            ${TEXT('viewer_login', 100)},
            ${TEXT('viewer_name', 100)},
            source VARCHAR(16) NOT NULL,
            ${TEXT('input', 300)},
            title VARCHAR(300) NOT NULL,
            ${TEXT('artist', 300)},
            ${TEXT('url', 600)},
            track_key VARCHAR(191) NOT NULL,
            duration_ms INT UNSIGNED DEFAULT NULL,
            explicit TINYINT(1) DEFAULT NULL,
            ${TEXT('thumbnail', 600)},
            ${TEXT('playlist_name', 150)},
            status VARCHAR(12) NOT NULL,
            ${TEXT('reason', 160)},
            ${TEXT('decided_by', 100)},
            play_log_id BIGINT DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            decided_at TIMESTAMP NULL DEFAULT NULL,
            started_at TIMESTAMP NULL DEFAULT NULL,
            finished_at TIMESTAMP NULL DEFAULT NULL,
            PRIMARY KEY (id),
            KEY idx_profile_status (profile_id, status, id),
            KEY idx_viewer (platform, viewer_id),
            KEY idx_track (profile_id, track_key),
            KEY idx_created (created_at),
            ${fk('music_requests')}
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('music_bans')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            kind VARCHAR(8) NOT NULL,
            ref VARCHAR(191) NOT NULL,
            ${TEXT('title', 300)},
            ${TEXT('artist', 300)},
            ${TEXT('url', 600)},
            ${TEXT('created_by', 100)},
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_ban (profile_id, kind, ref),
            ${fk('music_bans')}
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('music_likes')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            platform VARCHAR(16) NOT NULL,
            viewer_id VARCHAR(64) NOT NULL,
            ${TEXT('viewer_name', 100)},
            track_key VARCHAR(191) NOT NULL,
            title VARCHAR(300) NOT NULL,
            ${TEXT('artist', 300)},
            ${TEXT('url', 600)},
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_like (profile_id, platform, viewer_id, track_key),
            KEY idx_track (profile_id, track_key),
            KEY idx_viewer (platform, viewer_id),
            KEY idx_created (created_at),
            ${fk('music_likes')}
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('music_playlists')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            name VARCHAR(100) NOT NULL,
            kind VARCHAR(12) NOT NULL DEFAULT 'custom',
            ${TEXT('source_url', 600)},
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_name (profile_id, name),
            ${fk('music_playlists')}
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('music_playlist_items')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            playlist_id BIGINT UNSIGNED NOT NULL,
            profile_id BIGINT UNSIGNED NOT NULL,
            position INT UNSIGNED NOT NULL DEFAULT 0,
            track_key VARCHAR(191) NOT NULL,
            title VARCHAR(300) NOT NULL,
            ${TEXT('artist', 300)},
            ${TEXT('url', 600)},
            source VARCHAR(16) NOT NULL,
            duration_ms INT UNSIGNED DEFAULT NULL,
            explicit TINYINT(1) DEFAULT NULL,
            ${TEXT('thumbnail', 600)},
            ${TEXT('added_by', 100)},
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_item (playlist_id, track_key),
            KEY idx_playlist (playlist_id, position),
            KEY idx_profile (profile_id),
            CONSTRAINT ${prefix}fk_music_items_playlist FOREIGN KEY (playlist_id) REFERENCES ${t('music_playlists')} (id) ON DELETE CASCADE,
            ${fk('music_items')}
        ) ${TAIL}`,
    ];
}

export const MUSIC_TABLES = Object.freeze(['music_requests', 'music_bans', 'music_likes', 'music_playlists', 'music_playlist_items']);

/** Add the stream columns to a copy of music_play_log (the real one, or a test copy made with CREATE TABLE … LIKE). */
export async function playLogAlter(db, table = 'music_play_log') {
    if (!/^[a-z0-9_]{1,64}$/.test(table)) throw new Error('bad table name');
    const [cols] = await db.query(`SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
    if (!cols.length) return false;   // no play log in this database (migration 256 not applied): nothing to extend
    const have = new Set(cols.map((r) => r.c));
    const add = [];
    if (!have.has('context')) add.push("ADD COLUMN context VARCHAR(16) NOT NULL DEFAULT 'discord' AFTER logged_at");
    if (!have.has('stream_profile_id')) add.push('ADD COLUMN stream_profile_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER context');
    if (!have.has('stream_request_id')) add.push('ADD COLUMN stream_request_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER stream_profile_id');
    if (add.length) await db.query(`ALTER TABLE \`${table}\` ${add.join(', ')}`);
    const [idx] = await db.query(`SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = 'idx_stream_profile' LIMIT 1`, [table]);
    if (!idx.length) await db.query(`ALTER TABLE \`${table}\` ADD KEY idx_stream_profile (stream_profile_id, logged_at)`);
    return true;
}

export const RETENTION_ROWS = Object.freeze([
    ['stream_bot_music_requests', 'created_at', 365, 'Stream bot song requests (who asked for what, approvals); feeds !topSongs and !myTopSongs'],
    ['stream_bot_music_likes', 'created_at', 400, 'Stream bot !like from viewers'],
]);

export async function up(db) {
    for (const sql of musicDdl('stream_bot_')) await db.query(sql);
    await playLogAlter(db, 'music_play_log');
    for (const [table, column, days, notes] of RETENTION_ROWS) {
        await db.query(`INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES (?, ?, ?, 1, ?)`,
            [table, column, days, notes]);
    }
}

export async function down(db) {
    await db.query(`DELETE FROM data_retention_policy WHERE table_name IN ('stream_bot_music_requests', 'stream_bot_music_likes')`);
    for (const n of [...MUSIC_TABLES].reverse()) await db.query(`DROP TABLE IF EXISTS \`stream_bot_${n}\``);
    // The play log columns stay: Discord rows carry context = 'discord' and dropping them would lose the stream rows' link.
}
