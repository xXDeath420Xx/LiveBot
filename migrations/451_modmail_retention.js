/**
 * Migration 451 — retention for modmail (register H-687). modmail_threads and modmail_messages had no
 * data_retention_policy row, so every conversation was kept forever, while the ticket_transcripts row
 * (migration 449) already said modmail transcripts last "as long as the closed ticket".
 *
 *   modmail_threads  closed_at  365 days  Closed modmail conversations. Their modmail_messages go with them
 *                                         (FOREIGN KEY ... ON DELETE CASCADE). An open thread has no closed_at
 *                                         and is never swept; jobs/retention-sweeper.js also only deletes rows
 *                                         with status = 'closed' for this table (SWEEP_GUARDS).
 *
 * The index keeps the nightly DELETE ... WHERE closed_at < ... off a full scan.
 * Idempotent: the index is added only when missing, the policy row with INSERT IGNORE.
 */
const INDEX = ['modmail_threads', 'idx_modmail_threads_closed', 'closed_at'];

async function hasIndex(db, table, name) {
    const [rows] = await db.query(
        `SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`, [table, name]);
    return rows.length > 0;
}

export async function up(db) {
    const [table, name, column] = INDEX;
    if (!(await hasIndex(db, table, name))) await db.query(`ALTER TABLE \`${table}\` ADD KEY \`${name}\` (\`${column}\`)`);
    await db.query(`
        INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES
            ('modmail_threads', 'closed_at', 365, 1, 'Closed modmail conversations; their messages cascade. Open threads (closed_at NULL, status open) are never swept.')`);
}

export async function down(db) {
    await db.query(`DELETE FROM data_retention_policy WHERE table_name = 'modmail_threads'`);
    const [table, name] = INDEX;
    if (await hasIndex(db, table, name)) await db.query(`ALTER TABLE \`${table}\` DROP KEY \`${name}\``);
}
