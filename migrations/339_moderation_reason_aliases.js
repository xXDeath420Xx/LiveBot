/**
 * Migration 339 — moderation reason aliases.
 *
 * Admins register short tokens (e.g. `gh` → "guideline hopper (repeat offender)") that the
 * ban/kick/warn/timeout commands expand before persisting the audit-log reason. Keeps the
 * logged reason meaningful without forcing admins to retype the full justification each time.
 *
 * Scope: per-guild. Aliases are case-insensitive. `uses` is a lightweight usage counter so
 * admins can see which aliases are actually earning their keep.
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
    return rows.length > 0;
}

export async function up(db) {
    if (await hasTable(db, 'moderation_reason_aliases')) return;
    await db.execute(`CREATE TABLE moderation_reason_aliases (
        guild_id VARCHAR(20) NOT NULL,
        alias VARCHAR(32) NOT NULL,
        full_reason VARCHAR(900) NOT NULL,
        created_by VARCHAR(20) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP NULL,
        uses INT NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, alias),
        INDEX idx_guild (guild_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
}

export async function down(db) {
    try { await db.execute('DROP TABLE IF EXISTS moderation_reason_aliases'); } catch { /* ok */ }
}
