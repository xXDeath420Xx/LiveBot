/**
 * Migration 473: Last.fm links can be verified (fix wave 7, 2026-11-20: the H-817 caveat, Last.fm links were not ownership-checked).
 *
 *   lastfm_accounts.verified_username  the Last.fm account that approved CertiFried on last.fm (web auth,
 *                                      utils/services/lastfm-auth.js). The link counts as verified while it equals
 *                                      lastfm_username (case-insensitive); linking another name makes it unverified.
 *   lastfm_accounts.verified_at        when that was checked.
 *
 * Dedicated Scrobbler is awarded only for a verified link (handlers/music/lastfm.js). No session key is stored.
 * Existing links stay as they are (unverified) and keep working for every lookup.
 * Safe to re-run: each column is added only when it is missing; nothing happens without the table.
 */
async function columnExists(db, table, column) {
    const [rows] = await db.execute(
        'SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
    return Number(rows[0].n) > 0;
}

export async function up(db) {
    const [t] = await db.execute(
        "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'lastfm_accounts'");
    if (!Number(t[0].n)) return;
    if (!(await columnExists(db, 'lastfm_accounts', 'verified_username'))) {
        await db.execute('ALTER TABLE lastfm_accounts ADD COLUMN verified_username VARCHAR(255) NULL DEFAULT NULL AFTER lastfm_username');
    }
    if (!(await columnExists(db, 'lastfm_accounts', 'verified_at'))) {
        await db.execute('ALTER TABLE lastfm_accounts ADD COLUMN verified_at DATETIME NULL DEFAULT NULL AFTER verified_username');
    }
}

export async function down(db) {
    if (await columnExists(db, 'lastfm_accounts', 'verified_at')) await db.execute('ALTER TABLE lastfm_accounts DROP COLUMN verified_at');
    if (await columnExists(db, 'lastfm_accounts', 'verified_username')) await db.execute('ALTER TABLE lastfm_accounts DROP COLUMN verified_username');
}
