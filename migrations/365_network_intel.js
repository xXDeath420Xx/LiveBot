/*
 * Network Intel foundation.
 *
 * The old join-gate scored a single arrival on single-guild signals only — account age, name, avatar.
 * None of that catches the modern commission-spammer: real account age, blank profile, zero posts in
 * your server, then straight to DMing your members. The signal is only visible when you watch MANY
 * servers at once. CertiFried is in ~30 right now; this migration turns that reach into a sensor array.
 *
 * Three new surfaces land here:
 *   1. network_member_activity    — one row per user_id across the whole network, updated by passive
 *                                   listeners. "This user joined 7 CertiFried servers, posted in zero,
 *                                   got banned from 2." That picture is impossible without the network.
 *   2. dm_spam_reports             — crowdsourced DM evidence (Wave 366). ToS-safe because the recipient
 *                                   is sharing their own received message.
 *   3. extensions to member_join_history / join_gate_config / join_gate_events / blacklisted_users —
 *                                   frozen join-time snapshot, per-guild toggles, enum additions,
 *                                   network-scoped blacklist entries.
 *
 * This migration is listener-ready but NOT yet listener-wired. Wave 365 continues after this runs by
 * editing core/network-intel.js + the message/audit event handlers.
 */

const hasTable = async (pool, name) => {
  const [[row]] = await pool.query(
    `SELECT 1 AS present FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [name]
  );
  return !!row;
};

const hasColumn = async (pool, table, col) => {
  const [[row]] = await pool.query(
    `SELECT 1 AS present FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, col]
  );
  return !!row;
};

