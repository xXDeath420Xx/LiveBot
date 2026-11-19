/**
 * Migration 460 — the channel bot's built-in !source command (AGPL-3.0 section 13 source offer), next to !so.
 *
 * Built-in channel bot commands are rows in tokes_global_command_config with a handler in
 * services/certifried-bot/command-registry.js (services/certifried-bot/commands/source.js). Everyone may use it
 * (not mod-only), 30 s cooldown. Like every built-in it answers once the channel's commands are switched on, and a
 * channel can turn it off on its commands page. No personal data. Idempotent: the row is inserted once and never
 * overwritten (an owner's later edits to it are kept).
 */
export async function up(db) {
    await db.query(`INSERT IGNORE INTO tokes_global_command_config
        (command_key, is_enabled, default_aliases, default_response, category, description, cooldown_default, mod_only, broadcaster_only)
        VALUES ('source', 1, '["sourcecode"]', NULL, 'utility', 'Link to CertiFried''s source code (AGPL-3.0)', 30, 0, 0)`);
}

export async function down(db) {
    await db.query(`DELETE FROM tokes_global_command_config WHERE command_key = 'source'`);
}
