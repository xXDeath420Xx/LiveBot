/**
 * 478 — AI moderation layer (core/ai-moderation.js).
 *
 * Extends what exists instead of adding parallel stores:
 *   phishing_config      ai_mod_* settings next to the existing ai_* second-opinion settings (one row per server)
 *   server_stats         ai_mod_* daily meters next to the ai_* ones
 *   phishing_detections  catches are ordinary detections with source 'ai_moderation' (no new column)
 *   phishing_domains     source 'discord-antiscam' (a third feed for jobs/phishing-list-updater.js)
 *
 * New tables, because nothing held these concepts:
 *   ai_mod_labels        moderator verdicts on catches (confirmed / fine) and misses, per server: the dataset
 *   ai_mod_signatures    confirmed scam text keys, domains, invite servers and embeddings; scope '0' = network
 *   ai_mod_signal_stats  per-signal confirmed / false-positive counts that set each signal's weight
 *   ai_mod_domain_intel  RDAP registration dates (domain age), cached
 *
 * Retention: data_retention_policy rows for each new table (jobs/retention-sweeper.js).
 * Idempotent: every step checks information_schema first.
 */
async function hasColumn(pool, table, column) {
    const [rows] = await pool.query(
        'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
    return rows.length > 0;
}

export async function up(pool) {
    const cfgCols = [
        ['ai_mod_enabled', 'TINYINT(1) NULL DEFAULT NULL COMMENT "NULL = on when phishing detection is on"'],
        ['ai_mod_actions', 'TEXT NULL COMMENT "JSON {category: off|log|delete|timeout|ban}; missing = log"'],
        ['ai_mod_cloud', "ENUM('inherit','allow','deny') NOT NULL DEFAULT 'inherit'"],
        ['ai_mod_share_network', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['ai_mod_use_network', 'TINYINT(1) NOT NULL DEFAULT 1'],
        ['ai_mod_images', 'TINYINT(1) NOT NULL DEFAULT 1'],
        ['ai_mod_daily_cap', 'INT NOT NULL DEFAULT 400'],
        ['ai_mod_min_confidence', 'DECIMAL(4,3) NOT NULL DEFAULT 0.700'],
        ['ai_mod_timeout_minutes', 'INT NOT NULL DEFAULT 60'],
    ];
    for (const [c, def] of cfgCols) {
        if (!(await hasColumn(pool, 'phishing_config', c))) await pool.query(`ALTER TABLE phishing_config ADD COLUMN ${c} ${def}`);
    }
    for (const c of ['ai_mod_local_calls', 'ai_mod_cloud_calls', 'ai_mod_cached', 'ai_mod_failed']) {
        if (!(await hasColumn(pool, 'server_stats', c))) await pool.query(`ALTER TABLE server_stats ADD COLUMN ${c} INT NOT NULL DEFAULT 0`);
    }

    await pool.query(`CREATE TABLE IF NOT EXISTS ai_mod_labels (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        platform VARCHAR(10) NOT NULL DEFAULT 'discord',
        detection_id INT NULL,
        message_id VARCHAR(32) NULL,
        user_id VARCHAR(32) NULL,
        content_key CHAR(64) NULL,
        text_sample VARCHAR(500) NULL,
        detector VARCHAR(50) NOT NULL DEFAULT 'ai_moderation',
        category VARCHAR(32) NULL,
        label ENUM('confirmed','fine','missed') NOT NULL,
        source ENUM('card','dashboard','ban','delete','auto') NOT NULL,
        signals VARCHAR(1000) NULL,
        labelled_by VARCHAR(32) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_detection (guild_id, detection_id),
        KEY idx_guild_time (guild_id, created_at),
        KEY idx_message (guild_id, message_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ai_mod_signatures (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        scope_guild_id VARCHAR(20) NOT NULL COMMENT "'0' = network list (servers that share)",
        kind ENUM('text','domain','invite_guild','embedding') NOT NULL,
        value_hash CHAR(64) NOT NULL,
        value VARCHAR(500) NULL,
        embedding MEDIUMTEXT NULL,
        category VARCHAR(32) NOT NULL DEFAULT 'scam',
        confirmations INT NOT NULL DEFAULT 1,
        false_positives INT NOT NULL DEFAULT 0,
        hits INT NOT NULL DEFAULT 0,
        source_guild_id VARCHAR(20) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_hit_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_sig (scope_guild_id, kind, value_hash),
        KEY idx_kind (kind, scope_guild_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ai_mod_signal_stats (
        guild_id VARCHAR(20) NOT NULL COMMENT "'0' = every server",
        signal_id VARCHAR(48) NOT NULL,
        tp INT NOT NULL DEFAULT 0,
        fp INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, signal_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ai_mod_domain_intel (
        domain VARCHAR(255) NOT NULL PRIMARY KEY,
        registered_at DATETIME NULL,
        status ENUM('ok','not_found','no_rdap','error') NOT NULL,
        checked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    // A third scam-domain feed (Discord-AntiScam/scam-links) for the existing updater.
    const [[src]] = await pool.query(
        "SELECT column_type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'phishing_domains' AND column_name = 'source'");
    if (src && !String(src.column_type).includes('discord-antiscam')) {
        await pool.query("ALTER TABLE phishing_domains MODIFY source ENUM('discord-phishing-links','phishing-database','manual','discord-antiscam') NOT NULL");
    }

    const retention = [
        ['ai_mod_labels', 'created_at', 400, 'AI moderation verdicts (migration 478): a year of weekly precision / recall'],
        ['ai_mod_signatures', 'last_hit_at', 365, 'AI moderation signatures (migration 478): dropped a year after the last hit'],
        ['ai_mod_signal_stats', 'updated_at', 365, 'AI moderation signal weights (migration 478): a year after the last verdict'],
        ['ai_mod_domain_intel', 'checked_at', 60, 'RDAP domain ages (migration 478): re-checked after two months'],
    ];
    for (const [t, col, days, notes] of retention) {
        await pool.query(
            `INSERT INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES (?, ?, ?, 1, ?)
             ON DUPLICATE KEY UPDATE timestamp_column = VALUES(timestamp_column), retain_days = VALUES(retain_days), notes = VALUES(notes)`,
            [t, col, days, notes]);
    }
}

export async function down(pool) {
    for (const t of ['ai_mod_labels', 'ai_mod_signatures', 'ai_mod_signal_stats', 'ai_mod_domain_intel']) await pool.query(`DROP TABLE IF EXISTS ${t}`);
    await pool.query("DELETE FROM data_retention_policy WHERE table_name IN ('ai_mod_labels','ai_mod_signatures','ai_mod_signal_stats','ai_mod_domain_intel')");
}

export default { up, down };
