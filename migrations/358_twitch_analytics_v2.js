/**
 * Migration 358 — Twitch analytics v2 (growth + engagement).
 *
 * Extends migration 342 (anti-abuse analytics) with per-event tables for the growth and
 * engagement metrics we gain from the 2026-10-18 scope expansion. Each new EventSub topic lands
 * one row per event here; the dashboard analytics tab reads these for its new sections.
 *
 *   twitch_stream_sessions         session rollup, materialized from consecutive is_live=1
 *                                  twitch_stream_snapshots runs. Aggregator inserts/updates
 *                                  one row per detected session (started_at .. ended_at).
 *   twitch_category_history        channel.update log — title / category / CCL changes.
 *                                  Enables "time per category" and "title change frequency".
 *   twitch_hype_train_events       channel.hype_train.{begin,progress,end}.
 *   twitch_goal_events             channel.goal.{begin,progress,end}.
 *   twitch_ad_breaks               channel.ad_break.begin.
 *   twitch_charity_events          channel.charity_campaign.{donate,progress,start,stop}.
 *   twitch_poll_events             channel.poll.{begin,progress,end}.
 *   twitch_prediction_events       channel.prediction.{begin,progress,lock,end}.
 *   twitch_shoutout_events         channel.shoutout.{create,receive}.
 *   twitch_redemption_events       channel.channel_points_custom_reward_redemption.add.
 *   twitch_resub_messages          channel.subscription.message (resub streak + text).
 *   twitch_sub_endings             channel.subscription.end (churn tracking).
 *   twitch_vip_mod_changes         channel.vip.add/remove + channel.moderator.add/remove.
 *   twitch_chatters_snapshots      Helix /chat/chatters polled snapshot (unique chatter list).
 *
 * All additive, idempotent on re-run. Session rollup table also includes derived columns
 * so the dashboard doesn't need to recompute avg length / peak viewers across sessions.
 */
