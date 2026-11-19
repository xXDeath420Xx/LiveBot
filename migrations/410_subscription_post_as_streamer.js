/**
 * Wave 410 — per-subscription "post as the streamer".
 *
 * NULL = follow the server (guilds.use_webhook_persona), 1 = always post with the
 * streamer's name and avatar, 0 = always post as the bot. Lets one streamer's
 * announcements use their own identity without changing every other streamer in
 * that server. Set from the dashboard's edit-streamer modal.
 */
export async function up(pool) {
    const [cols] = await pool.query("SHOW COLUMNS FROM subscriptions LIKE 'post_as_streamer'");
    if (cols.length) return;
    await pool.query(
        `ALTER TABLE subscriptions
           ADD COLUMN post_as_streamer TINYINT(1) NULL DEFAULT NULL AFTER override_avatar_url`);
}

export async function down(pool) {
    await pool.query('ALTER TABLE subscriptions DROP COLUMN post_as_streamer');
}
