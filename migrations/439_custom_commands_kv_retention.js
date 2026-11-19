/**
 * Migration 439 — retention for custom-command storage (register H-648).
 *
 * custom_commands_kv (migration 352) now backs the {db:…} / {sdb:…} tokens (core/custom-command-vars.js,
 * core/custom-command-store.js). Rows are deleted once untouched for 400 days: updated_at is set on every
 * write and refreshed (at most daily) when a value is read, and jobs/retention-sweeper.js deletes by it.
 * The index keeps that nightly DELETE … WHERE updated_at < … off a full scan.
 *
 * Per-member rows are also covered by /privacy export (user_id column) and /privacy delete
 * (core/privacy-tables.js DELETE_PLAN); a departed-guild purge finds the table by its guild_id column.
 *
 * Idempotent: the index is added only when missing, the policy row with INSERT IGNORE.
 */
export async function up(db) {
    const [idx] = await db.query(
        `SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'custom_commands_kv' AND INDEX_NAME = 'idx_updated' LIMIT 1`);
    if (!idx.length) await db.query('ALTER TABLE custom_commands_kv ADD KEY idx_updated (updated_at)');

    await db.query(`
        INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES
            ('custom_commands_kv', 'updated_at', 400, 1, 'Custom-command {db:}/{sdb:} storage. Deleted when untouched (not written or read) for 400 days.')`);
}

export async function down(db) {
    await db.query("DELETE FROM data_retention_policy WHERE table_name = 'custom_commands_kv'");
    const [idx] = await db.query(
        `SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'custom_commands_kv' AND INDEX_NAME = 'idx_updated' LIMIT 1`);
    if (idx.length) await db.query('ALTER TABLE custom_commands_kv DROP KEY idx_updated');
}
