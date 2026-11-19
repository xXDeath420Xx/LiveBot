/*
 * announcement_posts: every card posted by /announce or the dashboard's Announce page, so the
 * dashboard can list recent posts to edit or delete. The message itself stays the source of
 * truth for the text (read back via core/announcement-card.js readAnnouncement); this row only
 * remembers WHERE it is. `deleted_at` is set when a post is removed, or found gone (10008).
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS announcement_posts (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            message_id VARCHAR(20) NOT NULL,
            title VARCHAR(256) NULL,
            created_by VARCHAR(20) NULL,
            source ENUM('command','dashboard','script') NOT NULL DEFAULT 'command',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NULL DEFAULT NULL,
            deleted_at TIMESTAMP NULL DEFAULT NULL,
            UNIQUE KEY uq_message (message_id),
            KEY idx_guild (guild_id, deleted_at, created_at)
        )`);
}
