/**
 * Migration 454 — the stream bot engine, Phase 1 (docs/superpowers/specs/2026-11-19-stream-bot-design.md).
 *
 * One profile per CertiFried user (owner_discord_id), its linked Twitch/Kick channels, the opt-in Stream bot
 * Twitch grant, tip sources, the normalised event log, automations and their run log, paired devices and
 * pairing codes, the client-action dispatch queue, and the {db:}/{sdb:} variable store.
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS, INSERT IGNORE). `streamBotDdl(prefix)` is exported so tests build
 * the same tables under a throwaway prefix and drop them afterwards.
 *
 * Owner column is owner_discord_id, not one of core/privacy-tables.js USER_ID_COLUMNS: /privacy reaches these
 * tables through core/stream-bot/privacy.js (export without secrets, delete of the whole profile).
 */
const JSON_COL = (name, nullable = true) =>
    `\`${name}\` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin ${nullable ? 'DEFAULT NULL' : 'NOT NULL'} CHECK (\`${name}\` IS NULL OR json_valid(\`${name}\`))`;
const TAIL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export function streamBotDdl(prefix = 'stream_bot_') {
    const t = (n) => `\`${prefix}${n}\``;
    return [
        `CREATE TABLE IF NOT EXISTS ${t('profiles')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            owner_discord_id VARCHAR(20) NOT NULL,
            display_name VARCHAR(100) DEFAULT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            store_chat TINYINT(1) NOT NULL DEFAULT 0,
            ${JSON_COL('webhook_allow_hosts')},
            ${JSON_COL('settings')},
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_owner (owner_discord_id)
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('channels')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            platform VARCHAR(16) NOT NULL,
            platform_user_id VARCHAR(64) NOT NULL,
            login VARCHAR(100) DEFAULT NULL,
            display_name VARCHAR(100) DEFAULT NULL,
            verified_via VARCHAR(40) NOT NULL,
            linked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_channel (platform, platform_user_id),
            KEY idx_profile (profile_id),
            CONSTRAINT ${prefix}fk_channels_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('twitch_grants')} (
            profile_id BIGINT UNSIGNED NOT NULL,
            twitch_user_id VARCHAR(32) NOT NULL,
            twitch_login VARCHAR(100) DEFAULT NULL,
            access_token TEXT DEFAULT NULL,
            refresh_token TEXT DEFAULT NULL,
            expires_at DATETIME DEFAULT NULL,
            scopes TEXT DEFAULT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (profile_id),
            KEY idx_twitch_user (twitch_user_id),
            CONSTRAINT ${prefix}fk_grants_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('tip_sources')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            source VARCHAR(20) NOT NULL,
            ref VARCHAR(100) NOT NULL DEFAULT '',
            secret TEXT DEFAULT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            status VARCHAR(40) DEFAULT NULL,
            last_error VARCHAR(255) DEFAULT NULL,
            last_event_at DATETIME DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_source (profile_id, source, ref),
            KEY idx_source_ref (source, ref),
            CONSTRAINT ${prefix}fk_tips_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('events')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            platform VARCHAR(16) NOT NULL,
            type VARCHAR(40) NOT NULL,
            channel_id VARCHAR(64) DEFAULT NULL,
            dedupe_key VARCHAR(120) DEFAULT NULL,
            actor_id VARCHAR(64) DEFAULT NULL,
            actor_login VARCHAR(100) DEFAULT NULL,
            actor_name VARCHAR(100) DEFAULT NULL,
            amount DECIMAL(16,2) DEFAULT NULL,
            currency VARCHAR(12) DEFAULT NULL,
            message VARCHAR(1000) DEFAULT NULL,
            ${JSON_COL('metadata')},
            raw MEDIUMTEXT DEFAULT NULL,
            is_test TINYINT(1) NOT NULL DEFAULT 0,
            occurred_at DATETIME(3) NOT NULL,
            created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (id),
            UNIQUE KEY uq_dedupe (profile_id, dedupe_key),
            KEY idx_profile_time (profile_id, id),
            KEY idx_profile_type (profile_id, type, id),
            KEY idx_actor (platform, actor_id),
            KEY idx_created (created_at),
            CONSTRAINT ${prefix}fk_events_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('automations')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            name VARCHAR(100) NOT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            trigger_type VARCHAR(40) NOT NULL,
            ${JSON_COL('trigger_config')},
            ${JSON_COL('conditions')},
            ${JSON_COL('actions')},
            last_run_at DATETIME DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_profile_trigger (profile_id, trigger_type),
            CONSTRAINT ${prefix}fk_automations_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('runs')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            automation_id BIGINT UNSIGNED DEFAULT NULL,
            automation_name VARCHAR(100) DEFAULT NULL,
            event_id BIGINT UNSIGNED DEFAULT NULL,
            source VARCHAR(16) NOT NULL DEFAULT 'event',
            parent_run_id BIGINT UNSIGNED DEFAULT NULL,
            depth TINYINT UNSIGNED NOT NULL DEFAULT 0,
            dry_run TINYINT(1) NOT NULL DEFAULT 0,
            status VARCHAR(16) NOT NULL DEFAULT 'running',
            skip_reason VARCHAR(160) DEFAULT NULL,
            ${JSON_COL('input')},
            ${JSON_COL('checks')},
            ${JSON_COL('steps')},
            error VARCHAR(500) DEFAULT NULL,
            started_at DATETIME(3) NOT NULL,
            finished_at DATETIME(3) DEFAULT NULL,
            PRIMARY KEY (id),
            KEY idx_profile_time (profile_id, id),
            KEY idx_automation (automation_id, id),
            KEY idx_started (started_at),
            KEY idx_status (status),
            CONSTRAINT ${prefix}fk_runs_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('devices')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            kind VARCHAR(16) NOT NULL,
            name VARCHAR(100) NOT NULL,
            token_hash CHAR(64) NOT NULL,
            token_hint VARCHAR(8) DEFAULT NULL,
            ${JSON_COL('capabilities')},
            client_info VARCHAR(120) DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_seen_at DATETIME DEFAULT NULL,
            revoked_at DATETIME DEFAULT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_token (token_hash),
            KEY idx_profile (profile_id),
            CONSTRAINT ${prefix}fk_devices_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('pairing_codes')} (
            code_hash CHAR(64) NOT NULL,
            profile_id BIGINT UNSIGNED NOT NULL,
            kind VARCHAR(16) NOT NULL DEFAULT 'studio',
            name VARCHAR(100) DEFAULT NULL,
            expires_at DATETIME NOT NULL,
            used_at DATETIME DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (code_hash),
            KEY idx_profile (profile_id),
            KEY idx_created (created_at),
            CONSTRAINT ${prefix}fk_pairing_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('dispatch_queue')} (
            id VARCHAR(40) NOT NULL,
            profile_id BIGINT UNSIGNED NOT NULL,
            run_id BIGINT UNSIGNED DEFAULT NULL,
            target VARCHAR(16) NOT NULL,
            capability VARCHAR(20) DEFAULT NULL,
            action_type VARCHAR(40) NOT NULL,
            ${JSON_COL('params')},
            status VARCHAR(12) NOT NULL DEFAULT 'queued',
            attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
            device_id BIGINT UNSIGNED DEFAULT NULL,
            error VARCHAR(255) DEFAULT NULL,
            ${JSON_COL('result')},
            created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            expires_at DATETIME(3) NOT NULL,
            sent_at DATETIME(3) DEFAULT NULL,
            acked_at DATETIME(3) DEFAULT NULL,
            PRIMARY KEY (id),
            KEY idx_profile_status (profile_id, status, created_at),
            KEY idx_run (run_id),
            KEY idx_created (created_at),
            CONSTRAINT ${prefix}fk_dispatch_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('variables')} (
            profile_id BIGINT UNSIGNED NOT NULL,
            owner VARCHAR(80) NOT NULL,
            key_name VARCHAR(64) NOT NULL,
            value_text TEXT DEFAULT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (profile_id, owner, key_name),
            KEY idx_updated (updated_at),
            CONSTRAINT ${prefix}fk_variables_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
    ];
}

/** Tables in creation order (drop in reverse). */
export const STREAM_BOT_TABLES = Object.freeze([
    'profiles', 'channels', 'twitch_grants', 'tip_sources', 'events', 'automations', 'runs', 'devices',
    'pairing_codes', 'dispatch_queue', 'variables',
]);

export const RETENTION_ROWS = Object.freeze([
    ['stream_bot_events', 'created_at', 90, 'Stream bot event log (follows, subs, tips, chat when kept)'],
    ['stream_bot_runs', 'started_at', 30, 'Stream bot automation run log'],
    ['stream_bot_dispatch_queue', 'created_at', 7, 'Stream bot actions sent to CertiFried Studio and overlays'],
    ['stream_bot_pairing_codes', 'created_at', 1, 'Stream bot device pairing codes (10-minute codes)'],
    ['stream_bot_variables', 'updated_at', 400, 'Stream bot {db:}/{sdb:} values, untouched for 400 days'],
]);

export async function up(db) {
    for (const sql of streamBotDdl('stream_bot_')) await db.query(sql);
    for (const [table, column, days, notes] of RETENTION_ROWS) {
        await db.query(
            `INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes)
             VALUES (?, ?, ?, 1, ?)`, [table, column, days, notes]);
    }
}

export async function down(db) {
    await db.query(`DELETE FROM data_retention_policy WHERE table_name LIKE 'stream\\_bot\\_%'`);
    for (const n of [...STREAM_BOT_TABLES].reverse()) await db.query(`DROP TABLE IF EXISTS \`stream_bot_${n}\``);
}
