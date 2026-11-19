/**
 * Channel access watch — keeps a converted channel converted.
 *
 * After core/channel-access-manager.js folds a per-user whitelist into a role, the next
 * hand-added member overwrite starts the mess over. A watched channel converts each new
 * per-user grant as it appears: the member gets the role, the overwrite goes away.
 *
 * One row per channel — a channel has exactly one role that means "you belong here".
 * Watching is opt-in per channel, so an unconverted channel never has its overwrites
 * rewritten behind an admin's back.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS channel_access_watch (
            guild_id VARCHAR(20) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            role_id VARCHAR(20) NOT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            created_by VARCHAR(20) DEFAULT NULL,
            converted_users INT NOT NULL DEFAULT 0,
            last_converted_at TIMESTAMP NULL DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, channel_id),
            INDEX idx_guild_enabled (guild_id, enabled)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS channel_access_watch');
}
