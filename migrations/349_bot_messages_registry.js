/**
 * Migration 349 — bot_messages registry.
 *
 * Records every outbound bot message so staff can retroactively edit them from
 * the dashboard (Sapphire-style universal message editor). We don't try to
 * catch EVERY send site — just the ones that correspond to a user-facing
 * TEMPLATE (log embeds, welcome messages, go-live announcements, alert posts).
 * One-off interaction responses are not recorded.
 *
 * Retention: 90 days (log embeds in particular can be high-volume).
 *
 * Idempotent.
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasTable(db, 'bot_messages'))) {
        await db.execute(`
            CREATE TABLE bot_messages (
                id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                guild_id        VARCHAR(20)     NOT NULL,
                channel_id      VARCHAR(20)     NOT NULL,
                message_id      VARCHAR(20)     NOT NULL,
                template_key    VARCHAR(80)     NOT NULL,
                feature         VARCHAR(40)     NULL,
                source_json     LONGTEXT        NULL,
                last_edited_by  VARCHAR(20)     NULL,
                last_edited_at  TIMESTAMP       NULL,
                created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_msg (guild_id, message_id),
                KEY idx_guild_created (guild_id, created_at),
                KEY idx_template (template_key),
                KEY idx_feature (feature)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
        console.log('[migrate 349] created bot_messages');
    }
    await db.execute(`
        INSERT INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes)
        VALUES ('bot_messages', 'created_at', 90, 1, 'Universal message editor registry — recorded outbound bot messages.')
        ON DUPLICATE KEY UPDATE retain_days = VALUES(retain_days), enabled = VALUES(enabled), notes = VALUES(notes)`);
    console.log('[migrate 349] retention row inserted');
}
