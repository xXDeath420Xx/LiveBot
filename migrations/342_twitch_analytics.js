/**
 * Migration 342 — Twitch stream analytics + anomaly detection.
 *
 * Backs the anti-abuse feature set: view-bot detection, follow-bot detection, raid alerts,
 * harassment target detection. New tables:
 *
 *   twitch_stream_snapshots      per-minute per-broadcaster rollup from the EventSub
 *                                ingester + Helix stream poll. One row per (broadcaster_id,
 *                                recorded_at) with viewer_count + chatter_count + msg_rate
 *                                + follow_count + sub_count + bit_count + mod_action_count.
 *   twitch_anomaly_alerts        detector output: type (view_bot / follow_bot / raid_in /
 *                                harassment / mod_action_spike), severity, score, evidence_json.
 *   twitch_oauth_scopes_granted  which scopes each connected user has approved so we can
 *                                prompt for re-OAuth when we add new ones without silently
 *                                breaking users who connected before the scope expansion.
 *   twitch_live_chat_counters    short-lived in-flight counters per broadcaster per minute
 *                                bucket; the aggregator flushes these into _snapshots and
 *                                resets. Separate from _snapshots so a bot restart doesn't
 *                                lose this-minute's events (the aggregator reads + archives
 *                                in a single transaction).
 *   twitch_mention_targets       per-user mention frequency within a short window for
 *                                harassment-targeting detection.
 *
 * All additive, nullable where possible, idempotent on re-run.
 */
async function hasTable(db, name) {
    const [r] = await db.execute(
        `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [name]);
    return r.length > 0;
}
async function hasColumn(db, table, col) {
    const [r] = await db.execute(
        `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, col]);
    return r.length > 0;
}

export async function up(db) {
    if (!(await hasTable(db, 'twitch_stream_snapshots'))) {
        await db.execute(`CREATE TABLE twitch_stream_snapshots (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            broadcaster_login VARCHAR(255) NULL,
            recorded_at DATETIME NOT NULL,
            viewer_count INT NULL,
            chatter_count INT NOT NULL DEFAULT 0,
            msg_count INT NOT NULL DEFAULT 0,
            follow_count INT NOT NULL DEFAULT 0,
            sub_count INT NOT NULL DEFAULT 0,
            gift_sub_count INT NOT NULL DEFAULT 0,
            bit_count INT NOT NULL DEFAULT 0,
            raid_in_count INT NOT NULL DEFAULT 0,
            mod_action_count INT NOT NULL DEFAULT 0,
            deleted_msg_count INT NOT NULL DEFAULT 0,
            is_live TINYINT(1) NOT NULL DEFAULT 0,
            UNIQUE KEY uq_broadcaster_minute (broadcaster_id, recorded_at),
            KEY idx_recorded_at (recorded_at),
            KEY idx_broadcaster_time (broadcaster_id, recorded_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    if (!(await hasTable(db, 'twitch_anomaly_alerts'))) {
        await db.execute(`CREATE TABLE twitch_anomaly_alerts (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            alert_type ENUM('view_bot', 'follow_bot', 'raid_in', 'harassment', 'mod_action_spike',
                            'ban_spike', 'sub_surge', 'bit_surge', 'other') NOT NULL,
            severity ENUM('info', 'warning', 'critical') NOT NULL DEFAULT 'warning',
            score DECIMAL(10,3) NULL,
            evidence_json LONGTEXT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            posted_to_discord TINYINT(1) NOT NULL DEFAULT 0,
            posted_at TIMESTAMP NULL,
            KEY idx_broadcaster_time (broadcaster_id, created_at),
            KEY idx_pending (posted_to_discord, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    if (!(await hasColumn(db, 'twitch_oauth_accounts', 'scopes_granted'))) {
        await db.execute(
            `ALTER TABLE twitch_oauth_accounts ADD COLUMN scopes_granted TEXT NULL AFTER refresh_token`);
    }
    if (!(await hasColumn(db, 'twitch_oauth_accounts', 'scopes_last_prompted_at'))) {
        await db.execute(
            `ALTER TABLE twitch_oauth_accounts ADD COLUMN scopes_last_prompted_at DATETIME NULL`);
    }

    if (!(await hasTable(db, 'twitch_mention_targets'))) {
        await db.execute(`CREATE TABLE twitch_mention_targets (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            target_login VARCHAR(100) NOT NULL,
            mention_count INT NOT NULL DEFAULT 0,
            unique_senders INT NOT NULL DEFAULT 0,
            window_start DATETIME NOT NULL,
            UNIQUE KEY uq_target_window (broadcaster_id, target_login, window_start),
            KEY idx_window (window_start)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    if (!(await hasTable(db, 'twitch_analytics_config'))) {
        await db.execute(`CREATE TABLE twitch_analytics_config (
            broadcaster_id VARCHAR(64) PRIMARY KEY,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            alert_discord_guild_id VARCHAR(20) NULL,
            alert_discord_channel_id VARCHAR(20) NULL,
            viewbot_threshold DECIMAL(5,3) NOT NULL DEFAULT 0.020,   -- chat msgs per viewer per min; below triggers
            viewbot_min_viewers INT NOT NULL DEFAULT 50,              -- don't flag tiny streams
            followbot_threshold INT NOT NULL DEFAULT 10,              -- new follows / min
            mod_spike_threshold INT NOT NULL DEFAULT 5,               -- mod actions / min
            harassment_threshold INT NOT NULL DEFAULT 5,              -- mentions of same target / 5min from distinct senders
            raid_alert TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }
}

export async function down(db) {
    try { await db.execute(`DROP TABLE IF EXISTS twitch_analytics_config`); } catch { /* ok */ }
    try { await db.execute(`DROP TABLE IF EXISTS twitch_mention_targets`); } catch { /* ok */ }
    try { await db.execute(`DROP TABLE IF EXISTS twitch_anomaly_alerts`); } catch { /* ok */ }
    try { await db.execute(`DROP TABLE IF EXISTS twitch_stream_snapshots`); } catch { /* ok */ }
    try { await db.execute(`ALTER TABLE twitch_oauth_accounts DROP COLUMN scopes_last_prompted_at`); } catch { /* ok */ }
    try { await db.execute(`ALTER TABLE twitch_oauth_accounts DROP COLUMN scopes_granted`); } catch { /* ok */ }
}
