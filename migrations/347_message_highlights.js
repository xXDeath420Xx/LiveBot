/**
 * Migration 347 — mod-highlighted messages feed (Dyno "Highlights" parity).
 *
 * Mods pick interesting messages via the "Highlight Message" context-menu command;
 * the bot posts them to a configured highlight channel and records a row. The
 * record is the source of truth for a dashboard feed + deduplication (one message
 * can only be highlighted once).
 *
 * Idempotent.
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}
async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasTable(db, 'message_highlights'))) {
        await db.execute(`
            CREATE TABLE message_highlights (
                id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                guild_id          VARCHAR(20)     NOT NULL,
                source_channel_id VARCHAR(20)     NOT NULL,
                source_message_id VARCHAR(20)     NOT NULL,
                author_id         VARCHAR(20)     NOT NULL,
                author_tag        VARCHAR(100)    NULL,
                content_snapshot  TEXT            NULL,
                attachment_urls   TEXT            NULL,
                pinned_by_user_id VARCHAR(20)     NOT NULL,
                feed_message_id   VARCHAR(20)     NULL,
                feed_channel_id   VARCHAR(20)     NULL,
                created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_source (guild_id, source_message_id),
                KEY idx_guild_created (guild_id, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
        console.log('[migrate 347] created message_highlights');
    } else {
        console.log('[migrate 347] message_highlights already exists — skipping');
    }
    if (!(await hasColumn(db, 'guild_settings', 'highlight_channel_id'))) {
        await db.execute(`ALTER TABLE guild_settings ADD COLUMN highlight_channel_id VARCHAR(20) NULL`);
        console.log('[migrate 347] guild_settings.highlight_channel_id added');
    }
    // 180-day retention
    await db.execute(`
        INSERT INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes)
        VALUES ('message_highlights', 'created_at', 180, 1, 'Mod-pinned highlight feed records.')
        ON DUPLICATE KEY UPDATE
            timestamp_column = VALUES(timestamp_column),
            retain_days      = VALUES(retain_days),
            enabled          = VALUES(enabled),
            notes            = VALUES(notes)`);
    console.log('[migrate 347] retention row inserted');
}
