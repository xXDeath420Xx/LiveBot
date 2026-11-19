/*
 * guild_join_requests: every decided "Apply to join" application, with WHO decided it.
 * Discord keeps the approver on the join request (`actioned_by_user`) and nowhere else —
 * approvals never reach the audit log — so this table is the only durable record of it.
 * `posted_at` is the claim for the log post: whichever of the join log or the sync job
 * sets it first is the one that announces the decision (rows backfilled on a guild's first
 * sync are stamped immediately so history is never replayed into the channel).
 *
 * guild_join_request_sync: one row per guild once its history has been backfilled.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS guild_join_requests (
            request_id VARCHAR(20) PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            user_id VARCHAR(20) NOT NULL,
            username VARCHAR(100) NULL,
            status VARCHAR(16) NOT NULL,
            actioned_by_id VARCHAR(20) NULL,
            actioned_by_name VARCHAR(100) NULL,
            rejection_reason TEXT NULL,
            form_responses LONGTEXT NULL,
            applied_at DATETIME(3) NULL,
            reviewed_at DATETIME(3) NULL,
            posted_at TIMESTAMP NULL DEFAULT NULL,
            first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_guild_user (guild_id, user_id),
            KEY idx_guild_reviewed (guild_id, reviewed_at),
            KEY idx_unposted (guild_id, posted_at)
        ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    // Applicants answer in emoji; the server default charset rejects them (and the pool
    // hangs on that error instead of throwing). Converts a table created before this line.
    await db.execute('ALTER TABLE guild_join_requests CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    await db.execute(`
        CREATE TABLE IF NOT EXISTS guild_join_request_sync (
            guild_id VARCHAR(20) PRIMARY KEY,
            backfilled_at TIMESTAMP NULL DEFAULT NULL,
            last_poll_at TIMESTAMP NULL DEFAULT NULL,
            last_error VARCHAR(255) NULL
        ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}
