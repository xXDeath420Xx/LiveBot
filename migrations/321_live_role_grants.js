/*
 * Migration 321: live_role_grants — the live roles the bot handed out (core/live-role-grants.js).
 *
 * A live role given while a streamer was live stayed forever when their subscription vanished
 * mid-stream (Community Support expiry, staff removal, team sync). The sweep takes those back, but
 * only roles recorded here: servers that also hand their live role out by hand keep those.
 *
 * Seeded with
 *   - members live right now, from live_announcements, with the role their subscription resolves to
 *     (subscription role, else team role, else the server's), so a removal mid-stream is caught;
 *   - two leftovers found 2026-10-09 in Vognarfamily (902393911958470717), "On Air" 903147436439138364:
 *     maniacfromdap (Discord's audit log shows the bot adding it 2026-10-01 00:00, Community Support
 *     shoutout ended 2026-09-30) and awesomea1ex444 (added 2026-07-31 20:17, shoutout ended 2026-07-31;
 *     every On Air change in that server is the bot's). The first sweep takes them back.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasTable(db, 'live_role_grants'))) {
        await db.execute(`
            CREATE TABLE live_role_grants (
                guild_id   VARCHAR(20) NOT NULL,
                user_id    VARCHAR(20) NOT NULL,
                role_id    VARCHAR(20) NOT NULL,
                granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (guild_id, user_id, role_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    }

    await db.execute(`
        INSERT IGNORE INTO live_role_grants (guild_id, user_id, role_id)
        SELECT DISTINCT la.guild_id, s.discord_user_id,
               COALESCE(NULLIF(sub.live_role_id, ''), NULLIF(t.live_role_id, ''), NULLIF(g.live_role_id, ''))
          FROM live_announcements la
          JOIN streamers s ON s.streamer_id = la.streamer_id AND s.discord_user_id IS NOT NULL AND s.discord_user_id <> ''
          JOIN subscriptions sub ON sub.streamer_id = la.streamer_id AND sub.guild_id = la.guild_id
          LEFT JOIN twitch_teams t ON t.id = sub.team_subscription_id
          LEFT JOIN guilds g ON g.guild_id = la.guild_id
         WHERE COALESCE(NULLIF(sub.live_role_id, ''), NULLIF(t.live_role_id, ''), NULLIF(g.live_role_id, '')) IS NOT NULL`);

    await db.execute(`
        INSERT IGNORE INTO live_role_grants (guild_id, user_id, role_id) VALUES
            ('902393911958470717', '756879857677500536', '903147436439138364'),
            ('902393911958470717', '607925584412016650', '903147436439138364')`);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS live_role_grants');
}
