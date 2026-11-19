/**
 * Wave 373 — Final AI tier: moderator queue, embeddings cache, budget tracking,
 * latency monitoring.
 */
export async function up(pool) {
    // AI chat moderator — queue of flagged messages awaiting human review.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_ai_mod_queue (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            sample_id BIGINT UNSIGNED DEFAULT NULL,
            chatter_user_login VARCHAR(100) DEFAULT NULL,
            chatter_user_id VARCHAR(64) DEFAULT NULL,
            message_text VARCHAR(2000) DEFAULT NULL,
            severity ENUM('low','medium','high','critical') NOT NULL DEFAULT 'medium',
            category VARCHAR(64) DEFAULT NULL,
            reason VARCHAR(500) DEFAULT NULL,
            confidence DECIMAL(3,2) DEFAULT NULL,
            status ENUM('pending','dismissed','actioned') NOT NULL DEFAULT 'pending',
            reviewed_by_discord_id VARCHAR(20) DEFAULT NULL,
            reviewed_at DATETIME DEFAULT NULL,
            action_taken VARCHAR(64) DEFAULT NULL,
            provider VARCHAR(32) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_broadcaster_status (broadcaster_id, status, created_at),
            KEY idx_broadcaster_severity (broadcaster_id, severity, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Embeddings cache — one row per (type, subject_id). Vectors stored as JSON array for
    // simplicity; cosine similarity computed in JS. For small datasets (clips < 10k) this is
    // fine; graduating to pgvector/qdrant is a Tier-later problem.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_ai_embeddings (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            type VARCHAR(32) NOT NULL,
            subject_id VARCHAR(128) NOT NULL,
            text_snippet VARCHAR(500) DEFAULT NULL,
            embedding_json LONGTEXT NOT NULL,
            embedding_dims INT NOT NULL,
            provider VARCHAR(32) DEFAULT NULL,
            model VARCHAR(100) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_type_subject (type, subject_id),
            KEY idx_broadcaster_type (broadcaster_id, type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Daily budget tally per broadcaster, so we can alert when nearing cap without recounting
    // the provider_log every time.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_ai_budget_history (
            broadcaster_id VARCHAR(64) NOT NULL,
            day DATE NOT NULL,
            calls_count INT UNSIGNED NOT NULL DEFAULT 0,
            cap_at_time INT UNSIGNED DEFAULT NULL,
            alerted_at DATETIME DEFAULT NULL,
            PRIMARY KEY (broadcaster_id, day)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const extraAlertCols = [
        ['ai_auto_clip_hype', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['ai_chat_mod_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['ai_prediction_commentary', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['ai_budget_alert_threshold', 'TINYINT(1) NOT NULL DEFAULT 80'],
        ['ai_pii_redaction', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ];
    for (const [col, def] of extraAlertCols) {
        const [ex] = await pool.query(
            `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'twitch_analytics_alerts_config' AND COLUMN_NAME = ?`, [col]);
        if (!ex[0].n) await pool.query(`ALTER TABLE twitch_analytics_alerts_config ADD COLUMN ${col} ${def}`);
    }
}

export async function down(pool) {
    for (const t of ['twitch_ai_mod_queue','twitch_ai_embeddings','twitch_ai_budget_history']) {
        await pool.query(`DROP TABLE IF EXISTS ${t}`);
    }
    for (const col of ['ai_auto_clip_hype','ai_chat_mod_enabled','ai_prediction_commentary','ai_budget_alert_threshold','ai_pii_redaction']) {
        try { await pool.query(`ALTER TABLE twitch_analytics_alerts_config DROP COLUMN ${col}`); } catch {}
    }
}
