/*
 * Tables for Discord's outgoing-webhook push events (dashboard/routes/webhooks/discord-events.js):
 *   • `discord_webhook_events` — raw envelope log; dedup/debug trail
 *   • `discord_app_installs`   — one row per APPLICATION_AUTHORIZED signal; where
 *                                we see installs that happen while the shards are down
 *
 * ENTITLEMENT_CREATE pushes also come in through this endpoint, but the gateway's
 * events/entitlementCreate.js handler already writes those into `audit_logs`; the
 * webhook path just logs an envelope row and relies on the gateway for the
 * guild-scoped audit entry.
 */
async function tableExists(db, name) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
        [name]
    );
    return rows.length > 0;
}

export async function up(db) {
    if (!(await tableExists(db, 'discord_webhook_events'))) {
        await db.execute(`
            CREATE TABLE discord_webhook_events (
                id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
                event_type      VARCHAR(64)  NULL,
                application_id  VARCHAR(32)  NULL,
                payload         JSON         NOT NULL,
                received_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_event_type (event_type),
                INDEX idx_received_at (received_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
    }
    if (!(await tableExists(db, 'discord_app_installs'))) {
        await db.execute(`
            CREATE TABLE discord_app_installs (
                id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
                user_id           VARCHAR(32) NULL,
                guild_id          VARCHAR(32) NULL,
                integration_type  TINYINT     NULL,
                scopes            JSON        NOT NULL,
                authorized_at     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user (user_id),
                INDEX idx_guild (guild_id),
                INDEX idx_authorized_at (authorized_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
    }
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS discord_app_installs');
    await db.execute('DROP TABLE IF EXISTS discord_webhook_events');
}
