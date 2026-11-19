/*
 * Caption-based routing for TikTok feeds.
 *
 * One account can post two different things. Hers posts Fortnite clips and her
 * dog, and they belong in different rooms — a Fortnite highlight landing in the
 * dog channel is the thing that makes a feed feel automated rather than curated.
 *
 * The rule is stored as a list of match terms plus the channel to divert to.
 * Terms are matched case-insensitively against the caption, as whole words, so
 * "ellie" doesn't fire on "intelligence".
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS feed_caption_routes (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            subscription_id INT NOT NULL,
            guild_id        VARCHAR(20) NOT NULL,
            match_terms     TEXT NOT NULL,
            channel_id      VARCHAR(20) NOT NULL,
            label           VARCHAR(60) NULL,
            enabled         TINYINT(1) NOT NULL DEFAULT 1,
            created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_sub (subscription_id),
            KEY idx_guild (guild_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}
export async function down(db) { await db.execute('DROP TABLE IF EXISTS feed_caption_routes'); }