async function hasTable(db, name) {
    const [r] = await db.execute(
        `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [name]);
    return r.length > 0;
}

export async function up(db) {
    // ─── Session rollup (derived from twitch_stream_snapshots) ──────────────
    if (!(await hasTable(db, 'twitch_stream_sessions'))) {
        await db.execute(`CREATE TABLE twitch_stream_sessions (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            broadcaster_login VARCHAR(255) NULL,
            started_at DATETIME NOT NULL,
            ended_at DATETIME NULL,
            duration_minutes INT NULL,
            peak_viewers INT NULL,
            avg_viewers DECIMAL(10,2) NULL,
            total_msgs INT NOT NULL DEFAULT 0,
            unique_chatters INT NOT NULL DEFAULT 0,
            total_follows INT NOT NULL DEFAULT 0,
            total_subs INT NOT NULL DEFAULT 0,
            total_gift_subs INT NOT NULL DEFAULT 0,
            total_bits INT NOT NULL DEFAULT 0,
            total_raids_in INT NOT NULL DEFAULT 0,
            total_mod_actions INT NOT NULL DEFAULT 0,
            total_deleted_msgs INT NOT NULL DEFAULT 0,
            primary_category_id VARCHAR(64) NULL,
            primary_category_name VARCHAR(255) NULL,
            title_at_start VARCHAR(255) NULL,
            title_change_count INT NOT NULL DEFAULT 0,
            category_change_count INT NOT NULL DEFAULT 0,
            UNIQUE KEY uq_broadcaster_start (broadcaster_id, started_at),
            KEY idx_broadcaster_time (broadcaster_id, started_at),
            KEY idx_ended_at (ended_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    // ─── Category / title history (channel.update) ──────────────────────────
    if (!(await hasTable(db, 'twitch_category_history'))) {
        await db.execute(`CREATE TABLE twitch_category_history (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            session_id BIGINT UNSIGNED NULL,
            changed_at DATETIME NOT NULL,
            title VARCHAR(255) NULL,
            category_id VARCHAR(64) NULL,
            category_name VARCHAR(255) NULL,
            language VARCHAR(16) NULL,
            content_classification_labels TEXT NULL,
            KEY idx_broadcaster_time (broadcaster_id, changed_at),
            KEY idx_session (session_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    // ─── Hype train ──────────────────────────────────────────────────────────
    if (!(await hasTable(db, 'twitch_hype_train_events'))) {
        await db.execute(`CREATE TABLE twitch_hype_train_events (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            hype_train_id VARCHAR(64) NOT NULL,
            event_type ENUM('begin', 'progress', 'end') NOT NULL,
            level INT NULL,
            total_bits INT NULL,
            total_subs INT NULL,
            goal INT NULL,
            progress INT NULL,
            top_contributions_json LONGTEXT NULL,
            is_golden TINYINT(1) NOT NULL DEFAULT 0,
            occurred_at DATETIME NOT NULL,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at),
            KEY idx_train (hype_train_id, event_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    // ─── Goals ───────────────────────────────────────────────────────────────
    if (!(await hasTable(db, 'twitch_goal_events'))) {
        await db.execute(`CREATE TABLE twitch_goal_events (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            goal_id VARCHAR(64) NOT NULL,
            event_type ENUM('begin', 'progress', 'end') NOT NULL,
            goal_type VARCHAR(32) NULL,         -- follower | subscription | subscription_count | new_subscription | new_subscription_count
            description VARCHAR(255) NULL,
            current_amount INT NULL,
            target_amount INT NULL,
            is_achieved TINYINT(1) NULL,        -- only populated on 'end'
            occurred_at DATETIME NOT NULL,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at),
            KEY idx_goal (goal_id, event_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    // ─── Ad breaks ───────────────────────────────────────────────────────────
    if (!(await hasTable(db, 'twitch_ad_breaks'))) {
        await db.execute(`CREATE TABLE twitch_ad_breaks (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            duration_seconds INT NULL,
            is_automatic TINYINT(1) NULL,
            requester_user_login VARCHAR(100) NULL,
            started_at DATETIME NOT NULL,
            KEY idx_broadcaster_time (broadcaster_id, started_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    // ─── Charity campaigns ───────────────────────────────────────────────────
    if (!(await hasTable(db, 'twitch_charity_events'))) {
        await db.execute(`CREATE TABLE twitch_charity_events (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            campaign_id VARCHAR(64) NOT NULL,
            event_type ENUM('start', 'donate', 'progress', 'stop') NOT NULL,
            charity_name VARCHAR(255) NULL,
            donor_user_login VARCHAR(100) NULL,        -- only on donate
            donation_amount INT NULL,                   -- minor units (cents)
            donation_currency VARCHAR(16) NULL,
            current_amount INT NULL,
            target_amount INT NULL,
            occurred_at DATETIME NOT NULL,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at),
            KEY idx_campaign (campaign_id, event_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    // ─── Polls ───────────────────────────────────────────────────────────────
    if (!(await hasTable(db, 'twitch_poll_events'))) {
        await db.execute(`CREATE TABLE twitch_poll_events (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            poll_id VARCHAR(64) NOT NULL,
            event_type ENUM('begin', 'progress', 'end') NOT NULL,
            title VARCHAR(255) NULL,
            choices_json LONGTEXT NULL,
            bits_voting_enabled TINYINT(1) NULL,
            bits_per_vote INT NULL,
            channel_points_voting_enabled TINYINT(1) NULL,
            channel_points_per_vote INT NULL,
            status VARCHAR(32) NULL,              -- active / completed / terminated / archived / moderated / invalid
            occurred_at DATETIME NOT NULL,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at),
            KEY idx_poll (poll_id, event_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    // ─── Predictions ─────────────────────────────────────────────────────────
    if (!(await hasTable(db, 'twitch_prediction_events'))) {
        await db.execute(`CREATE TABLE twitch_prediction_events (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            prediction_id VARCHAR(64) NOT NULL,
            event_type ENUM('begin', 'progress', 'lock', 'end') NOT NULL,
            title VARCHAR(255) NULL,
            outcomes_json LONGTEXT NULL,
            winning_outcome_id VARCHAR(64) NULL,
            status VARCHAR(32) NULL,              -- resolved / canceled / locked
            occurred_at DATETIME NOT NULL,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at),
            KEY idx_prediction (prediction_id, event_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    // ─── Shoutouts ───────────────────────────────────────────────────────────
    if (!(await hasTable(db, 'twitch_shoutout_events'))) {
        await db.execute(`CREATE TABLE twitch_shoutout_events (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            direction ENUM('sent', 'received') NOT NULL,
            counterpart_user_id VARCHAR(64) NULL,
            counterpart_user_login VARCHAR(100) NULL,
            moderator_user_login VARCHAR(100) NULL,
            viewer_count INT NULL,
            occurred_at DATETIME NOT NULL,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at),
            KEY idx_direction (broadcaster_id, direction, occurred_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    // ─── Channel points redemptions ──────────────────────────────────────────
    if (!(await hasTable(db, 'twitch_redemption_events'))) {
        await db.execute(`CREATE TABLE twitch_redemption_events (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            reward_id VARCHAR(64) NULL,
            reward_title VARCHAR(255) NULL,
            reward_cost INT NULL,
            redeemer_user_login VARCHAR(100) NULL,
            user_input TEXT NULL,
            status VARCHAR(32) NULL,
            redeemed_at DATETIME NOT NULL,
            KEY idx_broadcaster_time (broadcaster_id, redeemed_at),
            KEY idx_reward (broadcaster_id, reward_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    // ─── Resub messages (channel.subscription.message) ──────────────────────
    if (!(await hasTable(db, 'twitch_resub_messages'))) {
        await db.execute(`CREATE TABLE twitch_resub_messages (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            user_login VARCHAR(100) NULL,
            user_id VARCHAR(64) NULL,
            tier VARCHAR(16) NULL,
            cumulative_months INT NULL,
            streak_months INT NULL,
            duration_months INT NULL,
            message TEXT NULL,
            occurred_at DATETIME NOT NULL,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    // ─── Sub endings (channel.subscription.end — churn) ─────────────────────
    if (!(await hasTable(db, 'twitch_sub_endings'))) {
        await db.execute(`CREATE TABLE twitch_sub_endings (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            user_login VARCHAR(100) NULL,
            user_id VARCHAR(64) NULL,
            tier VARCHAR(16) NULL,
            is_gift TINYINT(1) NULL,
            occurred_at DATETIME NOT NULL,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    // ─── VIP + moderator add/remove ─────────────────────────────────────────
    if (!(await hasTable(db, 'twitch_vip_mod_changes'))) {
        await db.execute(`CREATE TABLE twitch_vip_mod_changes (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            role ENUM('vip', 'moderator') NOT NULL,
            action ENUM('add', 'remove') NOT NULL,
            target_user_login VARCHAR(100) NULL,
            target_user_id VARCHAR(64) NULL,
            occurred_at DATETIME NOT NULL,
            KEY idx_broadcaster_time (broadcaster_id, occurred_at),
            KEY idx_role (broadcaster_id, role, action)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }

    // ─── Chatters polled snapshot (Helix GET /chat/chatters) ────────────────
    // One row per aggregator tick while live; the user list is deduped already by Helix. We
    // store the LIST so the dashboard can show "chat loyalty" (returning chatter %) later.
    if (!(await hasTable(db, 'twitch_chatters_snapshots'))) {
        await db.execute(`CREATE TABLE twitch_chatters_snapshots (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            recorded_at DATETIME NOT NULL,
            total_count INT NOT NULL DEFAULT 0,
            chatter_logins_json LONGTEXT NULL,
            UNIQUE KEY uq_broadcaster_minute (broadcaster_id, recorded_at),
            KEY idx_recorded_at (recorded_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }
}

export async function down(db) {
    for (const t of [
        'twitch_chatters_snapshots', 'twitch_vip_mod_changes', 'twitch_sub_endings',
        'twitch_resub_messages', 'twitch_redemption_events', 'twitch_shoutout_events',
        'twitch_prediction_events', 'twitch_poll_events', 'twitch_charity_events',
        'twitch_ad_breaks', 'twitch_goal_events', 'twitch_hype_train_events',
        'twitch_category_history', 'twitch_stream_sessions',
    ]) {
        try { await db.execute(`DROP TABLE IF EXISTS ${t}`); } catch { /* ok */ }
    }
}
