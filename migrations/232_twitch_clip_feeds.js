/*
 * Twitch clip announcements.
 *
 * `posted_from` is the whole point of this table. A streamer switching this on has
 * usually just finished uploading a batch, and the last thing they want is those
 * appearing in the channel as if they were new. It records the moment the feed was
 * enabled; only clips created strictly AFTER it are ever announced. Nothing before
 * it is announced, not even once, and clearing the seen list won't resurface it.
 *
 * That is deliberately stricter than an age window. A "skip anything older than a
 * day" rule still lets a clip made twenty-three hours ago through, which is exactly
 * the batch the owner is trying to avoid.
 *
 * `twitch_clip_seen` is belt-and-braces on top: the API sorts clips by view count,
 * not by date, so the same clip surfaces on different pages as its views change.
 * Announcing is keyed on the clip id, never on position.
 */

export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS twitch_clip_feeds (
            id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            broadcaster_id VARCHAR(20) NOT NULL,
            username VARCHAR(64) NOT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            posted_from DATETIME NOT NULL,
            creators_filter ENUM('anyone','broadcaster_only') NOT NULL DEFAULT 'anyone',
            min_views INT(11) NOT NULL DEFAULT 0,
            last_checked DATETIME DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_feed (guild_id, channel_id, broadcaster_id),
            KEY idx_enabled (enabled)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS twitch_clip_seen (
            feed_id INT(11) NOT NULL,
            clip_id VARCHAR(120) NOT NULL,
            announced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (feed_id, clip_id),
            KEY idx_announced (announced_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS twitch_clip_seen');
    await db.execute('DROP TABLE IF EXISTS twitch_clip_feeds');
}
