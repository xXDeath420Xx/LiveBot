/**
 * 479 — per-server "never announce these streamers" list (core/streamer-blocklist.js).
 *
 *   guild_streamer_blocklist
 *     guild_id             the server
 *     platform             twitch | kick | youtube | tiktok | trovo | facebook | rumble
 *     platform_user_id     the account id when known (Twitch always: resolved on add), so a rename keeps the block
 *     username             login, lower case
 *     display_name         as the platform shows it, for the page
 *     streamer_discord_id  the streamer's Discord account when we know it (from streamers.discord_user_id); used by
 *                          the media showcase. Not named discord_user_id on purpose: this is a server's moderation
 *                          decision about that person, not the person's own data, so /privacy export and delete
 *                          (core/privacy-tables.js discovers discord_user_id columns) leave it alone.
 *     reason               optional note for the server's staff
 *     added_by             the admin who added it
 *
 * A configuration table: no retention policy. Idempotent.
 */
export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS guild_streamer_blocklist (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            platform VARCHAR(16) NOT NULL,
            platform_user_id VARCHAR(64) NULL DEFAULT NULL,
            username VARCHAR(64) NOT NULL,
            display_name VARCHAR(100) NULL DEFAULT NULL,
            streamer_discord_id VARCHAR(20) NULL DEFAULT NULL,
            reason VARCHAR(255) NULL DEFAULT NULL,
            added_by VARCHAR(20) NULL DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_guild_platform_user (guild_id, platform, username),
            KEY idx_guild (guild_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(pool) {
    await pool.query('DROP TABLE IF EXISTS guild_streamer_blocklist');
}
