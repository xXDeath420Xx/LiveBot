/**
 * Migration 337 — Throne webhook probe (Phase 2 scaffolding).
 *
 *   throne_webhook_subscriptions   per (guild_id, channel_id) opaque token → bound Discord target.
 *                                  secret stays NULL until we SEE Throne's signature header
 *                                  (purpose='probe'); once promoted (purpose='production') the
 *                                  secret is required and HMAC verification runs.
 *   throne_webhook_events          every raw inbound event, keyed by subscription + sha256(body)
 *                                  so Throne retries do not duplicate downstream Discord posts.
 *
 * Both tables are new. The probe table deliberately stores headers + body verbatim so Phase 2
 * can read the exact shape (which header carries the signature, event-type field name, nested
 * payload layout) off the first real fire without needing another deploy.
 *
 * Apply directly: `import { up } and call up(pool)` (migrations/run.js is unreliable).
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [table]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasTable(db, 'throne_webhook_subscriptions'))) {
        await db.execute(`CREATE TABLE throne_webhook_subscriptions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            token CHAR(64) NOT NULL UNIQUE,
            guild_id VARCHAR(20) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            throne_username VARCHAR(100) NULL,
            secret VARCHAR(255) NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            purpose ENUM('probe','production') NOT NULL DEFAULT 'probe',
            created_by VARCHAR(20) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_event_at TIMESTAMP NULL,
            event_count INT NOT NULL DEFAULT 0,
            notes TEXT NULL,
            INDEX idx_guild_channel (guild_id, channel_id),
            INDEX idx_purpose (purpose, enabled)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    }
    if (!(await hasTable(db, 'throne_webhook_events'))) {
        await db.execute(`CREATE TABLE throne_webhook_events (
            id INT AUTO_INCREMENT PRIMARY KEY,
            subscription_id INT NOT NULL,
            event_type VARCHAR(100) NULL,
            event_id VARCHAR(100) NULL,
            signature_header VARCHAR(100) NULL,
            signature_value VARCHAR(255) NULL,
            headers JSON NOT NULL,
            body LONGTEXT NOT NULL,
            raw_sha256 CHAR(64) NOT NULL,
            received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            posted_discord TINYINT(1) NOT NULL DEFAULT 0,
            processed_at TIMESTAMP NULL,
            error TEXT NULL,
            UNIQUE KEY uq_dedup (subscription_id, raw_sha256),
            INDEX idx_received (received_at),
            CONSTRAINT fk_throne_webhook_sub FOREIGN KEY (subscription_id)
                REFERENCES throne_webhook_subscriptions(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    }
}

export async function down(db) {
    try { await db.execute('DROP TABLE IF EXISTS throne_webhook_events'); } catch { /* ok */ }
    try { await db.execute('DROP TABLE IF EXISTS throne_webhook_subscriptions'); } catch { /* ok */ }
}
