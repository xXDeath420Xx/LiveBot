/**
 * Migration 336 — Throne full profile columns.
 *
 * Captures every field surfaced by the new Firestore-direct `fetchThroneProfile` (Track A of
 * the Hashbot-parity+ programme's post-wave work), replacing the old Vercel-SSR path. All
 * columns are nullable so the migration is strictly additive — existing rows stay valid; the
 * next scheduler cycle backfills them per creator.
 *
 * Related: utils/scrapers/throne-scraper.js (rewrite), core/throne-manager.js (writer +
 * flag-aware posters), jobs/throne-scheduler.js (10 min → 2 min cadence).
 */
export async function up(pool) {
    const [existing] = await pool.execute(
        "SHOW COLUMNS FROM throne_cached_profiles",
    );
    const have = new Set(existing.map(r => r.Field));

    const toAdd = [
        ['internal_id',                       "VARCHAR(100) NULL"],
        ['allow_gifter_name',                 "TINYINT(1) NULL"],
        ['allow_gift_messages',               "TINYINT(1) NULL"],
        ['allow_suggestion_messages',         "TINYINT(1) NULL"],
        ['allow_suggestions',                 "TINYINT(1) NULL"],
        ['allow_previous_gift_product_links', "TINYINT(1) NULL"],
        ['show_leaderboard',                  "TINYINT(1) NULL"],
        ['show_leaderboard_amounts',          "TINYINT(1) NULL"],
        ['show_previous_gifts',               "TINYINT(1) NULL"],
        ['show_recent_gifters',               "TINYINT(1) NULL"],
        ['show_wishlist',                     "TINYINT(1) NULL"],
        ['show_storefront',                   "TINYINT(1) NULL"],
        ['hide_gifter_messages',              "TINYINT(1) NULL"],
        ['hide_own_purchases',                "TINYINT(1) NULL"],
        ['is_nsfw',                           "TINYINT(1) NULL"],
        ['blur_nsfw_products',                "TINYINT(1) NULL"],
        ['is_off_waitlist',                   "TINYINT(1) NULL"],
        ['needs_verification',                "TINYINT(1) NULL"],
        ['creator_page_customization',        "JSON NULL"],
        ['updated_at_throne',                 "BIGINT(20) NULL"],
        ['wishlist_enabled_at',               "BIGINT(20) NULL"],
    ];

    for (const [name, def] of toAdd) {
        if (!have.has(name)) {
            // eslint-disable-next-line no-await-in-loop
            await pool.execute(`ALTER TABLE throne_cached_profiles ADD COLUMN ${name} ${def}`);
        }
    }

    // Index the internal_id so the manager's "lookup creator by internal_id" path during a
    // seen-gift diff doesn't scan the whole table once we have the ID populated.
    const [idx] = await pool.execute(
        "SHOW INDEX FROM throne_cached_profiles WHERE Key_name = 'idx_throne_internal_id'",
    );
    if (!idx.length) {
        await pool.execute(
            "ALTER TABLE throne_cached_profiles ADD INDEX idx_throne_internal_id (internal_id)",
        );
    }
}

export async function down(pool) {
    // Reversible: drops only columns + index this migration added. Call only via explicit
    // rollback — standard migration pattern.
    const columns = [
        'internal_id', 'allow_gifter_name', 'allow_gift_messages', 'allow_suggestion_messages',
        'allow_suggestions', 'allow_previous_gift_product_links', 'show_leaderboard',
        'show_leaderboard_amounts', 'show_previous_gifts', 'show_recent_gifters', 'show_wishlist',
        'show_storefront', 'hide_gifter_messages', 'hide_own_purchases', 'is_nsfw',
        'blur_nsfw_products', 'is_off_waitlist', 'needs_verification',
        'creator_page_customization', 'updated_at_throne', 'wishlist_enabled_at',
    ];
    try { await pool.execute("ALTER TABLE throne_cached_profiles DROP INDEX idx_throne_internal_id"); } catch { /* ok */ }
    for (const c of columns) {
        try {
            // eslint-disable-next-line no-await-in-loop
            await pool.execute(`ALTER TABLE throne_cached_profiles DROP COLUMN ${c}`);
        } catch { /* already dropped */ }
    }
}
