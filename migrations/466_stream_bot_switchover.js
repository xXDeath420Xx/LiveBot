/**
 * Migration 466 — the one-click switchover from Firebot / Streamer.bot (docs/superpowers/specs/2026-11-19-stream-bot-design.md §12,
 * core/stream-bot/switchover.js).
 *
 *   stream_bot_switchovers   one row per switchover a streamer pressed: what it did (turned on, left alone, OBS show/hide,
 *                            apps closed) and the exact previous state Undo puts back (each automation's, channel command's
 *                            and timer's enabled flag, each OBS scene item's visibility as Studio reported it). Status:
 *                            applied, partial (OBS or Studio did not answer), undone.
 *
 * Hangs off stream_bot_profiles with ON DELETE CASCADE, so /privacy delete (the profile) removes it; core/stream-bot/import/privacy.js
 * adds it to the /privacy export. No viewer data, no credentials: ids, names of the streamer's own automations and OBS sources.
 * Retention: 400 days on created_at (data_retention_policy), like the import runs it belongs to.
 *
 * Guarded: when stream_bot_profiles is missing (migration 454 not applied) nothing is created and the run says so.
 * Idempotent (CREATE TABLE IF NOT EXISTS, INSERT IGNORE). `switchoverDdl(prefix)` builds the same table under a test prefix.
 */
const JSON_COL = (name) =>
    `\`${name}\` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (\`${name}\` IS NULL OR json_valid(\`${name}\`))`;
const TAIL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export function switchoverDdl(prefix = 'stream_bot_') {
    const t = (n) => `\`${prefix}${n}\``;
    return [
        `CREATE TABLE IF NOT EXISTS ${t('switchovers')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            profile_id BIGINT UNSIGNED NOT NULL,
            status VARCHAR(16) NOT NULL,
            ${JSON_COL('plan')},
            ${JSON_COL('previous')},
            ${JSON_COL('result')},
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            undone_at TIMESTAMP NULL DEFAULT NULL,
            PRIMARY KEY (id),
            KEY idx_profile (profile_id, id),
            KEY idx_created (created_at),
            CONSTRAINT ${prefix}fk_switchovers_profile FOREIGN KEY (profile_id) REFERENCES ${t('profiles')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
    ];
}

export const SWITCHOVER_TABLES = Object.freeze(['switchovers']);
export const RETENTION_ROWS = Object.freeze([
    ['stream_bot_switchovers', 'created_at', 400, 'Stream bot switchovers from Firebot / Streamer.bot and the state Undo restores'],
]);

async function tableExists(db, name) {
    const [rows] = await db.query('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [name]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await tableExists(db, 'stream_bot_profiles'))) {
        console.warn('[466] stream_bot_profiles is missing (apply migration 454 first); nothing created');
        return;
    }
    for (const sql of switchoverDdl('stream_bot_')) await db.query(sql);
    if (await tableExists(db, 'data_retention_policy')) {
        for (const [table, column, days, notes] of RETENTION_ROWS) {
            await db.query(`INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES (?, ?, ?, 1, ?)`, [table, column, days, notes]);
        }
    }
}

export async function down(db) {
    if (await tableExists(db, 'data_retention_policy')) await db.query(`DELETE FROM data_retention_policy WHERE table_name IN ('stream_bot_switchovers')`);
    for (const n of [...SWITCHOVER_TABLES].reverse()) await db.query(`DROP TABLE IF EXISTS \`stream_bot_${n}\``);
}

export default { up, down };
