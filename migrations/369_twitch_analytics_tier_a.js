/**
 * Wave 369 — Tier A analytics expansion. Twelve new tables backing eleven new OAuth scopes
 * (all read-only) + two zero-scope features (chatter identities, chat message sampling).
 *
 * Design decisions:
 *   - Chatter identities stored per-minute poll with (broadcaster_id, user_id, first_seen_at,
 *     last_seen_at, sightings) — compact over time, no per-sighting row (would be millions).
 *   - Chat message samples bounded via a per-broadcaster ring buffer at insert time (handler
 *     deletes oldest when count > 10_000). No TTL cron needed; the write path owns the bound.
 *   - AutoMod held / user-message-hold are separate tables because the schemas differ.
 *   - All new tables use utf8mb4_unicode_ci so joins with existing twitch_role_sync_config
 *     (which uses that collation) don't need the COLLATE workaround.
 */
export async function up(pool) {
    // Chatter identity register — one row per (broadcaster, chatter), aggregates sightings.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_chatter_sightings (
            broadcaster_id VARCHAR(64) NOT NULL,
            chatter_user_id VARCHAR(64) NOT NULL,
            chatter_user_login VARCHAR(100) DEFAULT NULL,
            chatter_display_name VARCHAR(100) DEFAULT NULL,
            first_seen_at DATETIME NOT NULL,
            last_seen_at DATETIME NOT NULL,
            sightings INT UNSIGNED NOT NULL DEFAULT 1,
            sessions_seen INT UNSIGNED NOT NULL DEFAULT 1,
            is_vip TINYINT(1) NOT NULL DEFAULT 0,
            is_mod TINYINT(1) NOT NULL DEFAULT 0,
            is_sub TINYINT(1) NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (broadcaster_id, chatter_user_id),
            KEY idx_broadcaster_last (broadcaster_id, last_seen_at),
            KEY idx_broadcaster_sightings (broadcaster_id, sightings)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Chat message sample ring — bounded at 10K per broadcaster by the write path (handler).
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_chat_message_samples (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            chatter_user_id VARCHAR(64) DEFAULT NULL,
            chatter_user_login VARCHAR(100) DEFAULT NULL,
            message_text VARCHAR(500) DEFAULT NULL,
            message_length INT UNSIGNED DEFAULT 0,
            has_link TINYINT(1) DEFAULT 0,
            is_caps TINYINT(1) DEFAULT 0,
            emote_count INT UNSIGNED DEFAULT 0,
            occurred_at DATETIME NOT NULL,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at),
            KEY idx_broadcaster_chatter (broadcaster_id, chatter_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Suspicious users events — channel.suspicious_user.{message,update}
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_suspicious_users (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            event_type ENUM('message','update') NOT NULL,
            user_id VARCHAR(64) DEFAULT NULL,
            user_login VARCHAR(100) DEFAULT NULL,
            low_trust_status VARCHAR(32) DEFAULT NULL,
            types_json LONGTEXT DEFAULT NULL,
            ban_evasion_evaluation VARCHAR(32) DEFAULT NULL,
            shared_ban_channel_ids_json LONGTEXT DEFAULT NULL,
            message_text VARCHAR(2000) DEFAULT NULL,
            occurred_at DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at),
            KEY idx_broadcaster_user (broadcaster_id, user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Warning events — channel.warning.send + channel.warning.acknowledge
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_warnings (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            event_type ENUM('send','acknowledge') NOT NULL,
            user_id VARCHAR(64) DEFAULT NULL,
            user_login VARCHAR(100) DEFAULT NULL,
            moderator_user_id VARCHAR(64) DEFAULT NULL,
            moderator_user_login VARCHAR(100) DEFAULT NULL,
            reason VARCHAR(500) DEFAULT NULL,
            chat_rules_cited_json LONGTEXT DEFAULT NULL,
            occurred_at DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at),
            KEY idx_broadcaster_user (broadcaster_id, user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Unban request events — channel.unban_request.{create,resolve}
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_unban_requests (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            request_id VARCHAR(64) NOT NULL,
            event_type ENUM('create','resolve') NOT NULL,
            user_id VARCHAR(64) DEFAULT NULL,
            user_login VARCHAR(100) DEFAULT NULL,
            text VARCHAR(2000) DEFAULT NULL,
            status VARCHAR(32) DEFAULT NULL,
            moderator_user_id VARCHAR(64) DEFAULT NULL,
            moderator_user_login VARCHAR(100) DEFAULT NULL,
            resolution_text VARCHAR(2000) DEFAULT NULL,
            occurred_at DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at),
            KEY idx_broadcaster_request (broadcaster_id, request_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Shield Mode events — channel.shield_mode.{begin,end}
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_shield_mode_events (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            event_type ENUM('begin','end') NOT NULL,
            moderator_user_id VARCHAR(64) DEFAULT NULL,
            moderator_user_login VARCHAR(100) DEFAULT NULL,
            occurred_at DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Guest star sessions — channel.guest_star_session.{begin,end}
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_guest_star_sessions (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            session_id VARCHAR(64) NOT NULL,
            event_type ENUM('begin','end') NOT NULL,
            moderator_user_id VARCHAR(64) DEFAULT NULL,
            guests_json LONGTEXT DEFAULT NULL,
            occurred_at DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at),
            KEY idx_broadcaster_session (broadcaster_id, session_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // AutoMod held messages — automod.message.hold / automod.message.update
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_automod_held (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            message_id VARCHAR(128) NOT NULL,
            event_type ENUM('hold','update') NOT NULL,
            user_id VARCHAR(64) DEFAULT NULL,
            user_login VARCHAR(100) DEFAULT NULL,
            message_text VARCHAR(2000) DEFAULT NULL,
            category VARCHAR(64) DEFAULT NULL,
            level INT DEFAULT NULL,
            status VARCHAR(32) DEFAULT NULL,
            moderator_user_id VARCHAR(64) DEFAULT NULL,
            moderator_user_login VARCHAR(100) DEFAULT NULL,
            occurred_at DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at),
            KEY idx_broadcaster_message (broadcaster_id, message_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Blocked terms snapshot — populated from /moderation/blocked_terms backfill.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_blocked_terms (
            id VARCHAR(64) NOT NULL PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            term_text VARCHAR(500) DEFAULT NULL,
            created_at_twitch DATETIME DEFAULT NULL,
            expires_at DATETIME DEFAULT NULL,
            updated_at_twitch DATETIME DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_broadcaster (broadcaster_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // AutoMod settings snapshot — one row per broadcaster, overwritten each backfill.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_automod_settings (
            broadcaster_id VARCHAR(64) NOT NULL PRIMARY KEY,
            overall_level INT DEFAULT NULL,
            disability INT DEFAULT NULL,
            aggression INT DEFAULT NULL,
            sexuality_sex_or_gender INT DEFAULT NULL,
            misogyny INT DEFAULT NULL,
            bullying INT DEFAULT NULL,
            swearing INT DEFAULT NULL,
            race_ethnicity_or_religion INT DEFAULT NULL,
            sex_based_terms INT DEFAULT NULL,
            as_of DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Channel editors — from /channels/editors
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_channel_editors (
            broadcaster_id VARCHAR(64) NOT NULL,
            user_id VARCHAR(64) NOT NULL,
            user_name VARCHAR(100) DEFAULT NULL,
            created_at_twitch DATETIME DEFAULT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (broadcaster_id, user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // User's followed channels — from /channels/followed (needs user:read:follows)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_user_follows (
            follower_id VARCHAR(64) NOT NULL,
            broadcaster_id VARCHAR(64) NOT NULL,
            broadcaster_login VARCHAR(100) DEFAULT NULL,
            broadcaster_name VARCHAR(100) DEFAULT NULL,
            followed_at DATETIME DEFAULT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (follower_id, broadcaster_id),
            KEY idx_follower (follower_id, followed_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Chatter watch list — per-broadcaster list of chatters to alert on when they enter chat.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_chatter_watch (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            chatter_user_login VARCHAR(100) NOT NULL,
            label VARCHAR(255) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_broadcaster_user (broadcaster_id, chatter_user_login)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Per-guild opt-in for chat sampling + chatter identity persistence.
    const extraCfgCols = [
        ['chat_sampling_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['chatter_identities_enabled', 'TINYINT(1) NOT NULL DEFAULT 1'], // on by default — low PII cost
        ['notify_chatter_watch', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ];
    for (const [col, def] of extraCfgCols) {
        const [ex] = await pool.query(
            `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'twitch_analytics_alerts_config' AND COLUMN_NAME = ?`, [col]);
        if (!ex[0].n) await pool.query(`ALTER TABLE twitch_analytics_alerts_config ADD COLUMN ${col} ${def}`);
    }

    // Backfill summary gets one more blob column for the Shield Mode status snapshot.
    const [exSm] = await pool.query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'twitch_broadcaster_backfill' AND COLUMN_NAME = 'shield_mode_json'`);
    if (!exSm[0].n) await pool.query(`ALTER TABLE twitch_broadcaster_backfill ADD COLUMN shield_mode_json LONGTEXT DEFAULT NULL`);
}

export async function down(pool) {
    for (const t of [
        'twitch_chatter_sightings','twitch_chat_message_samples','twitch_suspicious_users',
        'twitch_warnings','twitch_unban_requests','twitch_shield_mode_events',
        'twitch_guest_star_sessions','twitch_automod_held','twitch_blocked_terms',
        'twitch_automod_settings','twitch_channel_editors','twitch_user_follows','twitch_chatter_watch',
    ]) {
        await pool.query(`DROP TABLE IF EXISTS ${t}`);
    }
    for (const col of ['chat_sampling_enabled','chatter_identities_enabled','notify_chatter_watch']) {
        try { await pool.query(`ALTER TABLE twitch_analytics_alerts_config DROP COLUMN ${col}`); } catch {}
    }
}
