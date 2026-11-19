/**
 * Migration 424 — per-command "delete the reply after N seconds".
 *
 * guild_command_restrictions (core/command-restrictions.js, the Commands page settings drawer)
 *     autodelete_reply_seconds  INT NULL   delete the bot's reply this many seconds after it is sent
 *                                          (NULL or 0 = keep it). Applied to slash commands in
 *                                          events/interactionCreate.js and to chat commands in
 *                                          core/universal-commands.js.
 *
 * The other drawer settings already have columns (migration 181 and later): allowed_roles,
 * denied_roles, allowed_channels, denied_channels, cooldown_seconds, cooldown_scope,
 * denial_message, ephemeral.
 *
 * Idempotent: checks information_schema first.
 */

async function hasColumn(db, table, column) {
    const [rows] = await db.query(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'guild_command_restrictions', 'autodelete_reply_seconds'))) {
        await db.query('ALTER TABLE guild_command_restrictions ADD COLUMN autodelete_reply_seconds INT NULL DEFAULT NULL AFTER ephemeral');
        console.log('[424] guild_command_restrictions.autodelete_reply_seconds added');
    }
}

export async function down(db) {
    if (await hasColumn(db, 'guild_command_restrictions', 'autodelete_reply_seconds')) {
        await db.query('ALTER TABLE guild_command_restrictions DROP COLUMN autodelete_reply_seconds');
    }
}
