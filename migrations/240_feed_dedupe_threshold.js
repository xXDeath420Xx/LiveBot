/*
 * How alike two posts must be before the feed holds one back. 0.5 was tuned
 * against real pairs of Epic announcements and games-site headlines about the
 * same event; it is a column so it can be loosened or tightened per guild
 * without a deploy.
 */
export async function up(db) {
    const [cols] = await db.execute("SHOW COLUMNS FROM fortnite_feeds LIKE 'dedupe_threshold'");
    if (!cols.length) {
        await db.execute('ALTER TABLE fortnite_feeds ADD COLUMN dedupe_threshold DECIMAL(3,2) NOT NULL DEFAULT 0.50');
    }
}
export async function down(db) {
    await db.execute('ALTER TABLE fortnite_feeds DROP COLUMN dedupe_threshold');
}
