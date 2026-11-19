/**
 * Wave 372 — AI integration tables.
 *
 *   - twitch_ai_session_recaps : one AI-written narrative per stream_session, cached forever
 *   - twitch_ai_message_sentiments : per-sample sentiment score, batched by cron
 *   - twitch_ai_insights : general-purpose AI output cache (clip titles, stream titles,
 *                          harassment reports, raid verifications) keyed by (type, subject_id)
 *   - twitch_ai_provider_log : every AI call logged — model, tokens, latency, provider
 *   - alerts_config columns : ai_enabled, ai_provider_preference, ai_ollama_url, ai_ollama_model,
 *                             ai_auto_recap, ai_auto_sentiment, ai_daily_call_cap
 */
export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_ai_session_recaps (
            session_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            provider VARCHAR(32) DEFAULT NULL,
            model VARCHAR(100) DEFAULT NULL,
            recap_text LONGTEXT DEFAULT NULL,
            headline VARCHAR(255) DEFAULT NULL,
            bullets_json LONGTEXT DEFAULT NULL,
            mood VARCHAR(32) DEFAULT NULL,
            prompt_tokens INT DEFAULT NULL,
            completion_tokens INT DEFAULT NULL,
            duration_ms INT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_broadcaster_time (broadcaster_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_ai_message_sentiments (
            sample_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            sentiment TINYINT NOT NULL,
            confidence DECIMAL(3,2) DEFAULT NULL,
            provider VARCHAR(32) DEFAULT NULL,
            scored_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_broadcaster_time (broadcaster_id, scored_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Generic AI insight cache. `type` is the kind (clip_titles, stream_title, harassment,
    // raid_verify, chatter_persona, automod_tune). `subject_id` is whatever natural key the
    // type uses (clip_id, broadcaster_id, raid_event_id, etc.).
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_ai_insights (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            type VARCHAR(32) NOT NULL,
            subject_id VARCHAR(128) DEFAULT NULL,
            payload_json LONGTEXT DEFAULT NULL,
            provider VARCHAR(32) DEFAULT NULL,
            model VARCHAR(100) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME DEFAULT NULL,
            KEY idx_broadcaster_type (broadcaster_id, type, created_at),
            KEY idx_subject (type, subject_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Call log — super-admin visibility into provider usage, costs, failures.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_ai_provider_log (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) DEFAULT NULL,
            guild_id VARCHAR(20) DEFAULT NULL,
            provider VARCHAR(32) NOT NULL,
            model VARCHAR(100) DEFAULT NULL,
            feature VARCHAR(64) DEFAULT NULL,
            prompt_chars INT DEFAULT NULL,
            response_chars INT DEFAULT NULL,
            duration_ms INT DEFAULT NULL,
            ok TINYINT(1) NOT NULL DEFAULT 0,
            error_message VARCHAR(500) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_feature_time (feature, created_at),
            KEY idx_provider_time (provider, created_at),
            KEY idx_guild_time (guild_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const extraAlertCols = [
        ['ai_enabled', 'TINYINT(1) NOT NULL DEFAULT 1'],
        ['ai_provider_preference', `ENUM('gemini','ollama','fallback_chain') NOT NULL DEFAULT 'fallback_chain'`],
        ['ai_ollama_url', 'VARCHAR(500) DEFAULT NULL'],
        ['ai_ollama_model', 'VARCHAR(100) DEFAULT NULL'],
        ['ai_auto_recap', 'TINYINT(1) NOT NULL DEFAULT 1'],
        ['ai_auto_sentiment', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['ai_daily_call_cap', 'INT NOT NULL DEFAULT 200'],
    ];
    for (const [col, def] of extraAlertCols) {
        const [ex] = await pool.query(
            `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'twitch_analytics_alerts_config' AND COLUMN_NAME = ?`, [col]);
        if (!ex[0].n) await pool.query(`ALTER TABLE twitch_analytics_alerts_config ADD COLUMN ${col} ${def}`);
    }
}

export async function down(pool) {
    for (const t of ['twitch_ai_session_recaps','twitch_ai_message_sentiments','twitch_ai_insights','twitch_ai_provider_log']) {
        await pool.query(`DROP TABLE IF EXISTS ${t}`);
    }
    for (const col of ['ai_enabled','ai_provider_preference','ai_ollama_url','ai_ollama_model','ai_auto_recap','ai_auto_sentiment','ai_daily_call_cap']) {
        try { await pool.query(`ALTER TABLE twitch_analytics_alerts_config DROP COLUMN ${col}`); } catch {}
    }
}
