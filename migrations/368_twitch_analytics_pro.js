/**
 * Wave 368 — analytics v3: unban log, chat.notification log, chat-settings timeline,
 * games cache, per-user preferences, weekly digest config, period-over-period deltas,
 * and a milestones table so "best stream" / "first 1k followers" callouts stay cheap.
 */
export async function up(pool) {
    // Unban events — pairs with existing twitch_vip_mod_changes but a separate table because
    // the shape is different (no role, just moderator who unbanned + the target).
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_unban_events (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            target_user_id VARCHAR(64) DEFAULT NULL,
            target_user_login VARCHAR(100) DEFAULT NULL,
            moderator_user_id VARCHAR(64) DEFAULT NULL,
            moderator_user_login VARCHAR(100) DEFAULT NULL,
            occurred_at DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // channel.chat.notification events — first-time-chatter, raid-arrival-banner, bit-badge-tier
    // crossings, sub announcements, etc. notice_type carries the discriminator.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_chat_notifications (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            notice_type VARCHAR(64) NOT NULL,
            chatter_user_id VARCHAR(64) DEFAULT NULL,
            chatter_user_login VARCHAR(100) DEFAULT NULL,
            system_message TEXT DEFAULT NULL,
            message_text TEXT DEFAULT NULL,
            payload_json LONGTEXT DEFAULT NULL,
            occurred_at DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_broadcaster_type_time (broadcaster_id, notice_type, occurred_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Chat settings timeline — logs follower-only / sub-only / slow / emote-only toggles so
    // owners can correlate chat-mode changes with viewer / chatter drops.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_chat_settings_changes (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            follower_mode TINYINT(1) DEFAULT 0,
            follower_mode_duration INT DEFAULT 0,
            subscriber_mode TINYINT(1) DEFAULT 0,
            slow_mode TINYINT(1) DEFAULT 0,
            slow_mode_wait_time INT DEFAULT 0,
            emote_mode TINYINT(1) DEFAULT 0,
            unique_chat_mode TINYINT(1) DEFAULT 0,
            changed_at DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_broadcaster_time (broadcaster_id, changed_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Twitch /games cache — box_art_url for category thumbnails. Lifetime: a day is fine.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_games_cache (
            game_id VARCHAR(64) NOT NULL PRIMARY KEY,
            name VARCHAR(255) DEFAULT NULL,
            box_art_url TEXT DEFAULT NULL,
            igdb_id VARCHAR(32) DEFAULT NULL,
            cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Per-Discord-user analytics prefs — timezone, auto-refresh toggle, collapsed-section memory.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_analytics_user_prefs (
            discord_user_id VARCHAR(20) NOT NULL PRIMARY KEY,
            timezone VARCHAR(64) DEFAULT 'UTC',
            auto_refresh_enabled TINYINT(1) NOT NULL DEFAULT 0,
            collapsed_sections_json LONGTEXT DEFAULT NULL,
            dark_charts TINYINT(1) NOT NULL DEFAULT 1,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Pre-computed milestones — "first 100 followers", "first 1k followers", "biggest peak
    // viewers", "longest stream day". Updated by the digest cron so the UI render stays fast.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_milestones (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            milestone_type VARCHAR(64) NOT NULL,
            milestone_value DECIMAL(18,2) DEFAULT NULL,
            label VARCHAR(255) DEFAULT NULL,
            achieved_at DATETIME DEFAULT NULL,
            evidence_json LONGTEXT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_broadcaster_type (broadcaster_id, milestone_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Extend alert config with digest preferences — opt into weekly summary via channel or DM.
    const extraAlertCols = [
        ['weekly_digest_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['weekly_digest_dm_user_id', 'VARCHAR(20) DEFAULT NULL'],
        ['last_digest_sent_at', 'DATETIME DEFAULT NULL'],
    ];
    for (const [col, def] of extraAlertCols) {
        const [ex] = await pool.query(
            `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'twitch_analytics_alerts_config' AND COLUMN_NAME = ?`, [col]);
        if (!ex[0].n) await pool.query(`ALTER TABLE twitch_analytics_alerts_config ADD COLUMN ${col} ${def}`);
    }

    // Store previous-period numbers alongside each broadcaster so period-over-period chips can
    // render without re-querying the full history every page load.
    const extraBfCols = [
        ['prev_window_hash', 'VARCHAR(32) DEFAULT NULL'],
        ['prev_window_data_json', 'LONGTEXT DEFAULT NULL'],
        ['prev_window_computed_at', 'DATETIME DEFAULT NULL'],
    ];
    for (const [col, def] of extraBfCols) {
        const [ex] = await pool.query(
            `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'twitch_broadcaster_backfill' AND COLUMN_NAME = ?`, [col]);
        if (!ex[0].n) await pool.query(`ALTER TABLE twitch_broadcaster_backfill ADD COLUMN ${col} ${def}`);
    }
}

export async function down(pool) {
    for (const t of ['twitch_unban_events', 'twitch_chat_notifications', 'twitch_chat_settings_changes', 'twitch_games_cache', 'twitch_analytics_user_prefs', 'twitch_milestones']) {
        await pool.query(`DROP TABLE IF EXISTS ${t}`);
    }
    for (const col of ['weekly_digest_enabled', 'weekly_digest_dm_user_id', 'last_digest_sent_at']) {
        try { await pool.query(`ALTER TABLE twitch_analytics_alerts_config DROP COLUMN ${col}`); } catch {}
    }
    for (const col of ['prev_window_hash', 'prev_window_data_json', 'prev_window_computed_at']) {
        try { await pool.query(`ALTER TABLE twitch_broadcaster_backfill DROP COLUMN ${col}`); } catch {}
    }
}
