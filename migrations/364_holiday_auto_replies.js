/**
 * Migration 364 — Holiday URL auto-replies.
 *
 * When a user posts a /countdown/<slug> link in a channel the guild has opted
 * into, the bot replies with a live-editable embed. These replies are many
 * per (guild, slug) — one per original user post — so they live in their own
 * table rather than crowding `holiday_countdown_pins` (which encodes a
 * singleton "the admin pinned this one message" semantic via its UNIQUE key).
 *
 * `holiday_countdown_auto_channels` is per-guild opt-in config: which
 * channels listen for countdown URLs. An empty `enabled_slugs` means
 * "every holiday"; a JSON array restricts to specific slugs.
 *
 * `holiday_countdown_auto_replies` tracks each posted bot-reply so a daily
 * refresher can edit it in place. Rows self-expire once their holiday is
 * more than 2 days past.
 *
 * Idempotent.
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [table]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasTable(db, 'holiday_countdown_auto_channels'))) {
        await db.execute(`
            CREATE TABLE holiday_countdown_auto_channels (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT,
                guild_id VARCHAR(32) NOT NULL,
                channel_id VARCHAR(32) NOT NULL,
                enabled_slugs JSON NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_guild_channel (guild_id, channel_id),
                KEY idx_guild (guild_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        console.log('[migrate 364] holiday_countdown_auto_channels created');
    }

    if (!(await hasTable(db, 'holiday_countdown_auto_replies'))) {
        await db.execute(`
            CREATE TABLE holiday_countdown_auto_replies (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                guild_id VARCHAR(32) NOT NULL,
                channel_id VARCHAR(32) NOT NULL,
                triggering_message_id VARCHAR(32) NOT NULL,
                reply_message_id VARCHAR(32) NOT NULL,
                slug VARCHAR(48) NOT NULL,
                posted_by_user_id VARCHAR(32) NULL,
                last_updated_at TIMESTAMP NULL,
                last_days_remaining INT NULL,
                failures_since_success INT UNSIGNED NOT NULL DEFAULT 0,
                disabled_reason VARCHAR(120) NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_reply_msg (reply_message_id),
                KEY idx_guild_slug (guild_id, slug),
                KEY idx_disabled (disabled_reason),
                KEY idx_updated (last_updated_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        console.log('[migrate 364] holiday_countdown_auto_replies created');
    }
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS holiday_countdown_auto_replies');
    await db.execute('DROP TABLE IF EXISTS holiday_countdown_auto_channels');
}
