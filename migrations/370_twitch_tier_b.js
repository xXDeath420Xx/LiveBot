/**
 * Wave 370 — Tier B write-scope infrastructure.
 *
 *   - twitch_action_audit_log  : every Helix write we make, with who triggered it and the result
 *   - twitch_role_sync_config  : +tier_b_token, +tier_b_refresh_token, +tier_b_token_expires_at,
 *                                +tier_b_scopes to track the SEPARATE write-scope OAuth grant
 *                                (we keep read + write tokens apart so a scope-revoke on one
 *                                doesn't take out the other).
 */
export async function up(pool) {
    // Audit log for every write action — immutable, per-row, searchable by broadcaster + user.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_action_audit_log (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            broadcaster_id VARCHAR(64) NOT NULL,
            guild_id VARCHAR(20) DEFAULT NULL,
            triggered_by_discord_id VARCHAR(20) DEFAULT NULL,
            triggered_by_discord_username VARCHAR(100) DEFAULT NULL,
            action VARCHAR(64) NOT NULL,
            http_verb VARCHAR(8) NOT NULL,
            helix_path VARCHAR(255) DEFAULT NULL,
            request_body_json LONGTEXT DEFAULT NULL,
            response_status INT DEFAULT NULL,
            response_body_json LONGTEXT DEFAULT NULL,
            ok TINYINT(1) NOT NULL DEFAULT 0,
            error_message VARCHAR(500) DEFAULT NULL,
            duration_ms INT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_broadcaster_time (broadcaster_id, created_at),
            KEY idx_action_time (action, created_at),
            KEY idx_discord_user (triggered_by_discord_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Separate write-scope OAuth. We don't bolt onto broadcaster_token because mixing read +
    // write scopes in one token means a user who wanted read-only ends up granting write too
    // (because Twitch doesn't do incremental consent for an already-connected app). Keeping
    // the write token as its own column lets the user opt into write without re-granting read.
    const extraCols = [
        ['tier_b_token', 'LONGTEXT DEFAULT NULL'],
        ['tier_b_refresh_token', 'LONGTEXT DEFAULT NULL'],
        ['tier_b_token_expires_at', 'DATETIME DEFAULT NULL'],
        ['tier_b_scopes', 'TEXT DEFAULT NULL'],
        ['tier_b_granted_at', 'DATETIME DEFAULT NULL'],
    ];
    for (const [col, def] of extraCols) {
        const [ex] = await pool.query(
            `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'twitch_role_sync_config' AND COLUMN_NAME = ?`, [col]);
        if (!ex[0].n) await pool.query(`ALTER TABLE twitch_role_sync_config ADD COLUMN ${col} ${def}`);
    }
}

export async function down(pool) {
    await pool.query(`DROP TABLE IF EXISTS twitch_action_audit_log`);
    for (const col of ['tier_b_token','tier_b_refresh_token','tier_b_token_expires_at','tier_b_scopes','tier_b_granted_at']) {
        try { await pool.query(`ALTER TABLE twitch_role_sync_config DROP COLUMN ${col}`); } catch {}
    }
}
