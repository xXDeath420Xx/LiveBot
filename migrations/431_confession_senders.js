/**
 * Migration 431 — who sent each confession, kept privately for 30 days (owner decision 2026-11-18).
 *
 * confession_senders
 *   confession_id  the confessions row (deleted with it)
 *   guild_id       for scoping and the dashboard lookup
 *   user_id        the member who sent it
 *   created_at     when it was sent; data_retention_policy deletes the row after 30 days
 *
 * A table of its own rather than a column on confessions: the retention sweeper
 * (jobs/retention-sweeper.js) deletes whole rows past their window, which here removes only the
 * sender and leaves the confession itself. Members never see it; server admins can reveal it on
 * the dashboard Confessions page, and each reveal is written to audit_logs
 * (dashboard/routes/features/confessions.js). core/privacy-tables.js lists it as a safety table.
 *
 * Confessions sent before this ran have no sender (none was ever recorded).
 * Idempotent: CREATE TABLE IF NOT EXISTS and INSERT IGNORE.
 */
export async function up(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS confession_senders (
            confession_id BIGINT(20) NOT NULL,
            guild_id      VARCHAR(20) NOT NULL,
            user_id       VARCHAR(20) NOT NULL,
            created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (confession_id),
            KEY idx_guild (guild_id),
            KEY idx_created (created_at),
            CONSTRAINT fk_confession_senders_confession FOREIGN KEY (confession_id)
                REFERENCES confessions (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await db.query(`
        INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES
            ('confession_senders', 'created_at', 30, 1, 'Who sent each confession; shown only to server admins, for handling abuse.')`);
}

export async function down(db) {
    await db.query("DELETE FROM data_retention_policy WHERE table_name = 'confession_senders'");
    await db.query('DROP TABLE IF EXISTS confession_senders');
}