export const up = async (pool) => {
  // -------------------------------------------------------------------------
  // 1. network_member_activity — the cross-guild graph.
  // -------------------------------------------------------------------------
  // One row per Discord user_id we have EVER seen across every CertiFried-covered guild. The
  // deliberate denormalisation (counts live in this row, not derived from member_join_history on
  // every read) is because join-gate reads this row on every single join — it must be a single
  // keyed row read, not a GROUP BY.
  //
  // A spammer who joins 8 guilds, posts in 0, gets banned from 3 will land here with that profile
  // frozen the moment they hit guild #9. The join-gate reads this row and decides on sight.
  if (!(await hasTable(pool, 'network_member_activity'))) {
    await pool.query(`
      CREATE TABLE network_member_activity (
        user_id VARCHAR(20) NOT NULL PRIMARY KEY,
        first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        account_created_at TIMESTAMP NULL,
        guilds_joined INT UNSIGNED NOT NULL DEFAULT 0,
        guilds_currently_in INT UNSIGNED NOT NULL DEFAULT 0,
        guilds_active INT UNSIGNED NOT NULL DEFAULT 0,
        guilds_banned_from INT UNSIGNED NOT NULL DEFAULT 0,
        guilds_kicked_from INT UNSIGNED NOT NULL DEFAULT 0,
        guilds_left_voluntarily INT UNSIGNED NOT NULL DEFAULT 0,
        rapid_leave_count INT UNSIGNED NOT NULL DEFAULT 0,
        total_messages_sent INT UNSIGNED NOT NULL DEFAULT 0,
        last_message_at TIMESTAMP NULL,
        public_flags INT UNSIGNED NULL,
        last_username VARCHAR(100) NULL,
        risk_score SMALLINT NOT NULL DEFAULT 0,
        risk_flags TEXT NULL,
        dm_reports_count INT UNSIGNED NOT NULL DEFAULT 0,
        notes TEXT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_risk (risk_score),
        INDEX idx_last_seen (last_seen_at),
        INDEX idx_lurker (guilds_joined, guilds_active),
        INDEX idx_banned (guilds_banned_from)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  // -------------------------------------------------------------------------
  // 2. dm_spam_reports — crowdsourced DM evidence (Wave 366).
  // -------------------------------------------------------------------------
  // The DM-content blind spot can't be closed by any API; the only ToS-clean path is the recipient
  // voluntarily sharing a message THEY received. One report = flag; N reports from N different
  // guilds within a window = auto-blacklist (Wave 366 logic).
  //
  // join_delta_seconds: how long after the reported user joined the reporting guild did the DM
  // arrive? Tiny values are the strongest "they're here only to DM" signal.
  if (!(await hasTable(pool, 'dm_spam_reports'))) {
    await pool.query(`
      CREATE TABLE dm_spam_reports (
        id BIGINT UNSIGNED NOT NULL PRIMARY KEY AUTO_INCREMENT,
        reported_user_id VARCHAR(20) NOT NULL,
        reporter_user_id VARCHAR(20) NOT NULL,
        guild_id VARCHAR(20) NOT NULL,
        content_hash CHAR(64) NULL,
        content_preview VARCHAR(500) NULL,
        content_full MEDIUMTEXT NULL,
        attachments MEDIUMTEXT NULL,
        verdict ENUM('pending','confirmed','rejected','duplicate') NOT NULL DEFAULT 'pending',
        reviewed_by VARCHAR(20) NULL,
        reviewed_at TIMESTAMP NULL,
        join_delta_seconds INT NULL,
        review_message_id VARCHAR(20) NULL,
        contributed_to_blacklist TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_dedupe (reported_user_id, reporter_user_id, content_hash),
        INDEX idx_reported (reported_user_id, created_at),
        INDEX idx_reporter (reporter_user_id, created_at),
        INDEX idx_guild (guild_id, created_at),
        INDEX idx_verdict (verdict, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  // -------------------------------------------------------------------------
  // 3. member_join_history — freeze join-time snapshot.
  // -------------------------------------------------------------------------
  // The existing table had (id, guild_id, user_id, joined_at, source). None of that survives the
  // user renaming or re-skinning. Capture the primary evidence at the moment of join so we can
  // audit later even if the user becomes a different-looking account.
  const mjhExtensions = [
    ['account_age_hours', 'INT UNSIGNED NULL'],
    ['public_flags_at_join', 'INT UNSIGNED NULL'],
    ['has_custom_avatar', 'TINYINT(1) NULL'],
    ['has_banner', 'TINYINT(1) NULL'],
    ['username_at_join', 'VARCHAR(100) NULL'],
    ['global_name_at_join', 'VARCHAR(100) NULL'],
    ['was_bot_user', 'TINYINT(1) NULL'],
  ];
  for (const [col, def] of mjhExtensions) {
    if (!(await hasColumn(pool, 'member_join_history', col))) {
      await pool.query(`ALTER TABLE member_join_history ADD COLUMN ${col} ${def}`);
    }
  }

  // -------------------------------------------------------------------------
  // 4. join_gate_config — new Network Intel columns.
  // -------------------------------------------------------------------------
  // All default OFF except dm_report_enabled (reports are low-risk — they just land in a queue).
  // Guilds opt into blacklist enforcement and lurker action explicitly.
  const jgcExtensions = [
    ['network_intel_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['network_blacklist_action', `VARCHAR(10) NOT NULL DEFAULT 'ban'`],
    ['network_report_threshold', 'TINYINT UNSIGNED NOT NULL DEFAULT 3'],
    ['network_report_window_hours', 'SMALLINT UNSIGNED NOT NULL DEFAULT 72'],
    ['network_lurker_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['network_lurker_min_guilds', 'TINYINT UNSIGNED NOT NULL DEFAULT 5'],
    ['network_lurker_max_active_pct', 'TINYINT UNSIGNED NOT NULL DEFAULT 10'],
    ['network_lurker_min_account_days', 'SMALLINT UNSIGNED NOT NULL DEFAULT 30'],
    ['network_lurker_action', `VARCHAR(10) NOT NULL DEFAULT 'flag'`],
    ['dm_report_enabled', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['dm_report_channel_id', 'VARCHAR(20) NULL'],
  ];
  for (const [col, def] of jgcExtensions) {
    if (!(await hasColumn(pool, 'join_gate_config', col))) {
      await pool.query(`ALTER TABLE join_gate_config ADD COLUMN ${col} ${def}`);
    }
  }

  // -------------------------------------------------------------------------
  // 5. join_gate_events — extend action enum.
  // -------------------------------------------------------------------------
  // MySQL ENUM extension requires a full ALTER MODIFY of the column. Preserve every existing value
  // verbatim; appending the new network_* values at the end so ordinals stay stable.
  await pool.query(`
    ALTER TABLE join_gate_events MODIFY COLUMN action ENUM(
      'kicked_new','kicked_apply','allowed_approved','allowed_pending','failed',
      'rejoin_banned','rejoin_kicked','rejoin_apply','rejoin_observed',
      'spammer_banned','spammer_kicked','spammer_flagged','spammer_observed',
      'name_banned','name_kicked','name_timeout','name_flagged','name_logged',
      'avatar_banned','avatar_kicked','avatar_timeout','avatar_flagged','avatar_logged','avatar_queued',
      'verify_passed','verify_wrong','verify_failed','verify_expired','verify_kicked',
      'verify_banned','verify_timedout','verify_held',
      'prune_kicked','prune_logged','prune_held',
      'nsfw_banned','nsfw_kicked','nsfw_flagged','nsfw_logged','nsfw_queued','nsfw_overturned',
      'prune_inactive_kicked','prune_inactive_warned','prune_inactive_logged','prune_inactive_held',
      'network_banned','network_kicked','network_flagged','network_logged',
      'network_lurker_banned','network_lurker_kicked','network_lurker_flagged','network_lurker_logged'
    )
  `);

  // -------------------------------------------------------------------------
  // 6. blacklisted_users — add network-scope + source + evidence columns.
  // -------------------------------------------------------------------------
  // Preserves the existing (platform, platform_user_id, guild_id) shape used by the per-guild
  // blacklist. Network-scope entries will be written with scope='network' and (typically) a
  // sentinel guild_id. source='network_intel' marks auto-added entries so a human reviewer can
  // tell them apart from manual admin bans.
  const bluExtensions = [
    ['scope', `VARCHAR(10) NOT NULL DEFAULT 'guild'`],
    ['source', `VARCHAR(20) NOT NULL DEFAULT 'manual'`],
    ['evidence_count', 'INT UNSIGNED NOT NULL DEFAULT 0'],
    ['evidence_json', 'MEDIUMTEXT NULL'],
    ['expires_at', 'TIMESTAMP NULL'],
    ['confirmed_by', 'VARCHAR(20) NULL'],
    ['confirmed_at', 'TIMESTAMP NULL'],
  ];
  for (const [col, def] of bluExtensions) {
    if (!(await hasColumn(pool, 'blacklisted_users', col))) {
      await pool.query(`ALTER TABLE blacklisted_users ADD COLUMN ${col} ${def}`);
    }
  }

  // Index for fast "is this user network-blacklisted?" lookup on join.
  const [idx] = await pool.query(
    `SELECT 1 AS present FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'blacklisted_users'
        AND index_name = 'idx_scope_platform_user' LIMIT 1`
  );
  if (!idx.length) {
    await pool.query(`
      CREATE INDEX idx_scope_platform_user
        ON blacklisted_users (scope, platform, platform_user_id)
    `);
  }
};

export const down = async () => {
  // Non-destructive migration. Rollback is manual (DROP TABLE / ALTER DROP COLUMN) because losing
  // network graph data is irreversible and we never want an accidental down-migration to erase it.
};
