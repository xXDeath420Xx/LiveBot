/**
 * Migration 353 — standalone DM-disable toggle (Hashbot DM Disabler parity).
 *
 * Independent of raid-lockdown: an "always on" DM-pause for guilds that want
 * harassment prevention regardless of raid state. Discord's incident-actions
 * endpoint caps DM-pause at 24h, so a daily renewer re-sets it. Column lives
 * on guild_settings alongside existing per-guild toggles.
 *
 * Idempotent.
 */
async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'guild_settings', 'dm_disable_enabled'))) {
        await db.execute(`ALTER TABLE guild_settings ADD COLUMN dm_disable_enabled TINYINT(1) NOT NULL DEFAULT 0`);
        console.log('[migrate 353] guild_settings.dm_disable_enabled added');
    }
    if (!(await hasColumn(db, 'guild_settings', 'dm_disable_set_at'))) {
        await db.execute(`ALTER TABLE guild_settings ADD COLUMN dm_disable_set_at TIMESTAMP NULL DEFAULT NULL`);
        console.log('[migrate 353] guild_settings.dm_disable_set_at added');
    }
    if (!(await hasColumn(db, 'guild_settings', 'dm_disable_renewed_at'))) {
        await db.execute(`ALTER TABLE guild_settings ADD COLUMN dm_disable_renewed_at TIMESTAMP NULL DEFAULT NULL`);
        console.log('[migrate 353] guild_settings.dm_disable_renewed_at added');
    }
}
