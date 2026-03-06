/**
 * Migration 044: Per-Guild Command Restrictions
 *
 * Allows guilds to disable commands or restrict them to admins.
 * No row for a command = unrestricted (existing guilds unaffected).
 *
 * - allowed = 0 → command disabled for everyone
 * - allowed = 1, admin_only = 1 → moderators only (ManageGuild)
 * - allowed = 1, admin_only = 0 → normal (everyone)
 */
export async function up(pool) {
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS guild_command_restrictions (
            guild_id VARCHAR(20) NOT NULL,
            command_name VARCHAR(100) NOT NULL,
            allowed TINYINT(1) DEFAULT 0,
            admin_only TINYINT(1) DEFAULT 1,
            PRIMARY KEY (guild_id, command_name)
        )
    `);
}

export async function down(pool) {
    await pool.execute('DROP TABLE IF EXISTS guild_command_restrictions');
}
