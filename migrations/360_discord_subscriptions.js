/*
 * `discord_subscriptions` — read-only observatory for Discord's premium-app
 * subscription lifecycle. Populated by events/subscription{Create,Update,Delete}.js
 * once a bot deployment ever enables monetization. CertiFried itself does not
 * charge users ([No User Charging] memory); this table exists so branded-bot
 * deployments that do enable SKUs have a durable record of the full lifecycle,
 * including `renewal_sku_ids` and `canceled_at`.
 *
 * Idempotent create (no-op when the table already exists).
 */
async function tableExists(db, name) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
        [name]
    );
    return rows.length > 0;
}

export async function up(db) {
    if (await tableExists(db, 'discord_subscriptions')) return;

    await db.execute(`
        CREATE TABLE discord_subscriptions (
            subscription_id       VARCHAR(32) PRIMARY KEY,
            user_id               VARCHAR(32) NOT NULL,
            status                VARCHAR(16) NULL,
            country               VARCHAR(8)  NULL,
            sku_ids               JSON        NOT NULL,
            renewal_sku_ids       JSON        NOT NULL,
            entitlement_ids       JSON        NOT NULL,
            current_period_start  DATETIME    NULL,
            current_period_end    DATETIME    NULL,
            canceled_at           DATETIME    NULL,
            lifecycle             ENUM('create','update','delete') NOT NULL DEFAULT 'create',
            created_at            DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at            DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_user     (user_id),
            INDEX idx_status   (status),
            INDEX idx_lifecycle (lifecycle),
            INDEX idx_period_end (current_period_end)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS discord_subscriptions');
}
