/**
 * Migration 455 — stream bot import from Firebot and Streamer.bot (docs/superpowers/specs/2026-11-19-stream-bot-design.md §6).
 *
 *   stream_bot_imports       one row per import run: which sources and categories, the counts and the mapping report
 *   stream_bot_import_items  one row per imported source item (profile, source, kind, source id): what it became
 *                            (target kind and id) and, for channel point rewards, the saved definition. Re-importing
 *                            looks items up here, so nothing is created twice.
 *
 * Both hang off stream_bot_profiles with ON DELETE CASCADE, so deleting a profile (/privacy delete) removes them;
 * core/stream-bot/import/privacy.js adds them to the /privacy export. Neither holds credentials (the importer
 * strips them before anything is stored).
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS, INSERT IGNORE). `importDdl(prefix)` builds the same tables under a test
 * prefix next to the throwaway tables of migration 454.
 */
const JSON_COL = (name) =>
    `\`${name}\` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (\`${name}\` IS NULL OR json_valid(\`${name}\`))`;
const TAIL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export function importDdl(prefix = 'stream_bot_') {
    const t = (n) => `\`${prefix}${n}\``;
    return [
        `CREATE TABLE IF NOT EXISTS ${t('imports')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            sources VARCHAR(60) NOT NULL,
            file_names VARCHAR(255) DEFAULT NULL,
            ${JSON_COL('categories')},
            ${JSON_COL('summary')},
            ${JSON_COL('report')},
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_profile (profile_id, id),
            KEY idx_created (created_at),
            CONSTRAINT ${prefix}fk_imports_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('import_items')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            import_id BIGINT UNSIGNED DEFAULT NULL,
            source VARCHAR(16) NOT NULL,
            kind VARCHAR(24) NOT NULL,
            source_id VARCHAR(191) NOT NULL,
            name VARCHAR(150) DEFAULT NULL,
            status VARCHAR(16) NOT NULL,
            target_kind VARCHAR(24) DEFAULT NULL,
            target_ref VARCHAR(255) DEFAULT NULL,
            ${JSON_COL('data')},
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_source_item (profile_id, source, kind, source_id),
            KEY idx_target (profile_id, target_kind),
            CONSTRAINT ${prefix}fk_import_items_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
    ];
}

export const IMPORT_TABLES = Object.freeze(['imports', 'import_items']);

export const RETENTION_ROWS = Object.freeze([
    ['stream_bot_imports', 'created_at', 400, 'Stream bot import runs and their mapping reports (Firebot / Streamer.bot)'],
]);

export async function up(db) {
    for (const sql of importDdl('stream_bot_')) await db.query(sql);
    for (const [table, column, days, notes] of RETENTION_ROWS) {
        await db.query(
            `INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes)
             VALUES (?, ?, ?, 1, ?)`, [table, column, days, notes]);
    }
}

export async function down(db) {
    await db.query(`DELETE FROM data_retention_policy WHERE table_name IN ('stream_bot_imports')`);
    for (const n of [...IMPORT_TABLES].reverse()) await db.query(`DROP TABLE IF EXISTS \`stream_bot_${n}\``);
}
