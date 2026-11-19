/**
 * Migration 459: stream bot overlays and alerts (Phase 3; docs/superpowers/specs/2026-11-19-stream-bot-design.md §9,
 * core/stream-bot/overlays/).
 *
 *   stream_bot_overlays        one row per OBS browser-source overlay a streamer made: its type (alerts, chat, events,
 *                              goal, counter, nowplaying, canvas), name, settings (alert styles, widget options) and a
 *                              small live state (a goal's progress). The page URL carries a per-overlay key
 *                              (`sbo_` + 24 random bytes): only its SHA-256 is looked up (key_hash, unique) and the
 *                              key itself is kept encrypted (utils/encryption.js) so the Overlays tab can show the URL
 *                              again. Regenerating replaces both; the old URL stops at once.
 *   stream_bot_overlay_media   images and videos the streamer uploaded for alerts and "Show an image or video" (the
 *                              files live outside git in STREAM_BOT_MEDIA_DIR; this is the index).
 *
 * Both hang off stream_bot_profiles with ON DELETE CASCADE. No viewer data is stored here: alerts, chat and event
 * lists are sent live and never written. Retention: kept with the profile until the streamer deletes them (no
 * time-based purge; nothing in them goes stale on its own). /privacy export lists them without the key columns and
 * delete removes the profile's media files (core/stream-bot/overlays/privacy.js). stream_bot_overlays is in
 * SECRET_TABLES (core/privacy-tables.js) because of the key columns, like stream_bot_devices.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS. `overlaysDdl(prefix)` builds the same tables under a test prefix.
 * Apply directly: node -e "import('./migrations/459_stream_bot_overlays.js').then(async m => { const p = (await import('./utils/db.js')).default; await m.up(p); await p.end(); })"
 */
const TAIL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export function overlaysDdl(prefix = 'stream_bot_') {
    const t = (n) => `\`${prefix}${n}\``;
    const fk = (n) => `CONSTRAINT ${prefix}fk_${n}_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE`;
    return [
        `CREATE TABLE IF NOT EXISTS ${t('overlays')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            type VARCHAR(16) NOT NULL,
            name VARCHAR(80) NOT NULL,
            key_hash CHAR(64) NOT NULL,
            key_enc TEXT DEFAULT NULL,
            key_hint VARCHAR(8) DEFAULT NULL,
            config MEDIUMTEXT DEFAULT NULL,
            state TEXT DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            last_seen_at TIMESTAMP NULL DEFAULT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_key (key_hash),
            KEY idx_profile (profile_id, id),
            ${fk('overlays')}
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('overlay_media')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            file_id CHAR(16) NOT NULL,
            name VARCHAR(80) NOT NULL,
            kind VARCHAR(8) NOT NULL,
            ext VARCHAR(5) NOT NULL,
            mime VARCHAR(40) NOT NULL,
            size INT UNSIGNED NOT NULL,
            sha256 CHAR(64) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_name (profile_id, name),
            UNIQUE KEY uq_file (profile_id, file_id),
            ${fk('overlay_media')}
        ) ${TAIL}`,
    ];
}

export const OVERLAY_TABLES = Object.freeze(['overlays', 'overlay_media']);

export async function up(db) {
    for (const sql of overlaysDdl('stream_bot_')) await db.query(sql);
}

export async function down(db) {
    for (const n of [...OVERLAY_TABLES].reverse()) await db.query(`DROP TABLE IF EXISTS \`stream_bot_${n}\``);
}
