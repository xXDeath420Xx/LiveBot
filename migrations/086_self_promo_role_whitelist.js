/**
 * Migration 086: Self-promo role whitelist
 *
 * Adds `whitelisted_role_ids` JSON array column to self_promo_config so
 * per-guild admins can designate specific roles whose members are allowed
 * to post in the configured self-promo channel without having their
 * messages auto-deleted by the self-promo handler.
 *
 * NULL or empty array = no role-based bypass (preserves prior behavior).
 */
export async function up(db) {
    // Check if column already exists (idempotent for manual re-runs)
    const [cols] = await db.execute(
        `SHOW COLUMNS FROM self_promo_config LIKE 'whitelisted_role_ids'`
    );
    if (cols.length === 0) {
        await db.execute(`
            ALTER TABLE self_promo_config
            ADD COLUMN whitelisted_role_ids LONGTEXT NULL
            COMMENT 'JSON array of role snowflakes allowed to post without deletion'
        `);
    }
}

export async function down(db) {
    const [cols] = await db.execute(
        `SHOW COLUMNS FROM self_promo_config LIKE 'whitelisted_role_ids'`
    );
    if (cols.length > 0) {
        await db.execute(`ALTER TABLE self_promo_config DROP COLUMN whitelisted_role_ids`);
    }
}
