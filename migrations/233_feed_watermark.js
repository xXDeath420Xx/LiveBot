/*
 * A per-subscription watermark for social feeds.
 *
 * The TikTok checker already refuses to announce anything older than 24 hours, which
 * stops a first enable dumping a back catalogue. It is not the same promise as "post
 * nothing that exists right now": a video posted twenty-three hours ago still goes out.
 *
 * That gap matters to an owner who has just finished uploading. `feed_posted_from`
 * closes it — nothing created at or before that instant is ever announced, however
 * recent. The 24-hour rule stays as a second line of defence.
 *
 * NULL means no watermark, so every existing subscription keeps its current behaviour.
 */

export async function up(db) {
    const [cols] = await db.execute(
        `SELECT COLUMN_NAME FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'subscriptions'
            AND COLUMN_NAME = 'feed_posted_from'`
    );
    if (cols.length) return;
    await db.execute(
        `ALTER TABLE subscriptions
           ADD COLUMN feed_posted_from DATETIME DEFAULT NULL AFTER feed_channel_id`
    );
}

export async function down(db) {
    await db.execute('ALTER TABLE subscriptions DROP COLUMN feed_posted_from');
}
