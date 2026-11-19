/**
 * Wave 398 — YouTube upload alerts track the upload ids they have seen (youtube_feeds.seen_video_ids, a JSON
 * array), because the fallback source (the channel's Videos/Shorts tabs) has no upload times. A feed with no
 * list yet records what is there on its next check and posts nothing.
 *
 * Also lifts the 24-hour suspensions caused by YouTube's RSS feed answering 404 for every channel, which the
 * new sources (Data API, then the channel pages) do not depend on.
 */
export async function up(pool) {
    const [cols] = await pool.query('SHOW COLUMNS FROM youtube_feeds');
    if (!cols.some(c => c.Field === 'seen_video_ids')) {
        await pool.query('ALTER TABLE youtube_feeds ADD COLUMN seen_video_ids TEXT NULL AFTER last_video_id');
    }
    await pool.query(`UPDATE youtube_feeds SET suspended_until = NULL, failed_count = 0, last_error = NULL
                      WHERE last_error LIKE '%status code 404%' OR last_error LIKE '%status code 500%'`);
}

export async function down(pool) {
    await pool.query('ALTER TABLE youtube_feeds DROP COLUMN seen_video_ids');
}
