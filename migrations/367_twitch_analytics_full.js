/**
 * Wave 367 — Twitch analytics full build-out: VOD catalog, clips catalog, custom rewards,
 * schedule, banned-user sample, subscriber tier breakdown, follower age bucket, backfill
 * history, alert config, and public share tokens.
 *
 * Every table is scoped by broadcaster_id (not guild_id) except role-sync-dependent ones;
 * this keeps the data model consistent with twitch_broadcaster_backfill and lets a single
 * broadcaster re-use analytics across multiple guilds without duplication.
 */
export async function up(pool) {
    // Archive VODs + highlights pulled from /videos. type='archive'|'highlight'|'upload'.
    // Enriches pre-OAuth sessions where title/category are NULL.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_vods_catalog (
            video_id VARCHAR(32) NOT NULL PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            type ENUM('archive','highlight','upload') NOT NULL,
            title VARCHAR(500) DEFAULT NULL,
            description TEXT DEFAULT NULL,
            category_id VARCHAR(64) DEFAULT NULL,
            category_name VARCHAR(255) DEFAULT NULL,
            view_count INT UNSIGNED DEFAULT 0,
            duration_seconds INT UNSIGNED DEFAULT 0,
            language VARCHAR(16) DEFAULT NULL,
            thumbnail_url TEXT DEFAULT NULL,
            url TEXT DEFAULT NULL,
            created_at_twitch DATETIME DEFAULT NULL,
            published_at DATETIME DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_broadcaster_type_time (broadcaster_id, type, created_at_twitch),
            KEY idx_broadcaster_views (broadcaster_id, view_count)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Top clips catalog — separate from twitch_clip_seen (which is autopost-only). This is
    // for the "all-time top clips" section, with view counts the autopost table doesn't track.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_clips_catalog (
            clip_id VARCHAR(128) NOT NULL PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            creator_name VARCHAR(100) DEFAULT NULL,
            creator_id VARCHAR(64) DEFAULT NULL,
            title VARCHAR(500) DEFAULT NULL,
            game_id VARCHAR(64) DEFAULT NULL,
            game_name VARCHAR(255) DEFAULT NULL,
            view_count INT UNSIGNED DEFAULT 0,
            duration_seconds DECIMAL(6,2) DEFAULT 0,
            language VARCHAR(16) DEFAULT NULL,
            thumbnail_url TEXT DEFAULT NULL,
            url TEXT DEFAULT NULL,
            embed_url TEXT DEFAULT NULL,
            vod_id VARCHAR(32) DEFAULT NULL,
            vod_offset INT DEFAULT NULL,
            created_at_twitch DATETIME DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_broadcaster_views (broadcaster_id, view_count),
            KEY idx_broadcaster_created (broadcaster_id, created_at_twitch),
            KEY idx_broadcaster_game (broadcaster_id, game_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Channel point custom rewards catalog — the configured rewards available on-channel.
    // Pairs with twitch_redemption_events for "rewards + their redemption counts".
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_custom_rewards (
            reward_id VARCHAR(64) NOT NULL PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            title VARCHAR(255) DEFAULT NULL,
            prompt TEXT DEFAULT NULL,
            cost INT UNSIGNED DEFAULT 0,
            background_color VARCHAR(16) DEFAULT NULL,
            is_enabled TINYINT(1) DEFAULT 1,
            is_user_input_required TINYINT(1) DEFAULT 0,
            is_sub_only TINYINT(1) DEFAULT 0,
            cooldown_seconds INT DEFAULT 0,
            max_per_stream INT DEFAULT 0,
            max_per_user_per_stream INT DEFAULT 0,
            is_paused TINYINT(1) DEFAULT 0,
            is_in_stock TINYINT(1) DEFAULT 1,
            redemptions_this_stream INT UNSIGNED DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_broadcaster (broadcaster_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Upcoming schedule entries from /schedule. Not to be confused with the existing
    // twitch_schedule_sync_config (which is cross-platform schedule authorship).
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_schedule_segments (
            segment_id VARCHAR(128) NOT NULL PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            title VARCHAR(500) DEFAULT NULL,
            category_id VARCHAR(64) DEFAULT NULL,
            category_name VARCHAR(255) DEFAULT NULL,
            is_recurring TINYINT(1) DEFAULT 0,
            start_time DATETIME DEFAULT NULL,
            end_time DATETIME DEFAULT NULL,
            canceled_until DATETIME DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_broadcaster_time (broadcaster_id, start_time)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Subscriber tier breakdown — rollup from the paginated subscription list. Snapshot in
    // time (overwritten each backfill), not an event stream.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_subscriber_breakdown (
            broadcaster_id VARCHAR(64) NOT NULL PRIMARY KEY,
            total_count INT UNSIGNED DEFAULT 0,
            tier_1000_count INT UNSIGNED DEFAULT 0,
            tier_2000_count INT UNSIGNED DEFAULT 0,
            tier_3000_count INT UNSIGNED DEFAULT 0,
            prime_count INT UNSIGNED DEFAULT 0,
            gift_count INT UNSIGNED DEFAULT 0,
            top_gifters_json LONGTEXT DEFAULT NULL,
            as_of DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Follower age histogram — buckets by account-creation-vs-follow timing. Rolled up from
    // paginated /channels/followers; we don't store individual rows (PII economy).
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_follower_age_histogram (
            broadcaster_id VARCHAR(64) NOT NULL PRIMARY KEY,
            total_sampled INT UNSIGNED DEFAULT 0,
            bucket_lt_1d INT UNSIGNED DEFAULT 0,
            bucket_1d_7d INT UNSIGNED DEFAULT 0,
            bucket_7d_30d INT UNSIGNED DEFAULT 0,
            bucket_30d_90d INT UNSIGNED DEFAULT 0,
            bucket_90d_1y INT UNSIGNED DEFAULT 0,
            bucket_1y_plus INT UNSIGNED DEFAULT 0,
            top_follow_dates_json LONGTEXT DEFAULT NULL,
            as_of DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Banned users snapshot — count only, not the list (privacy + size). Enough for the mod
    // tile to show "N bans active" without storing identities.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_banned_summary (
            broadcaster_id VARCHAR(64) NOT NULL PRIMARY KEY,
            total_banned INT UNSIGNED DEFAULT 0,
            permanent_count INT UNSIGNED DEFAULT 0,
            timed_count INT UNSIGNED DEFAULT 0,
            as_of DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Backfill run history — audit log of past runs. Super-admins can review scope errors
    // and performance regressions over time.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_backfill_history (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            trigger_source ENUM('oauth','manual','cron') NOT NULL DEFAULT 'manual',
            trigger_user_id VARCHAR(20) DEFAULT NULL,
            started_at DATETIME NOT NULL,
            duration_ms INT UNSIGNED DEFAULT 0,
            ok TINYINT(1) NOT NULL DEFAULT 0,
            counts_json LONGTEXT DEFAULT NULL,
            errors_json LONGTEXT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_broadcaster_time (broadcaster_id, started_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Per-guild alert config — which analytics events send a Discord notification. Separate
    // from role-sync config because an owner may want alerts even without role sync.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_analytics_alerts_config (
            guild_id VARCHAR(20) NOT NULL PRIMARY KEY,
            broadcaster_id VARCHAR(64) DEFAULT NULL,
            alert_channel_id VARCHAR(20) DEFAULT NULL,
            notify_hype_train TINYINT(1) NOT NULL DEFAULT 1,
            notify_record_peak TINYINT(1) NOT NULL DEFAULT 1,
            notify_anomaly_critical TINYINT(1) NOT NULL DEFAULT 1,
            notify_first_time_chatter TINYINT(1) NOT NULL DEFAULT 0,
            notify_goal_reached TINYINT(1) NOT NULL DEFAULT 1,
            notify_charity_milestone TINYINT(1) NOT NULL DEFAULT 1,
            notify_raid_in TINYINT(1) NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_broadcaster (broadcaster_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Public share tokens — tokenized read-only URL for broadcasters to show stats to
    // non-admin viewers. Scoped by guild + broadcaster + optional expiry.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_analytics_share_tokens (
            token VARCHAR(64) NOT NULL PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            broadcaster_id VARCHAR(64) NOT NULL,
            created_by_discord_id VARCHAR(20) DEFAULT NULL,
            label VARCHAR(255) DEFAULT NULL,
            expires_at DATETIME DEFAULT NULL,
            revoked_at DATETIME DEFAULT NULL,
            view_count INT UNSIGNED DEFAULT 0,
            last_viewed_at DATETIME DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_guild (guild_id),
            KEY idx_broadcaster (broadcaster_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Extend the broadcaster backfill summary with the new blob columns the expanded sweep
    // writes. Guarded by information_schema check so re-runs don't error.
    const extraCols = [
        ['ad_schedule_json', 'LONGTEXT DEFAULT NULL'],
        ['chat_settings_json', 'LONGTEXT DEFAULT NULL'],
        ['current_schedule_json', 'LONGTEXT DEFAULT NULL'],
        ['top_clips_json', 'LONGTEXT DEFAULT NULL'],
    ];
    for (const [col, def] of extraCols) {
        const [exists] = await pool.query(
            `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'twitch_broadcaster_backfill' AND COLUMN_NAME = ?`,
            [col],
        );
        if (!exists[0].n) {
            await pool.query(`ALTER TABLE twitch_broadcaster_backfill ADD COLUMN ${col} ${def}`);
        }
    }
}

export async function down(pool) {
    const tables = [
        'twitch_vods_catalog',
        'twitch_clips_catalog',
        'twitch_custom_rewards',
        'twitch_schedule_segments',
        'twitch_subscriber_breakdown',
        'twitch_follower_age_histogram',
        'twitch_banned_summary',
        'twitch_backfill_history',
        'twitch_analytics_alerts_config',
        'twitch_analytics_share_tokens',
    ];
    for (const t of tables) await pool.query(`DROP TABLE IF EXISTS ${t}`);
    for (const col of ['ad_schedule_json', 'chat_settings_json', 'current_schedule_json', 'top_clips_json']) {
        try { await pool.query(`ALTER TABLE twitch_broadcaster_backfill DROP COLUMN ${col}`); } catch {}
    }
}
