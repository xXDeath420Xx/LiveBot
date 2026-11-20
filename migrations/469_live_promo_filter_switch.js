/**
 * Migration 469: a switch for the live-promotion filter (register H-811, 2026-11-20).
 *
 *   self_promo_config.live_promo_filter  1 (default, as before) = delete "I'm live" posts from non-moderators
 *                                        outside self-promo channels (events/messageCreate.js); 0 = off.
 *
 * The filter ran in every server with no way to turn it off. A server without a self_promo_config row keeps
 * it on. Until this runs, the code treats the missing column as on, and the Self-promo page says the switch
 * cannot be saved yet.
 *
 * Idempotent and guarded: a missing table or an existing column is skipped, never an error.
 */
async function columnExists(db, table, column) {
    const [rows] = await db.execute(
        'SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
    return Number(rows[0].n) > 0;
}

export async function up(db) {
    const [t] = await db.execute(
        "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'self_promo_config'");
    if (!Number(t[0].n)) return;
    if (!(await columnExists(db, 'self_promo_config', 'live_promo_filter'))) {
        await db.execute('ALTER TABLE self_promo_config ADD COLUMN live_promo_filter TINYINT(1) NOT NULL DEFAULT 1');
    }
}

export async function down(db) {
    if (await columnExists(db, 'self_promo_config', 'live_promo_filter')) {
        await db.execute('ALTER TABLE self_promo_config DROP COLUMN live_promo_filter');
    }
}
