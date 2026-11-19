/*
 * Guild-scoped command opt-in.
 *
 * Cannabis features (/cannabis, /grow and the cannafriend-* aliases) are not eligible for the
 * Discord App Directory, which requires discoverable apps to be appropriate for 13+ audiences
 * and treats marijuana as a controlled substance. Rather than reword them -- which does not
 * work, because the review reads subject matter rather than vocabulary -- they are held back
 * from the main bot's GLOBAL command payload and registered per-guild to the servers that
 * actually use them.
 *
 * This table is that allowlist. Custom bots are separate applications, are not discoverable,
 * and deploy their own full command set, so they are not represented here.
 */

export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS guild_scoped_commands (
            guild_id VARCHAR(20) NOT NULL PRIMARY KEY,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            note VARCHAR(255) DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS guild_scoped_commands');
}
