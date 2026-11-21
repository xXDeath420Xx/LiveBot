/**
 * Migration 476 (2026-11-20): the own-voice feature (voice cloning), invite-only. core/voice-clone, design
 * voice-cloning-design.md with the owner's decisions of 2026-11-20 (core/voice-clone/constants.js).
 *
 *   voice_clone_invites      who may use it (permanently invite-only; the owner adds people on /super-admin/voice)
 *   voice_clone_voices       one row per voice: status, the wrapped data key, the encrypted consent voiceprint, the
 *                            watermark id, tuning, the model's hash. A deleted voice stays as a tombstone with no key,
 *                            no voiceprint and no files. One live (not deleted) voice per person (uq_live_owner).
 *   voice_clone_samples      the recordings (files are encrypted in ~/certifried-data/voice/<voice>/samples)
 *   voice_clone_consents     the signed consent: text version and hash, typed name (encrypted), state, 18+ attested,
 *                            IP hash, live-check scores. No audio or voiceprint. Kept 5 years after it is revoked.
 *   voice_clone_jobs         training jobs for the PC worker (loopback API, core/voice-clone/worker-api.js)
 *   voice_clone_events       audit trail
 *   voice_clone_usage_daily  synthesis counters for the daily limits
 *   voice_clone_gpu_daily    GPU seconds per Pacific day (the 4-hour cap)
 *
 * Retention (data_retention_policy, jobs/retention-sweeper.js SWEEP_GUARDS): sample rows 30 days, only once their
 * file is purged (the voice janitor deletes files 7 days after training, 30 days at most); voice tombstones 365 days
 * after last use, only once deleted with files removed (the janitor deletes voices idle for 365 days through
 * deleteVoice()); consents 1825 days after revoked_at; jobs and events 400 days; usage and GPU counters 90 days;
 * withdrawn invites 400 days.
 *
 * Safe to re-run: CREATE TABLE IF NOT EXISTS, INSERT IGNORE. `voiceCloneDdl(prefix)` builds the same tables under a test prefix.
 * Seeds an invite for BOT_OWNER_ID (the owner, stream bot profile 2). Run: npm run migrate -- 476_voice_clone.js
 */
const TAIL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export const VOICE_CLONE_TABLES = Object.freeze(['invites', 'voices', 'samples', 'consents', 'jobs', 'events', 'usage_daily', 'gpu_daily']);

export const RETENTION_ROWS = Object.freeze([
    ['voice_clone_samples', 'created_at', 30, 'Own voice: recording rows, 30 days hard cap; the voice janitor purges the encrypted file first (guard: purged)'],
    ['voice_clone_voices', 'last_used_at', 365, 'Own voice: idle voices are deleted by deleteVoice() at 365 days; the tombstone row goes after (guard: deleted)'],
    ['voice_clone_consents', 'revoked_at', 1825, 'Own voice: consent records (no audio or voiceprint), 5 years after the voice is deleted'],
    ['voice_clone_jobs', 'created_at', 400, 'Own voice: training jobs'],
    ['voice_clone_events', 'created_at', 400, 'Own voice: audit trail'],
    ['voice_clone_usage_daily', 'day', 90, 'Own voice: daily synthesis counters'],
    ['voice_clone_gpu_daily', 'day', 90, 'Own voice: GPU seconds used per day on the training PC'],
    ['voice_clone_invites', 'revoked_at', 400, 'Own voice: withdrawn invites'],
]);

