/**
 * Migration 344 — observe Discord user_flags over time.
 *
 * Discord doesn't publish WHEN they applied flags like SPAMMER or QUARANTINED
 * to a user. The only thing we can do is record every (user_id, flag_bits)
 * combination we observe and the first/last time we observed it. Future
 * questions like "when did Discord first flag this user?" become
 * `SELECT MIN(first_seen_at) FROM user_flag_observations WHERE user_id = ?
 *   AND (flag_bits & (1 << 20)) <> 0`.
 *
 * One row per (user_id, flag_bits) tuple — most users have 1–3 rows
 * (clean, flagged, flagged-with-extras). Compact and easy to query.
 *
 * Idempotent.
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasTable(db, 'user_flag_observations'))) {
        await db.execute(`
            CREATE TABLE user_flag_observations (
                user_id               VARCHAR(20)      NOT NULL,
                flag_bits             BIGINT UNSIGNED  NOT NULL,
                first_seen_at         TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_seen_at          TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
                observation_count     INT UNSIGNED     NOT NULL DEFAULT 1,
                first_source_guild_id VARCHAR(20)      NULL,
                PRIMARY KEY (user_id, flag_bits),
                INDEX idx_flag_bits (flag_bits),
                INDEX idx_last_seen (last_seen_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
        console.log('[migrate 344] created user_flag_observations');
    } else {
        console.log('[migrate 344] user_flag_observations already exists');
    }
    // 180-day retention — long enough to answer "how long has this user been flagged"
    // for a repeat offender, short enough to not accumulate forever.
    await db.execute(`
        INSERT INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes)
        VALUES ('user_flag_observations', 'last_seen_at', 180, 1,
                'Discord user_flags observations — one row per (user, flag_bits) tuple.')
        ON DUPLICATE KEY UPDATE
            timestamp_column = VALUES(timestamp_column),
            retain_days      = VALUES(retain_days),
            enabled          = VALUES(enabled),
            notes            = VALUES(notes)`);
    console.log('[migrate 344] retention policy row inserted');
}
