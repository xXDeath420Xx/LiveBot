/**
 * Migration 477 (2026-11-21): own voices made before the live check existed (Bear), and the voice owner's opt-ins.
 * Owner decisions of 2026-11-21 (core/voice-clone/legacy.js):
 *
 *   voice_clone_consents
 *     consent_method   'live_check' (the normal path) | 'written_on_file' (a pre-existing voice: the person's own written
 *                      words, stored verbatim, recorded by the CertiFried owner; no live check for that voice only)
 *     consent_text     the verbatim words (written_on_file)        consent_given_at   when they were written, as shown
 *     consent_channel  e.g. "Discord DM to the owner"             recorded_by        the admin who recorded it
 *     evidence         JSON [{ file, sha256, bytes }]  screenshots kept in ~/certifried-data/voice-consent-evidence
 *     attested_by      who declared 18+ and residence (the owner, on the person's behalf, for written_on_file)
 *     note             free text (what the record does and does not cover)
 *     residence_state  now NULL until it is declared
 *   voice_clone_voices
 *     legacy_voice_id  the piper_models voice this row governs (e.g. 'bear'): its opt-ins, deletion and retraining
 *     model_source     'trained' (our worker) | 'owner_supplied' (uploaded by an admin for the voice owner)
 *     model_attestation JSON: base model, its licence, tool, who attested
 *
 * The opt-ins (viewer text in the owner's own reader and alerts; "I said") live in voices.features with who set them,
 * and every change is in voice_clone_events. Safe to re-run (checks information_schema).
 */
async function hasColumn(db, table, column) {
    const [r] = await db.query('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, column]);
    return r.length > 0;
}

export function legacyAlters(prefix = 'voice_clone_') {
    const c = `${prefix}consents`;
    const v = `${prefix}voices`;
    return [
        [c, 'consent_method', `ALTER TABLE \`${c}\` ADD COLUMN consent_method VARCHAR(20) NOT NULL DEFAULT 'live_check' AFTER purpose`],
        [c, 'consent_text', `ALTER TABLE \`${c}\` ADD COLUMN consent_text MEDIUMTEXT NULL`],
        [c, 'consent_given_at', `ALTER TABLE \`${c}\` ADD COLUMN consent_given_at VARCHAR(80) NULL`],
        [c, 'consent_channel', `ALTER TABLE \`${c}\` ADD COLUMN consent_channel VARCHAR(80) NULL`],
        [c, 'recorded_by', `ALTER TABLE \`${c}\` ADD COLUMN recorded_by VARCHAR(20) NULL`],
        [c, 'evidence', `ALTER TABLE \`${c}\` ADD COLUMN evidence JSON NULL`],
        [c, 'attested_by', `ALTER TABLE \`${c}\` ADD COLUMN attested_by VARCHAR(20) NULL`],
        [c, 'note', `ALTER TABLE \`${c}\` ADD COLUMN note VARCHAR(1000) NULL`],
        [c, null, `ALTER TABLE \`${c}\` MODIFY residence_state CHAR(2) NULL`],
        [v, 'legacy_voice_id', `ALTER TABLE \`${v}\` ADD COLUMN legacy_voice_id VARCHAR(50) NULL, ADD UNIQUE KEY uq_legacy (legacy_voice_id)`],
        [v, 'model_source', `ALTER TABLE \`${v}\` ADD COLUMN model_source VARCHAR(20) NOT NULL DEFAULT 'trained'`],
        [v, 'model_attestation', `ALTER TABLE \`${v}\` ADD COLUMN model_attestation JSON NULL`],
    ];
}

export async function applyLegacy(db, prefix = 'voice_clone_') {
    for (const [table, column, sql] of legacyAlters(prefix)) {
        if (column && await hasColumn(db, table, column)) continue;
        await db.query(sql);
    }
}

export async function up(db) { await applyLegacy(db, 'voice_clone_'); }

export async function down(db) {
    for (const [table, column] of legacyAlters('voice_clone_')) {
        if (column && await hasColumn(db, table, column)) await db.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
    }
}

export default { up, down, applyLegacy, legacyAlters };
