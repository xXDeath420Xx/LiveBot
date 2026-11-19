/**
 * Migration 341 — Fourthwall catalog v2.
 *
 * Covers items 1, 2, 4, 5 of the Fourthwall analysis follow-up list:
 *   1. Enriched product snapshots (internal UUID, variants, images, variant signature)
 *   2. Variant-level notification toggles on tracked shops
 *   4. Low-stock cooldown table so a chronically-low variant doesn't re-fire every cycle
 *   5. Price history table for sale detection vs 30-day baseline
 *
 * Item 3 (slug-rename via internal_product_id) uses the column added in step 1 here but
 * needs no additional schema.
 *
 * Idempotent: safe to re-run. Columns are added only when missing; tables only when absent.
 * Apply directly via `import { up } and call up(pool)` (migrations/run.js is unreliable).
 */
async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]);
    return rows.length > 0;
}
async function hasTable(db, table) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table]);
    return rows.length > 0;
}

export async function up(db) {
    // ─── 1. Enriched product columns ────────────────────────────────────────
    if (!(await hasColumn(db, 'fourthwall_tracked_products', 'internal_product_id'))) {
        await db.execute(
            `ALTER TABLE fourthwall_tracked_products
             ADD COLUMN internal_product_id VARCHAR(40) NULL AFTER slug,
             ADD INDEX idx_internal_product (shop_handle, internal_product_id)`);
    }
    if (!(await hasColumn(db, 'fourthwall_tracked_products', 'variants_json'))) {
        await db.execute(
            `ALTER TABLE fourthwall_tracked_products
             ADD COLUMN variants_json LONGTEXT NULL AFTER currency`);
    }
    if (!(await hasColumn(db, 'fourthwall_tracked_products', 'images_json'))) {
        await db.execute(
            `ALTER TABLE fourthwall_tracked_products
             ADD COLUMN images_json LONGTEXT NULL AFTER image_url`);
    }
    if (!(await hasColumn(db, 'fourthwall_tracked_products', 'last_variant_signature'))) {
        await db.execute(
            `ALTER TABLE fourthwall_tracked_products
             ADD COLUMN last_variant_signature VARCHAR(64) NULL`);
    }

    // ─── 2. Variant notification toggles on subscriptions ───────────────────
    for (const col of [
        'notify_variant_added', 'notify_variant_restocked', 'notify_variant_low_stock',
        'notify_variant_sold_out', 'notify_name_changed', 'notify_image_changed',
        'notify_product_renamed', 'notify_on_sale',
    ]) {
        if (!(await hasColumn(db, 'fourthwall_tracked_shops', col))) {
            // Default 1 for events owners usually want to see; 0 for noisier image/rename signals.
            const defaultVal = ['notify_name_changed', 'notify_image_changed', 'notify_variant_added'].includes(col)
                ? 0 : 1;
            await db.execute(
                `ALTER TABLE fourthwall_tracked_shops ADD COLUMN ${col} TINYINT(1) DEFAULT ${defaultVal}`);
        }
    }

    // ─── 4. Low-stock cooldown state ────────────────────────────────────────
    if (!(await hasTable(db, 'fourthwall_variant_state'))) {
        await db.execute(`CREATE TABLE fourthwall_variant_state (
            shop_handle VARCHAR(100) NOT NULL,
            slug VARCHAR(200) NOT NULL,
            variant_id VARCHAR(64) NOT NULL,
            last_low_stock_announced_at TIMESTAMP NULL,
            last_restock_announced_at TIMESTAMP NULL,
            last_sold_out_announced_at TIMESTAMP NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (shop_handle, slug, variant_id),
            INDEX idx_shop (shop_handle)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    // ─── 5. Price history for sale detection ────────────────────────────────
    if (!(await hasTable(db, 'fourthwall_price_history'))) {
        await db.execute(`CREATE TABLE fourthwall_price_history (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            shop_handle VARCHAR(100) NOT NULL,
            slug VARCHAR(200) NOT NULL,
            variant_id VARCHAR(64) NULL,
            price_minor_units INT NOT NULL,
            currency VARCHAR(8) NOT NULL DEFAULT 'USD',
            recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_product_time (shop_handle, slug, recorded_at),
            INDEX idx_recent (recorded_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }
}

export async function down(db) {
    for (const col of [
        'notify_variant_added', 'notify_variant_restocked', 'notify_variant_low_stock',
        'notify_variant_sold_out', 'notify_name_changed', 'notify_image_changed',
        'notify_product_renamed', 'notify_on_sale',
    ]) {
        try { await db.execute(`ALTER TABLE fourthwall_tracked_shops DROP COLUMN ${col}`); } catch { /* ok */ }
    }
    for (const col of ['internal_product_id', 'variants_json', 'images_json', 'last_variant_signature']) {
        try { await db.execute(`ALTER TABLE fourthwall_tracked_products DROP COLUMN ${col}`); } catch { /* ok */ }
    }
    try { await db.execute(`ALTER TABLE fourthwall_tracked_products DROP INDEX idx_internal_product`); } catch { /* ok */ }
    try { await db.execute(`DROP TABLE IF EXISTS fourthwall_variant_state`); } catch { /* ok */ }
    try { await db.execute(`DROP TABLE IF EXISTS fourthwall_price_history`); } catch { /* ok */ }
}
