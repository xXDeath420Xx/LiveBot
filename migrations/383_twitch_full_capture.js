/**
 * Wave 383 — capture every Twitch signal the broadcaster's existing grants allow.
 *
 * New EventSub topics: automod.message.hold/update, automod.terms.update,
 * channel.chat.clear(+_user_messages), channel.bits.use, outgoing channel.raid,
 * channel.shared_chat.*, custom reward add/update/remove, redemption.update, automatic reward
 * redemptions. New Helix pulls: stream markers, category rank, channel emotes + badges.
 * twitch_automod_held and twitch_custom_rewards already exist and are reused.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_mod_actions (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            source VARCHAR(16) NOT NULL,
            action VARCHAR(48) NOT NULL,
            moderator_user_id VARCHAR(64) NULL,
            moderator_user_login VARCHAR(64) NULL,
            target_user_id VARCHAR(64) NULL,
            target_user_login VARCHAR(64) NULL,
            duration_seconds INT NULL,
            reason VARCHAR(500) NULL,
            source_broadcaster_id VARCHAR(64) NULL,
            detail_json TEXT NULL,
            occurred_at DATETIME NOT NULL,
            KEY idx_b_time (broadcaster_id, occurred_at),
            KEY idx_b_mod (broadcaster_id, moderator_user_login, occurred_at)
        ) ${TABLE_OPTS}`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_bits_usage (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            user_id VARCHAR(64) NULL,
            user_login VARCHAR(64) NULL,
            bits INT NOT NULL DEFAULT 0,
            usage_type VARCHAR(16) NOT NULL,
            power_up_type VARCHAR(48) NULL,
            message_text VARCHAR(500) NULL,
            occurred_at DATETIME NOT NULL,
            KEY idx_b_time (broadcaster_id, occurred_at)
        ) ${TABLE_OPTS}`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_raid_events (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            direction ENUM('in','out') NOT NULL,
            other_user_id VARCHAR(64) NULL,
            other_user_login VARCHAR(64) NULL,
            viewers INT NOT NULL DEFAULT 0,
            occurred_at DATETIME NOT NULL,
            KEY idx_b_time (broadcaster_id, occurred_at),
            KEY idx_b_other (broadcaster_id, other_user_login)
        ) ${TABLE_OPTS}`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_shared_chat_sessions (
            broadcaster_id VARCHAR(64) NOT NULL,
            session_id VARCHAR(64) NOT NULL,
            host_broadcaster_id VARCHAR(64) NULL,
            participants_json TEXT NULL,
            began_at DATETIME NOT NULL,
            last_update_at DATETIME NULL,
            ended_at DATETIME NULL,
            PRIMARY KEY (broadcaster_id, session_id),
            KEY idx_b_began (broadcaster_id, began_at)
        ) ${TABLE_OPTS}`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_stream_markers (
            broadcaster_id VARCHAR(64) NOT NULL,
            marker_id VARCHAR(64) NOT NULL,
            video_id VARCHAR(64) NULL,
            position_seconds INT NOT NULL DEFAULT 0,
            description VARCHAR(255) NULL,
            url VARCHAR(255) NULL,
            created_at_twitch DATETIME NULL,
            PRIMARY KEY (broadcaster_id, marker_id),
            KEY idx_b_created (broadcaster_id, created_at_twitch)
        ) ${TABLE_OPTS}`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_category_rank_snapshots (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            recorded_at DATETIME NOT NULL,
            game_id VARCHAR(32) NOT NULL,
            game_name VARCHAR(255) NULL,
            rank_pos INT NULL,
            viewers INT NOT NULL DEFAULT 0,
            channels_sampled INT NOT NULL DEFAULT 0,
            viewers_sampled INT NOT NULL DEFAULT 0,
            top_viewers INT NOT NULL DEFAULT 0,
            KEY idx_b_time (broadcaster_id, recorded_at)
        ) ${TABLE_OPTS}`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_channel_assets (
            broadcaster_id VARCHAR(64) NOT NULL,
            kind ENUM('emote','badge') NOT NULL,
            asset_id VARCHAR(96) NOT NULL,
            name VARCHAR(128) NULL,
            tier VARCHAR(16) NULL,
            asset_type VARCHAR(32) NULL,
            image_url VARCHAR(512) NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (broadcaster_id, kind, asset_id)
        ) ${TABLE_OPTS}`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_emote_usage (
            broadcaster_id VARCHAR(64) NOT NULL,
            day DATE NOT NULL,
            emote_id VARCHAR(96) NOT NULL,
            emote_name VARCHAR(128) NULL,
            owner_id VARCHAR(64) NULL,
            uses INT NOT NULL DEFAULT 0,
            PRIMARY KEY (broadcaster_id, day, emote_id),
            KEY idx_b_day (broadcaster_id, day)
        ) ${TABLE_OPTS}`);

    await pool.query(`
        ALTER TABLE twitch_redemption_events
            ADD COLUMN IF NOT EXISTS redemption_id VARCHAR(64) NULL,
            ADD COLUMN IF NOT EXISTS reward_kind ENUM('custom','automatic') NOT NULL DEFAULT 'custom'`);
    await pool.query(`
        ALTER TABLE twitch_redemption_events ADD INDEX IF NOT EXISTS idx_redemption_id (redemption_id)`);

    await pool.query(`
        INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES
            ('twitch_mod_actions', 'occurred_at', 180, 1, 'channel.moderate + chat clears. Per-moderator activity.'),
            ('twitch_bits_usage', 'occurred_at', 365, 1, 'channel.bits.use — cheers + Power-ups.'),
            ('twitch_raid_events', 'occurred_at', 365, 1, 'Raids in and out.'),
            ('twitch_category_rank_snapshots', 'recorded_at', 90, 1, '5-minute category rank while live.'),
            ('twitch_emote_usage', 'day', 180, 1, 'Daily emote use counts from chat fragments.'),
            ('twitch_automod_held', 'occurred_at', 180, 1, 'AutoMod held messages + mod decisions.')`);
}

export async function down(pool) {
    for (const t of ['twitch_mod_actions', 'twitch_bits_usage', 'twitch_raid_events', 'twitch_shared_chat_sessions',
                     'twitch_stream_markers', 'twitch_category_rank_snapshots', 'twitch_channel_assets', 'twitch_emote_usage']) {
        await pool.query(`DROP TABLE IF EXISTS ${t}`);
    }
    await pool.query(`ALTER TABLE twitch_redemption_events DROP INDEX IF EXISTS idx_redemption_id,
                      DROP COLUMN IF EXISTS redemption_id, DROP COLUMN IF EXISTS reward_kind`);
    await pool.query(`DELETE FROM data_retention_policy WHERE table_name IN
        ('twitch_mod_actions','twitch_bits_usage','twitch_raid_events','twitch_category_rank_snapshots','twitch_emote_usage','twitch_automod_held')`);
}