export function voiceCloneDdl(prefix = 'voice_clone_') {
    const t = (n) => `\`${prefix}${n}\``;
    return [
        `CREATE TABLE IF NOT EXISTS ${t('invites')} (
            user_id VARCHAR(20) NOT NULL,
            invited_by VARCHAR(20) NOT NULL,
            note VARCHAR(200) DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            revoked_at TIMESTAMP NULL DEFAULT NULL,
            revoked_by VARCHAR(20) DEFAULT NULL,
            PRIMARY KEY (user_id),
            KEY idx_revoked (revoked_at)
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('voices')} (
            id VARCHAR(32) NOT NULL,
            owner_user_id VARCHAR(20) NOT NULL,
            display_name VARCHAR(60) NOT NULL,
            status ENUM('draft','consent_ok','queued','training','review','active','suspended','deleted') NOT NULL DEFAULT 'draft',
            engine VARCHAR(16) NOT NULL DEFAULT 'piper',
            base_model CHAR(64) NOT NULL,
            model_sha256 CHAR(64) DEFAULT NULL,
            model_json MEDIUMTEXT DEFAULT NULL,
            data_key_encrypted VARCHAR(255) DEFAULT NULL,
            centroid_encrypted MEDIUMTEXT DEFAULT NULL,
            wm_id SMALLINT UNSIGNED NOT NULL,
            tuning JSON DEFAULT NULL,
            features JSON DEFAULT NULL,
            consent_id BIGINT UNSIGNED DEFAULT NULL,
            keep_samples TINYINT(1) NOT NULL DEFAULT 0,
            review_note VARCHAR(300) DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            trained_at TIMESTAMP NULL DEFAULT NULL,
            user_approved_at TIMESTAMP NULL DEFAULT NULL,
            admin_approved_at TIMESTAMP NULL DEFAULT NULL,
            approved_at TIMESTAMP NULL DEFAULT NULL,
            last_used_at TIMESTAMP NULL DEFAULT NULL,
            suspended_at TIMESTAMP NULL DEFAULT NULL,
            deleted_at TIMESTAMP NULL DEFAULT NULL,
            files_removed_at TIMESTAMP NULL DEFAULT NULL,
            delete_reason VARCHAR(40) DEFAULT NULL,
            live_owner VARCHAR(20) AS (IF(status <> 'deleted', owner_user_id, NULL)) STORED,
            live_wm SMALLINT UNSIGNED AS (IF(status <> 'deleted', wm_id, NULL)) STORED,
            PRIMARY KEY (id),
            UNIQUE KEY uq_live_owner (live_owner),
            UNIQUE KEY uq_live_wm (live_wm),
            KEY idx_owner (owner_user_id),
            KEY idx_status (status),
            KEY idx_wm (wm_id)
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('samples')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            voice_id VARCHAR(32) NOT NULL,
            kind ENUM('recorded','consent') NOT NULL DEFAULT 'recorded',
            prompt_index INT DEFAULT NULL,
            prompt_text VARCHAR(400) DEFAULT NULL,
            duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
            sha256 CHAR(64) DEFAULT NULL,
            file_name VARCHAR(80) DEFAULT NULL,
            asr_wer DECIMAL(5,3) DEFAULT NULL,
            score_redimnet DECIMAL(6,4) DEFAULT NULL,
            score_ecapa DECIMAL(6,4) DEFAULT NULL,
            checks JSON DEFAULT NULL,
            status ENUM('ok','rejected','purged') NOT NULL DEFAULT 'ok',
            reason VARCHAR(160) DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            purged_at TIMESTAMP NULL DEFAULT NULL,
            PRIMARY KEY (id),
            KEY idx_voice (voice_id, status),
            KEY idx_created (created_at)
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('consents')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            user_id VARCHAR(20) NOT NULL,
            voice_id VARCHAR(32) DEFAULT NULL,
            purpose VARCHAR(16) NOT NULL DEFAULT 'voice',
            text_version VARCHAR(24) NOT NULL,
            text_sha256 CHAR(64) NOT NULL,
            typed_name_encrypted VARCHAR(600) NOT NULL,
            age_attested TINYINT(1) NOT NULL,
            own_voice_attested TINYINT(1) NOT NULL,
            residence_state CHAR(2) NOT NULL,
            residence_country CHAR(2) NOT NULL DEFAULT 'US',
            cf_country CHAR(2) DEFAULT NULL,
            cf_region VARCHAR(8) DEFAULT NULL,
            ip_hash CHAR(64) DEFAULT NULL,
            keep_samples TINYINT(1) NOT NULL DEFAULT 0,
            asr_wer DECIMAL(5,3) DEFAULT NULL,
            score_redimnet DECIMAL(6,4) DEFAULT NULL,
            score_ecapa DECIMAL(6,4) DEFAULT NULL,
            threshold_version VARCHAR(40) DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            verified_at TIMESTAMP NULL DEFAULT NULL,
            revoked_at TIMESTAMP NULL DEFAULT NULL,
            revoke_reason VARCHAR(40) DEFAULT NULL,
            PRIMARY KEY (id),
            KEY idx_user (user_id),
            KEY idx_voice (voice_id),
            KEY idx_revoked (revoked_at)
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('jobs')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            voice_id VARCHAR(32) NOT NULL,
            state ENUM('queued','leased','running','paused','uploading','checking','done','failed','cancelled') NOT NULL DEFAULT 'queued',
            attempt TINYINT UNSIGNED NOT NULL DEFAULT 0,
            lease_token_hash CHAR(64) DEFAULT NULL,
            worker_id VARCHAR(64) DEFAULT NULL,
            leased_until TIMESTAMP NULL DEFAULT NULL,
            last_heartbeat_at TIMESTAMP NULL DEFAULT NULL,
            step INT UNSIGNED NOT NULL DEFAULT 0,
            total_steps INT UNSIGNED NOT NULL DEFAULT 0,
            eta_s INT UNSIGNED DEFAULT NULL,
            pause_reason VARCHAR(40) DEFAULT NULL,
            error VARCHAR(300) DEFAULT NULL,
            artifact_sha256 CHAR(64) DEFAULT NULL,
            artifact_score_redimnet DECIMAL(6,4) DEFAULT NULL,
            artifact_score_ecapa DECIMAL(6,4) DEFAULT NULL,
            purge_receipt_at TIMESTAMP NULL DEFAULT NULL,
            purge_files INT UNSIGNED DEFAULT NULL,
            purge_bytes BIGINT UNSIGNED DEFAULT NULL,
            gpu_seconds INT UNSIGNED NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            started_at TIMESTAMP NULL DEFAULT NULL,
            finished_at TIMESTAMP NULL DEFAULT NULL,
            PRIMARY KEY (id),
            KEY idx_voice (voice_id, state),
            KEY idx_state (state, id),
            KEY idx_created (created_at)
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('events')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            voice_id VARCHAR(32) DEFAULT NULL,
            user_id VARCHAR(20) DEFAULT NULL,
            actor VARCHAR(10) NOT NULL,
            event VARCHAR(40) NOT NULL,
            detail JSON DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_voice (voice_id, id),
            KEY idx_user (user_id, id),
            KEY idx_created (created_at)
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('usage_daily')} (
            user_id VARCHAR(20) NOT NULL,
            day DATE NOT NULL,
            chars INT UNSIGNED NOT NULL DEFAULT 0,
            audio_ms INT UNSIGNED NOT NULL DEFAULT 0,
            requests INT UNSIGNED NOT NULL DEFAULT 0,
            PRIMARY KEY (user_id, day),
            KEY idx_day (day)
        ) ${TAIL}`,
        `CREATE TABLE IF NOT EXISTS ${t('gpu_daily')} (
            day DATE NOT NULL,
            gpu_seconds INT UNSIGNED NOT NULL DEFAULT 0,
            PRIMARY KEY (day)
        ) ${TAIL}`,
    ];
}

export async function up(db) {
    for (const sql of voiceCloneDdl('voice_clone_')) await db.query(sql);
    for (const [table, column, days, notes] of RETENTION_ROWS) {
        await db.query('INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES (?, ?, ?, 1, ?)',
            [table, column, days, notes]);
    }
    const owner = String(process.env.BOT_OWNER_ID || '');
    if (/^\d{15,20}$/.test(owner)) {
        await db.query("INSERT IGNORE INTO voice_clone_invites (user_id, invited_by, note) VALUES (?, ?, 'The owner (seeded by migration 476)')", [owner, owner]);
    }
}

export async function down(db) {
    await db.query(`DELETE FROM data_retention_policy WHERE table_name IN (${RETENTION_ROWS.map(() => '?').join(', ')})`, RETENTION_ROWS.map((r) => r[0]));
    for (const n of [...VOICE_CLONE_TABLES].reverse()) await db.query(`DROP TABLE IF EXISTS \`voice_clone_${n}\``);
}

export default { up, down, voiceCloneDdl, VOICE_CLONE_TABLES, RETENTION_ROWS };
