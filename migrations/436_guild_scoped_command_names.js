/**
 * Migration 436 — which per-server (guildScoped) commands each opted-in server gets.
 *
 * guild_scoped_commands only said "on" per server, so scripts/deploy-guild-scoped-commands.js
 * registered every guildScoped command (the cannabis family, /grow, /ban, /modreason,
 * /weekly-recap) in every listed server. The KK row (1260412009644691558) is documented as
 * "/ban, /modreason, /weekly-recap only — cannabis commands excluded", but the next run of the
 * script would have added the cannabis commands there anyway (register H-140).
 *
 *   command_names  JSON array of command names for this server; NULL = all guildScoped commands
 *                  (the old behaviour, kept for the other rows)
 *
 * The KK row gets the list its note describes, only if it has no list yet.
 * Idempotent: the column is added only when missing; the row is updated only while NULL.
 */
const TABLE = 'guild_scoped_commands';
const KK = '1260412009644691558';

async function hasColumn(db, table, column) {
    const [rows] = await db.query(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

export async function up(db) {
    const [t] = await db.query(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [TABLE]);
    if (!t.length) return;
    if (!(await hasColumn(db, TABLE, 'command_names'))) {
        await db.query(`ALTER TABLE ${TABLE} ADD COLUMN command_names TEXT NULL DEFAULT NULL AFTER enabled`);
    }
    await db.query(
        `UPDATE ${TABLE} SET command_names = ? WHERE guild_id = ? AND command_names IS NULL`,
        [JSON.stringify(['ban', 'modreason', 'weekly-recap']), KK]);
}

export async function down(db) {
    if (await hasColumn(db, TABLE, 'command_names')) await db.query(`ALTER TABLE ${TABLE} DROP COLUMN command_names`);
}
