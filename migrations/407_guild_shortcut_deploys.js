/**
 * Wave 407 — what the main bot last registered as per-server shortcut commands (core/guild-shortcuts.js).
 *
 * The main bot's per-server command lists also hold commands it did not put there (cannabis commands, /jellyfin),
 * so shortcuts are created and deleted one by one instead of replacing the list. This row is the record of which
 * shortcuts are registered and in what form, so a restart does not redo them.
 *
 * commands_json  { shortcutName: hash of the registered JSON }
 */
export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS guild_shortcut_deploys (
            bot_id VARCHAR(32) NOT NULL,
            guild_id VARCHAR(32) NOT NULL,
            commands_json TEXT NOT NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (bot_id, guild_id)
        )`);
}
