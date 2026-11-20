/**
 * Migration 461: cloud light accounts for the stream bot (Phase 5; docs/superpowers/specs/2026-11-19-stream-bot-design.md §10,
 * core/stream-bot/devices/).
 *
 *   stream_bot_light_accounts   one row per streamer and cloud light service (Govee, LIFX): the streamer's own API key or
 *                               token, encrypted with utils/encryption.js (key_enc), its last 4 characters (key_hint),
 *                               whether the service accepted it (status, last_error), and the device list the service
 *                               last returned (devices: ids, names, models and what they can do; no secrets), so the
 *                               automation editor can offer them without asking the service again.
 *
 * Lights on the streamer's own network (Govee LAN, Hue, LIFX LAN, Nanoleaf, Elgato, Logitech Litra) are not stored here:
 * CertiFried Studio finds them and keeps their tokens on the PC.
 *
 * Hangs off stream_bot_profiles with ON DELETE CASCADE. Retention: kept with the profile until the streamer removes the
 * key or deletes the profile (no time-based purge; a key does not go stale by date, and a refused key is marked, not kept
 * silently). In SECRET_TABLES (core/privacy-tables.js) because of key_enc; /privacy export lists the provider, hint,
 * status and device names only (core/stream-bot/devices/privacy.js), delete goes with the profile.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS. `lightAccountsDdl(prefix)` builds the same table under a test prefix.
 * Apply directly: node -e "import('./migrations/461_stream_bot_light_accounts.js').then(async m => { const p = (await import('./utils/db.js')).default; await m.up(p); await p.end(); })"
 */
const TAIL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export function lightAccountsDdl(prefix = 'stream_bot_') {
    const t = (n) => `\`${prefix}${n}\``;
    return [
        `CREATE TABLE IF NOT EXISTS ${t('light_accounts')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            provider VARCHAR(16) NOT NULL,
            key_enc TEXT NOT NULL,
            key_hint VARCHAR(8) DEFAULT NULL,
            status VARCHAR(16) NOT NULL DEFAULT 'unchecked',
            last_error VARCHAR(200) DEFAULT NULL,
            devices MEDIUMTEXT DEFAULT NULL,
            devices_at TIMESTAMP NULL DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_provider (profile_id, provider),
            CONSTRAINT ${prefix}fk_light_accounts_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
    ];
}

export const LIGHT_TABLES = Object.freeze(['light_accounts']);

export async function up(db) {
    for (const sql of lightAccountsDdl('stream_bot_')) await db.query(sql);
}

export async function down(db) {
    for (const n of [...LIGHT_TABLES].reverse()) await db.query(`DROP TABLE IF EXISTS \`stream_bot_${n}\``);
}
