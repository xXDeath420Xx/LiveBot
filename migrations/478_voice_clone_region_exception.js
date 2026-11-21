/**
 * Migration 478 (2026-11-21): a super-admin-only region exception on a consent record, and when the owner's attestation
 * was made. The own-voice region rule stays US-only (not IL or TX) for everyone; the CertiFried owner can record a
 * per-person exception with its basis (e.g. a UK resident with explicit written consent, UK GDPR Art. 9(2)(a)). Every
 * exception is also written to voice_clone_events.
 *
 *   voice_clone_consents.attested_at            when the 18+ / residence attestation was recorded
 *   voice_clone_consents.region_exception       e.g. 'UK (exception approved by owner)'
 *   voice_clone_consents.region_exception_basis e.g. 'explicit written consent (UK GDPR Art. 9(2)(a))'
 *   voice_clone_consents.region_exception_by / _at
 */
async function hasColumn(db, table, column) {
    const [r] = await db.query('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, column]);
    return r.length > 0;
}
export function regionAlters(prefix = 'voice_clone_') {
    const c = `${prefix}consents`;
    return [
        [c, 'attested_at', `ALTER TABLE \`${c}\` ADD COLUMN attested_at TIMESTAMP NULL DEFAULT NULL`],
        [c, 'region_exception', `ALTER TABLE \`${c}\` ADD COLUMN region_exception VARCHAR(120) NULL`],
        [c, 'region_exception_basis', `ALTER TABLE \`${c}\` ADD COLUMN region_exception_basis VARCHAR(300) NULL`],
        [c, 'region_exception_by', `ALTER TABLE \`${c}\` ADD COLUMN region_exception_by VARCHAR(20) NULL`],
        [c, 'region_exception_at', `ALTER TABLE \`${c}\` ADD COLUMN region_exception_at TIMESTAMP NULL DEFAULT NULL`],
    ];
}
export async function applyRegionException(db, prefix = 'voice_clone_') {
    for (const [table, column, sql] of regionAlters(prefix)) if (!(await hasColumn(db, table, column))) await db.query(sql);
}
export async function up(db) { await applyRegionException(db, 'voice_clone_'); }
export async function down(db) {
    for (const [table, column] of regionAlters('voice_clone_')) if (await hasColumn(db, table, column)) await db.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
}
export default { up, down, applyRegionException, regionAlters };
